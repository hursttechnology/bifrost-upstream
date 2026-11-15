"""Remove bearer query strings from embed access and exception logs."""

import logging
import posixpath
import re
from urllib.parse import parse_qsl, unquote


# A path (after any scheme and host) followed by its query, in free-form text.
_PATH_QUERY = re.compile(r"(?:[A-Za-z][A-Za-z0-9+.-]*://[^/\s?\"']*)?(/[^\s?\"']*)\?([^\s\"']*)")


def _signed(path: str, query: str) -> bool:
    """True for any spelling of an embed path, or a query with an hmac key."""
    collapsed = re.sub(r"/+", "/", unquote(path))
    normalised = posixpath.normpath(collapsed) if collapsed else collapsed
    # Appending "/" lets "/embed" match while "/embedding" does not.
    if f"{normalised}/".casefold().startswith("/embed/"):
        return True
    return any(key.casefold() == "hmac" for key, _ in parse_qsl(query, keep_blank_values=True))


def _redact_target(target: str) -> str:
    path, separator, query = target.partition("?")
    return f"{path}?[redacted]" if separator and _signed(path, query) else target


def _redact_line(line: re.Match[str]) -> str:
    # Discard the rest of the line after a signed query: quotes or spaces in
    # it must not expose the remainder as apparent diagnostic text.
    text = line[0]
    for match in _PATH_QUERY.finditer(text):
        if _signed(match[1], text[match.start(2):]):
            return f"{text[:match.start(2)]}[redacted]"
    return text


def _redact(text: str) -> str:
    return re.sub(r"[^\r\n]+", _redact_line, text)


class EmbedQueryFilter(logging.Filter):
    """Preserve Uvicorn's structured access args and sanitise error rendering."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
            client, method, path, version, status = record.args
            if isinstance(path, str):
                record.args = (client, method, _redact_target(path), version, status)
        else:
            record.msg = _redact(record.getMessage())
            record.args = ()
        # Standard logging formatters reuse exc_text instead of rendering the
        # original exception again, including Uvicorn's default formatter.
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = _redact(record.exc_text)
        if record.stack_info:
            record.stack_info = _redact(record.stack_info)
        return True


def install_embed_log_redaction() -> None:
    """Attach to emitting loggers, since ancestor logger filters do not run."""
    for name in ("uvicorn.access", "uvicorn.error", "src.core.app_wiring"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, EmbedQueryFilter) for f in logger.filters):
            logger.addFilter(EmbedQueryFilter())
