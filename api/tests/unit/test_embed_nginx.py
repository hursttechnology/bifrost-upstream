"""Text contracts for the production proxy; these do not execute nginx."""

from pathlib import Path
import re

import pytest


CONF = (Path(__file__).resolve().parents[3] / "client/nginx.conf").read_text()


def block(marker):
    return CONF.split(marker, 1)[1].split("}", 1)[0]


APP_MARKER = "location ~ ^/apps/(?<app_frame_slug>[a-z][a-z0-9-]*)(?:/.*)?$ {"
STATIC_MARKER = "location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {"


def test_app_document_policy_wiring():
    document = block(APP_MARKER)
    assert "auth_request /_app_frame_policy;" in document
    assert "auth_request_set $app_frame_ancestors $upstream_http_x_bifrost_frame_ancestors;" in document
    assert 'add_header Content-Security-Policy $app_frame_csp always;' in document
    assert 'add_header Cache-Control "no-store, must-revalidate" always;' in document
    assert "etag off;" in document
    assert "try_files /index.html =404;" in document
    # Regex locations match in order: real assets must reach the static handler first.
    assert CONF.index(STATIC_MARKER) < CONF.index(APP_MARKER)
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


@pytest.mark.parametrize("path, handler", [
    ("/apps/heimdall", "app"), ("/apps/heimdall/", "app"),
    ("/apps/heimdall/tab/ticket", "app"), ("/apps/ordinary/preview", "app"),
    ("/apps/heimdall/a.b", "app"), ("/apps/heimdall/a.b/page", "app"),
    ("/apps/heimdall/a.json", "app"), ("/apps/heimdall/x.js/", "app"),
    ("/apps/heimdall/main.js", "static"), ("/apps/heimdall/logo.SVG", "static"),
    ("/apps/heimdall.css", "static"), ("/apps/heimdall.x", None), ("/other/heimdall", None),
])
def test_app_document_location_leaves_real_assets_to_the_static_handler(path, handler):
    def regex(marker, flags=0):
        pattern = marker.split(" ")[2]
        return re.compile(re.sub(r"\(\?<([a-z_]+)>", r"(?P<\1>", pattern), flags)

    # The static location comes first (pinned above) and is case-insensitive.
    static, app = regex(STATIC_MARKER, re.IGNORECASE), regex(APP_MARKER)
    winner = "static" if static.search(path) else "app" if app.search(path) else None
    assert winner == handler


REQUEST_MAP = 'map "$embed_log_redact $request" $embed_log_request {'
REFERER_MAP = "map $http_referer $embed_log_referer {"


def test_access_log_uses_redacted_request_and_referer():
    assert "~^\\S+\\s/embed/ 1;" in block("map $request $embed_log_raw {")
    assert "~*^/embed/ 1;" in block("map $uri $embed_log_normalised {")
    redact = block('map "$embed_log_raw$embed_log_normalised$arg_hmac" $embed_log_redact {')
    assert '"" "";' in redact
    assert "default 1;" in redact
    request_map = block(REQUEST_MAP)
    assert "default $request;" in request_map
    assert '"$embed_log_method $embed_log_path?[redacted]$embed_log_protocol";' in request_map
    referer_map = block(REFERER_MAP)
    assert "default $http_referer;" in referer_map
    assert '"$embed_log_referer_base?[redacted]";' in referer_map
    log_format = CONF.split("log_format embed_redacted ", 1)[1].split(";", 1)[0]
    assert " ".join(log_format.split()) == (
        "'$remote_addr - $remote_user [$time_local] \"$embed_log_request\" ' "
        "'$status $body_bytes_sent \"$embed_log_referer\" ' "
        "'\"$http_user_agent\" \"$http_x_forwarded_for\"'"
    )
    assert CONF.index("log_format embed_redacted") < CONF.index("server {")
    assert "access_log /var/log/nginx/access.log embed_redacted;" in block("server {")
    assert CONF.count("access_log ") == 1


def _apply_map_rule(marker, value):
    """Apply a map's single regex rule; None means the map's default applies."""
    rule = re.search(r'~(\S+)\s+"([^"]+)";', block(marker))
    assert rule is not None
    match = re.search(re.sub(r"\(\?<([a-z_]+)>", r"(?P<\1>", rule[1]), value)
    if match is None:
        return None
    return re.sub(r"\$([a-z_]+)", lambda m: match[m[1]] or "", rule[2])


@pytest.mark.parametrize("redact, request_line, expected", [
    ("1", "GET /embed/apps/heimdall?agent_id=1&hmac=test-only HTTP/1.1", "GET /embed/apps/heimdall?[redacted] HTTP/1.1"),
    ("1", "POST /%65mbed/forms/example?x=test-only HTTP/2.0", "POST /%65mbed/forms/example?[redacted] HTTP/2.0"),
    ("1", "GET http://host/embed/apps/heimdall?hmac=test-only HTTP/1.1", "GET http://host/embed/apps/heimdall?[redacted] HTTP/1.1"),
    ("1", "GET /embed/a b?hmac=test-only x HTTP/1.1", "GET /embed/a b?[redacted] HTTP/1.1"),
    ("1", "GET /embed/apps/heimdall?hmac=test-only", "GET /embed/apps/heimdall?[redacted]"),
    ("1", "GET /embed/apps/heimdall HTTP/1.1", None),
    ("", "GET /api/apps?x=ordinary HTTP/1.1", None),
], ids=["canonical", "encoded", "absolute-form", "space-in-target", "no-protocol", "queryless", "ordinary"])
def test_request_map_pattern(redact, request_line, expected):
    assert _apply_map_rule(REQUEST_MAP, f"{redact} {request_line}") == expected


@pytest.mark.parametrize("referer, expected", [
    ("https://bifrost.example/embed/apps/heimdall?agent_id=1&hmac=test-only", "https://bifrost.example/embed/apps/heimdall?[redacted]"),
    ("https://bifrost.example/%65mbed/apps/heimdall?hmac=test-only", "https://bifrost.example/%65mbed/apps/heimdall?[redacted]"),
    ("https://bifrost.example/apps/ordinary?x=ordinary", "https://bifrost.example/apps/ordinary?[redacted]"),
    ("https://bifrost.example/apps/ordinary", None),
], ids=["canonical", "encoded", "ordinary", "queryless"])
def test_referer_map_pattern(referer, expected):
    assert _apply_map_rule(REFERER_MAP, referer) == expected
