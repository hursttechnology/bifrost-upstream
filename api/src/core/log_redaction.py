"""Remove bearer query strings from embed access and exception logs."""

import logging
import re


# In free-form diagnostics, discard the rest of that line too: quotes or
# spaces in a query must not expose the remainder as apparent diagnostic text.
_EMBED_QUERY = re.compile(r"(/embed/[^\s?\"']*\?)[^\r\n]*")


def _redact(text: str) -> str:
    return _EMBED_QUERY.sub(r"\1[redacted]", text)


class EmbedQueryFilter(logging.Filter):
    """Preserve Uvicorn's structured access args and sanitise error rendering."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
            client, method, path, version, status = record.args
            if isinstance(path, str) and path.startswith("/embed/"):
                record.args = (client, method, _redact(path), version, status)
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
