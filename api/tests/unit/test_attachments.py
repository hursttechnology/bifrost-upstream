"""Unit tests for the chat AttachmentService (Chat V2 M4 — §3, §13).

Covers validation, S3 key scheme, text extraction (CSV/text), LLM-content
assembly (vision gating), and bind guards. Storage and DB are mocked; these
are pure-logic tests that do not require the test stack.
"""

from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from src.models.orm import MessageAttachment
from src.services.attachments import (
    DEFAULT_CONVERSATION_TOTAL_BYTES,
    MAX_FILE_SIZE_BYTES,
    MAX_FILES_PER_MESSAGE,
    ORG_SETTINGS_LIMIT_KEY,
    AttachmentError,
    AttachmentService,
    estimate_tokens,
    is_image,
)


def _svc(db=None) -> AttachmentService:
    return AttachmentService(db or AsyncMock())


# --------------------------------------------------------------------------- #
# Org-configurable conversation byte limit
# --------------------------------------------------------------------------- #


def test_conversation_byte_limit_default():
    assert AttachmentService.conversation_byte_limit(None) == DEFAULT_CONVERSATION_TOTAL_BYTES
    assert AttachmentService.conversation_byte_limit({}) == DEFAULT_CONVERSATION_TOTAL_BYTES


def test_conversation_byte_limit_org_override():
    settings = {ORG_SETTINGS_LIMIT_KEY: 10 * 1024 * 1024}
    assert AttachmentService.conversation_byte_limit(settings) == 10 * 1024 * 1024


def test_conversation_byte_limit_ignores_invalid_override():
    for bad in ({ORG_SETTINGS_LIMIT_KEY: -5}, {ORG_SETTINGS_LIMIT_KEY: 0}, {ORG_SETTINGS_LIMIT_KEY: "nope"}):
        assert AttachmentService.conversation_byte_limit(bad) == DEFAULT_CONVERSATION_TOTAL_BYTES


# --------------------------------------------------------------------------- #
# Token estimate (composer cost hint, §16.8)
# --------------------------------------------------------------------------- #


def test_estimate_tokens_none_for_empty():
    assert estimate_tokens(None) is None
    assert estimate_tokens("") is None


def test_estimate_tokens_rough_ratio():
    assert estimate_tokens("a" * 400) == 100  # ~len/4
    assert estimate_tokens("hi") == 1  # min 1 for any non-empty text


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def test_validate_accepts_supported_types():
    svc = _svc()
    for ct in ["image/png", "application/pdf", "text/csv", "text/plain", "application/json"]:
        svc.validate_file(content_type=ct, size_bytes=10, filename="f")


def test_validate_accepts_arbitrary_text_subtype():
    svc = _svc()
    svc.validate_file(content_type="text/x-python", size_bytes=10, filename="a.py")


def test_validate_rejects_unsupported_type():
    svc = _svc()
    with pytest.raises(AttachmentError):
        svc.validate_file(content_type="application/zip", size_bytes=10, filename="a.zip")


def test_validate_rejects_empty():
    svc = _svc()
    with pytest.raises(AttachmentError):
        svc.validate_file(content_type="text/plain", size_bytes=0, filename="a.txt")


def test_validate_rejects_oversize():
    svc = _svc()
    with pytest.raises(AttachmentError):
        svc.validate_file(
            content_type="image/png",
            size_bytes=MAX_FILE_SIZE_BYTES + 1,
            filename="big.png",
        )


def test_validate_requires_filename():
    svc = _svc()
    with pytest.raises(AttachmentError):
        svc.validate_file(content_type="text/plain", size_bytes=10, filename="")


# --------------------------------------------------------------------------- #
# S3 key scheme (§3.2)
# --------------------------------------------------------------------------- #


def test_build_s3_key_scheme():
    conv = uuid4()
    att = uuid4()
    key = AttachmentService.build_s3_key(conv, att, "report.pdf")
    assert key == f"_attachments/{conv}/{att}_report.pdf"


def test_build_s3_key_sanitizes_path_separators():
    conv = uuid4()
    att = uuid4()
    key = AttachmentService.build_s3_key(conv, att, "a/b\\c.txt")
    assert "/" not in key.split(f"{att}_", 1)[1]
    assert key.endswith("a_b_c.txt")


# --------------------------------------------------------------------------- #
# Text extraction
# --------------------------------------------------------------------------- #


def test_extract_text_none_for_images():
    svc = _svc()
    assert svc.extract_text(content=b"\x89PNG", content_type="image/png") is None
    assert is_image("image/png")


def test_extract_text_decodes_plain_text():
    svc = _svc()
    out = svc.extract_text(content=b"hello world", content_type="text/plain")
    assert out == "hello world"


def test_extract_csv_preview_truncates_rows():
    svc = _svc()
    rows = "\n".join(["header"] + [f"row{i}" for i in range(100)])
    out = svc.extract_text(content=rows.encode(), content_type="text/csv")
    assert "header" in out
    assert "more rows omitted" in out
    assert "row99" not in out  # truncated past the preview window


# --------------------------------------------------------------------------- #
# build_llm_content — vision gating (§3.1)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_build_llm_content_emits_images_when_vision_supported():
    svc = _svc()
    img = MessageAttachment(
        id=uuid4(),
        conversation_id=uuid4(),
        s3_key="_attachments/x/y_a.png",
        filename="a.png",
        content_type="image/png",
        size_bytes=10,
        extracted_text=None,
    )
    fake_storage = AsyncMock()
    fake_storage.read_uploaded_file.return_value = b"PNGBYTES"
    with patch(
        "src.services.attachments.get_file_storage_service",
        return_value=fake_storage,
    ):
        out = await svc.build_llm_content(attachments=[img], include_images=True)
    assert len(out.images) == 1
    assert out.images[0].media_type == "image/png"
    assert out.images[0].data == b"PNGBYTES"
    assert out.text is None


@pytest.mark.asyncio
async def test_build_llm_content_text_fallback_when_no_vision():
    svc = _svc()
    img = MessageAttachment(
        id=uuid4(),
        conversation_id=uuid4(),
        s3_key="_attachments/x/y_a.png",
        filename="a.png",
        content_type="image/png",
        size_bytes=10,
        extracted_text=None,
    )
    fake_storage = AsyncMock()
    with patch(
        "src.services.attachments.get_file_storage_service",
        return_value=fake_storage,
    ):
        out = await svc.build_llm_content(attachments=[img], include_images=False)
    assert out.images == []
    assert out.text is not None and "a.png" in out.text
    fake_storage.read_uploaded_file.assert_not_called()


@pytest.mark.asyncio
async def test_build_llm_content_inlines_extracted_text():
    svc = _svc()
    pdf = MessageAttachment(
        id=uuid4(),
        conversation_id=uuid4(),
        s3_key="_attachments/x/y_a.pdf",
        filename="a.pdf",
        content_type="application/pdf",
        size_bytes=10,
        extracted_text="Quarterly report body",
    )
    with patch(
        "src.services.attachments.get_file_storage_service",
        return_value=AsyncMock(),
    ):
        out = await svc.build_llm_content(attachments=[pdf], include_images=True)
    assert out.images == []
    assert "Quarterly report body" in out.text
    assert "a.pdf" in out.text


# --------------------------------------------------------------------------- #
# bind_to_message guards
# --------------------------------------------------------------------------- #


def _bind_db_returning(attachments: list[MessageAttachment]) -> AsyncMock:
    db = AsyncMock()
    scalars = AsyncMock()
    scalars.all = lambda: attachments
    result = AsyncMock()
    result.scalars = lambda: scalars
    db.execute.return_value = result
    return db


@pytest.mark.asyncio
async def test_bind_empty_is_noop():
    svc = _svc()
    assert await svc.bind_to_message(
        attachment_ids=[], message_id=uuid4(), conversation_id=uuid4()
    ) == []


@pytest.mark.asyncio
async def test_bind_rejects_too_many():
    svc = _svc()
    ids = [uuid4() for _ in range(MAX_FILES_PER_MESSAGE + 1)]
    with pytest.raises(AttachmentError):
        await svc.bind_to_message(
            attachment_ids=ids, message_id=uuid4(), conversation_id=uuid4()
        )


@pytest.mark.asyncio
async def test_bind_rejects_missing():
    conv = uuid4()
    aid = uuid4()
    db = _bind_db_returning([])  # nothing found
    svc = _svc(db)
    with pytest.raises(AttachmentError, match="not found"):
        await svc.bind_to_message(
            attachment_ids=[aid], message_id=uuid4(), conversation_id=conv
        )


@pytest.mark.asyncio
async def test_bind_rejects_cross_conversation():
    conv = uuid4()
    other_conv = uuid4()
    aid = uuid4()
    att = MessageAttachment(
        id=aid,
        conversation_id=other_conv,
        s3_key="k",
        filename="f",
        content_type="text/plain",
        size_bytes=1,
    )
    svc = _svc(_bind_db_returning([att]))
    with pytest.raises(AttachmentError, match="does not belong"):
        await svc.bind_to_message(
            attachment_ids=[aid], message_id=uuid4(), conversation_id=conv
        )


@pytest.mark.asyncio
async def test_bind_rejects_already_bound():
    conv = uuid4()
    aid = uuid4()
    att = MessageAttachment(
        id=aid,
        message_id=uuid4(),  # already bound to a different message
        conversation_id=conv,
        s3_key="k",
        filename="f",
        content_type="text/plain",
        size_bytes=1,
    )
    svc = _svc(_bind_db_returning([att]))
    with pytest.raises(AttachmentError, match="already bound"):
        await svc.bind_to_message(
            attachment_ids=[aid], message_id=uuid4(), conversation_id=conv
        )


@pytest.mark.asyncio
async def test_bind_success_sets_message_id():
    conv = uuid4()
    aid = uuid4()
    msg_id = uuid4()
    att = MessageAttachment(
        id=aid,
        message_id=None,
        conversation_id=conv,
        s3_key="k",
        filename="f",
        content_type="text/plain",
        size_bytes=1,
    )
    svc = _svc(_bind_db_returning([att]))
    bound = await svc.bind_to_message(
        attachment_ids=[aid], message_id=msg_id, conversation_id=conv
    )
    assert len(bound) == 1
    assert att.message_id == msg_id
