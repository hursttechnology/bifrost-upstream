"""Serve the real client/nginx.conf with a real nginx binary.

Only environment details are substituted: a loopback listen port, a temporary
document root and log, a loopback upstream that answers through the real embed
router (with the synthetic fixtures of test_embed_app_redirect), and no gzip
(the test binary is built without it). Set BIFROST_TEST_NGINX to the binary.

Log lines and the signed fixture are never printed: every log assertion is
reduced to a boolean or a count before it is asserted.
"""

from __future__ import annotations

import http.client
import os
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from tests.unit.routers.test_embed_app_redirect import _app_row, _client, _halo_hmac

NGINX = os.environ.get("BIFROST_TEST_NGINX", "")
pytestmark = pytest.mark.skipif(
    not (NGINX and os.path.isfile(NGINX) and os.access(NGINX, os.X_OK)),
    reason="BIFROST_TEST_NGINX is unset or not an executable nginx binary",
)

CONF = Path(__file__).resolve().parents[3] / "client/nginx.conf"
DOCUMENT = b"<!doctype html><title>offline document marker</title>"
ASSET = b"console.log('asset marker');"
HEIMDALL_POLICY = "frame-ancestors https://support.hurst.technology"
SIGNED_HMAC = _halo_hmac("7")
SIGNED_QUERY = f"agent_id=7&hmac={SIGNED_HMAC}"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _Proxy:
    def __init__(self, port: int, access_log: Path):
        self.port = port
        self.access_log = access_log

    def get(self, target: str, headers: dict[str, str] | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", target, headers=headers or {})
            response = conn.getresponse()
            # response.headers looks names up case-insensitively.
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    def log_line(self, agent: str) -> str:
        """The access-log line for one request, found by its User-Agent."""
        marker = f'"{agent}"'
        for _ in range(50):
            lines = [line for line in self.access_log.read_text().splitlines() if marker in line]
            if lines:
                assert len(lines) == 1, f"{len(lines)} log lines for {agent}"
                return lines[0]
            time.sleep(0.02)
        raise AssertionError(f"no access-log line for {agent}")


@pytest.fixture(scope="module")
def proxy(tmp_path_factory):
    base = tmp_path_factory.mktemp("nginx")
    (base / "html/assets").mkdir(parents=True)
    (base / "html/index.html").write_bytes(DOCUMENT)
    (base / "html/assets/app.js").write_bytes(ASSET)
    access_log = base / "access.log"

    patch = pytest.MonkeyPatch()
    client = _client(patch, _app_row("heimdall"))
    lock = threading.Lock()

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            # The base keeps a raw path such as //embed/... a path, not a host.
            with lock:
                response = client.get(f"http://testserver{self.path}", follow_redirects=False)
            self.send_response(response.status_code)
            for key, value in response.headers.items():
                if key.lower() not in {"content-length", "connection", "transfer-encoding"}:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(response.content)))
            self.end_headers()
            self.wfile.write(response.content)

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()

    port = _free_port()
    conf = CONF.read_text()
    for old, new in (
        ("listen 80;", f"listen 127.0.0.1:{port};"),
        ("root /usr/share/nginx/html;", f"root {base / 'html'};"),
        ("http://api:8000", f"http://127.0.0.1:{upstream.server_port}"),
        ("/var/log/nginx/access.log", str(access_log)),
    ):
        assert old in conf, old
        conf = conf.replace(old, new)
    conf = "\n".join(
        line for line in conf.splitlines() if not line.strip().startswith(("gzip ", "gzip_"))
    )
    config = base / "nginx.conf"
    config.write_text(
        f"daemon off;\npid {base / 'nginx.pid'};\nerror_log {base / 'error.log'};\n"
        f"events {{}}\nhttp {{\n{conf}\n}}\n"
    )
    command = [NGINX, "-p", f"{base}/", "-c", str(config)]
    syntax = subprocess.run([*command, "-t"], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr

    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(250):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.02)
        else:
            raise AssertionError("nginx did not start listening")
        yield _Proxy(port, access_log)
    finally:
        process.terminate()
        process.wait(timeout=10)
        upstream.shutdown()
        upstream.server_close()
        patch.undo()


@pytest.mark.parametrize("path", [
    "/apps/heimdall", "/apps/heimdall/", "/apps/heimdall/tab", "/apps/heimdall/a.b",
    "/apps/heimdall/x.y/z", "/apps/heimdall/a.b/../tab",
])
def test_heimdall_documents_carry_the_framing_policy(proxy, path):
    status, headers, body = proxy.get(path)
    assert status == 200
    assert body == DOCUMENT
    assert headers.get("Content-Security-Policy") == HEIMDALL_POLICY
    assert headers.get("Cache-Control") == "no-store, must-revalidate"


@pytest.mark.parametrize("path", [
    "/apps/ordinary", "/apps/ordinary/tab", "/apps/ordinary/a.b", "/apps/ordinary/x.y/z",
])
def test_other_app_documents_have_no_policy(proxy, path):
    status, headers, body = proxy.get(path)
    assert status == 200
    assert body == DOCUMENT
    assert "Content-Security-Policy" not in headers


def test_real_assets_keep_the_static_handler(proxy):
    status, headers, body = proxy.get("/assets/app.js")
    assert status == 200
    assert body == ASSET
    # `expires 1y` and the location's own header both set Cache-Control.
    assert headers.get_all("Cache-Control") == ["max-age=31536000", "public, immutable"]
    assert "Expires" in headers
    assert "Content-Security-Policy" not in headers

    status, headers, _body = proxy.get("/apps/heimdall/x.js")
    assert status == 404
    assert "Content-Security-Policy" not in headers

