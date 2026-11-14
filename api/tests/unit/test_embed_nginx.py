"""Text contracts for the production proxy; these do not execute nginx."""

from pathlib import Path
import re

import pytest


CONF = (Path(__file__).resolve().parents[3] / "client/nginx.conf").read_text()


def block(marker):
    return CONF.split(marker, 1)[1].split("}", 1)[0]


def test_app_document_policy_wiring():
    marker = "location ~ ^/apps/(?<app_frame_slug>[a-z][a-z0-9-]*)(/[^.]*)?$ {"
    document = block(marker)
    assert "auth_request /_app_frame_policy;" in document
    assert "auth_request_set $app_frame_ancestors $upstream_http_x_bifrost_frame_ancestors;" in document
    assert 'add_header Content-Security-Policy $app_frame_csp always;' in document
    assert 'add_header Cache-Control "no-store, must-revalidate" always;' in document
    assert "etag off;" in document
    assert "try_files /index.html =404;" in document
    assert CONF.index(marker) < CONF.index("location ~* \\.")
    internal = block("location = /_app_frame_policy {")
    assert "internal;" in internal
    assert "rewrite ^ /embed/apps/$app_frame_slug/frame-policy break;" in internal
    assert "proxy_pass http://api:8000;" in internal
    assert "proxy_pass_request_body off;" in internal
    assert 'proxy_set_header Content-Length "";' in internal
    policy_map = block("map $app_frame_ancestors $app_frame_csp {")
    assert '"" "";' in policy_map
    assert 'default "frame-ancestors $app_frame_ancestors";' in policy_map
    assert CONF.index("map $app_frame_ancestors") < CONF.index("server {")


@pytest.mark.parametrize("path, matches", [
    ("/apps/heimdall", True), ("/apps/heimdall/", True),
    ("/apps/heimdall/tab/ticket", True), ("/apps/ordinary/preview", True),
    ("/apps/heimdall/main.js", False), ("/apps/heimdall/a.b/page", False),
    ("/apps/heimdall.css", False), ("/apps/heimdall/a.json", False),
    ("/other/heimdall", False),
])
def test_app_document_location_excludes_assets(path, matches):
    pattern = re.search(r"location ~ (\^/apps/\S+) \{", CONF)
    assert pattern is not None
    python_pattern = pattern[1].replace("(?<app_frame_slug>", "(?P<app_frame_slug>")
    assert bool(re.fullmatch(python_pattern, path)) is matches
