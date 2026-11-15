"""Exercise production record shapes without emitting signed URLs to a logger."""

import logging
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from uvicorn.logging import AccessFormatter
from uvicorn.protocols.utils import get_path_with_query_string


def redactor():
    from src.core.log_redaction import EmbedQueryFilter
    return EmbedQueryFilter()


@pytest.mark.parametrize("protocol", ["h11_impl", "httptools_impl"])
@pytest.mark.parametrize("status", [200, 302, 403, 404, 422, 500, 502])
def test_access_records_preserve_format_and_redact_query(protocol, status):
    # Both protocol implementations pass exactly this tuple, including errors.
    scope = {"path": "/embed/apps/heimdall", "query_string": b"agent_id=1&hmac=test-only"}
    record = logging.LogRecord("uvicorn.access", logging.INFO, protocol, 1,
                               '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:1234", "GET", get_path_with_query_string(scope), "1.1", status), None)
    assert redactor().filter(record)
    assert record.args == ("127.0.0.1:1234", "GET", "/embed/apps/heimdall?[redacted]", "1.1", status)
    rendered = AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False).format(record)
    assert '127.0.0.1:1234 - "GET /embed/apps/heimdall?[redacted] HTTP/1.1"' in rendered
    assert str(status) in rendered
    assert "test-only" not in rendered


ALIAS_TARGETS = [
    ("/%65mbed/apps/heimdall?agent_id=1&hmac=test-only", "/%65mbed/apps/heimdall?[redacted]"),
    ("//embed/apps/heimdall?agent_id=1&hmac=test-only", "//embed/apps/heimdall?[redacted]"),
    ("/./embed/apps/heimdall?agent_id=1&hmac=test-only", "/./embed/apps/heimdall?[redacted]"),
    ("/apps/../embed/apps/heimdall?agent_id=1&hmac=test-only", "/apps/../embed/apps/heimdall?[redacted]"),
    ("/EMBED/apps/heimdall?agent_id=1&hmac=test-only", "/EMBED/apps/heimdall?[redacted]"),
    ("/api/apps?view=1&hmac=test-only", "/api/apps?[redacted]"),
    ("/api/apps?HMAC=test-only", "/api/apps?[redacted]"),
    ("/api/apps?h%6Dac=test-only", "/api/apps?[redacted]"),
]
ALIAS_IDS = ["encoded", "double-slash", "dot-segment", "parent-segment", "case", "hmac", "hmac-upper", "hmac-encoded"]


@pytest.mark.parametrize("target, expected", ALIAS_TARGETS, ids=ALIAS_IDS)
def test_access_records_redact_path_aliases_and_hmac_queries(target, expected):
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:1234", "GET", target, "1.1", 302), None)
    assert redactor().filter(record)
    assert record.args == ("127.0.0.1:1234", "GET", expected, "1.1", 302)


@pytest.mark.parametrize("target, expected", ALIAS_TARGETS, ids=ALIAS_IDS)
def test_diagnostics_redact_path_aliases_and_hmac_queries(target, expected):
    record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 1,
                               "Failed https://bifrost.example%s for client", (target,), None)
    redactor().filter(record)
    assert record.getMessage() == f"Failed https://bifrost.example{expected}"


@pytest.mark.parametrize("message, expected", [
    ("Failed /api/a?x=1 then /EMBED/apps/heimdall?hmac=test-only", "Failed /api/a?x=1 then /EMBED/apps/heimdall?[redacted]"),
    ("Failed /api/x?value='a b'&hmac=test-only", "Failed /api/x?[redacted]"),
    ("Failed /api/apps?search=ordinary and /embedding?x=1", "Failed /api/apps?search=ordinary and /embedding?x=1"),
], ids=["second-occurrence", "quoted-hmac-query", "ordinary"])
def test_diagnostics_check_every_query_on_a_line(message, expected):
    record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 1, message, (), None)
    redactor().filter(record)
    assert record.getMessage() == expected


@pytest.mark.parametrize("path", [
    "/api/apps?search=ordinary", "/embedding?x=1", "/embed/apps/heimdall", "/api/embed/ordinary?x=1",
    "/api/apps?hmacs=1", "/api/apps?x=hmac",
])
def test_other_paths_and_queryless_requests_unchanged(path):
    args = ("127.0.0.1:1234", "GET", path, "1.1", 200)
    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 1, '%s - "%s %s HTTP/%s" %d', args, None)
    assert redactor().filter(record)
    assert record.args == args


def test_query_quotes_and_spaces_do_not_leak_in_diagnostics():
    record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 1,
                               "Failed /embed/apps/example?value='quoted text'&hmac=test-only", (), None)
    redactor().filter(record)
    assert record.getMessage() == "Failed /embed/apps/example?[redacted]"


@pytest.mark.parametrize("name", ["uvicorn.error", "src.core.app_wiring"])
@pytest.mark.parametrize("style", ["formatted", "tuple", "mapping", "exception", "cached_exception"])
def test_error_records_redact_full_urls_and_tracebacks(name, style):
    url = "https://bifrost.example/embed/forms/example?agent_id=1&hmac=test-only"
    record = logging.LogRecord(name, logging.ERROR, "", 1, "Request failed", (), None)
    if style == "formatted":
        record.msg = f"Request failed: {url}"
    elif style == "tuple":
        record.msg, record.args = "Request failed: %s", (url,)
    elif style == "mapping":
        record.msg, record.args = "Request failed: %(url)s", {"url": url}
    else:
        try:
            raise RuntimeError(url)
        except RuntimeError:
            record.exc_info = sys.exc_info()
        if style == "cached_exception":
            record.exc_text = logging.Formatter().formatException(record.exc_info)
    assert redactor().filter(record)
    rendered = logging.Formatter("%(message)s").format(record)
    assert "test-only" not in rendered
    assert "agent_id=" not in rendered
    assert "/embed/forms/example?[redacted]" in rendered
    if "exception" in style:
        assert "RuntimeError" in rendered


def test_ordinary_exception_keeps_diagnostics():
    record = logging.LogRecord("uvicorn.error", logging.ERROR, "", 1, "Failed %s", ("ordinary",), None)
    record.exc_text = "RuntimeError: ordinary failure"
    redactor().filter(record)
    assert logging.Formatter().format(record) == "Failed ordinary\nRuntimeError: ordinary failure"


@pytest.mark.asyncio
async def test_filter_installed_after_application_startup(monkeypatch):
    from src import main
    from src.core.log_redaction import EmbedQueryFilter, install_embed_log_redaction
    from src.services.policy_rule_service import PolicyRuleService
    from src.services import kubernetes_execution

    names = ("uvicorn.access", "uvicorn.error", "src.core.app_wiring")
    for name in names:
        # Model a logging configuration that replaced the filters after import.
        monkeypatch.setattr(logging.getLogger(name), "filters", [])
    for name in ("init_db", "register_dynamic_workflow_endpoints", "close_db", "close_health_check_clients"):
        monkeypatch.setattr(main, name, AsyncMock())
    monkeypatch.setattr(main.pubsub_manager, "close", AsyncMock())
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(default_user_email=None, environment="testing"))
    monkeypatch.setattr(PolicyRuleService, "seed_builtin_admin_bypass", AsyncMock())
    monkeypatch.setattr(kubernetes_execution, "announce_detection_if_transitioned", AsyncMock(return_value=None))
    from src.services.agent_runtime import retry_transport
    monkeypatch.setattr(retry_transport, "close_ai_retry_http_client", AsyncMock())

    @asynccontextmanager
    async def session():
        yield AsyncMock()

    monkeypatch.setattr(main, "get_session_factory", lambda: session)
    async with main.app_lifespan(main.app):
        for name in names:
            assert any(isinstance(f, EmbedQueryFilter) for f in logging.getLogger(name).filters)
        install_embed_log_redaction()
        for name in names:
            assert sum(isinstance(f, EmbedQueryFilter) for f in logging.getLogger(name).filters) == 1
