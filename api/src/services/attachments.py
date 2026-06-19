"""
Chat attachment service (Chat V2 M4).

Owns validation, S3 storage, server-side text extraction, LLM-content
assembly, and message binding for user-uploaded chat attachments.

Attachments are uploaded to a conversation first (unbound), then bound to a
user message at send time. Content lives in S3 under
``_attachments/{conversation_id}/{uuid}_{filename}``; only metadata and any
extracted text live in the ``message_attachments`` table. See §3 of the chat
UX design spec.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.orm import Conversation, MessageAttachment
from src.services.file_storage.service import get_file_storage_service

logger = logging.getLogger(__name__)

# S3 key prefix for attachment blobs.
ATTACHMENTS_PREFIX = "_attachments/"

# Per-attachment / per-message limits (spec §3.2).
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB per file
MAX_FILES_PER_MESSAGE = 5
# Per-conversation total cap. Org-configurable; this is the default (spec §3.2).
DEFAULT_CONVERSATION_TOTAL_BYTES = 500 * 1024 * 1024  # 500 MB
# Org-settings key that overrides the per-conversation cap above.
ORG_SETTINGS_LIMIT_KEY = "max_attachment_bytes_per_conversation"

# Rough chars-per-token ratio for the composer's pre-send cost hint (§16.8).
_CHARS_PER_TOKEN = 4

# Supported content types (spec §3.1).
IMAGE_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
}
PDF_CONTENT_TYPES = {"application/pdf"}
CSV_CONTENT_TYPES = {"text/csv", "application/csv"}
# Text and code files. We also accept anything under text/* at validation time.
TEXT_CONTENT_TYPES = {
    "text/plain",
    "text/markdown",
    "application/json",
    "text/json",
    "application/x-yaml",
    "text/yaml",
    "text/x-yaml",
}

SUPPORTED_CONTENT_TYPES = (
    IMAGE_CONTENT_TYPES | PDF_CONTENT_TYPES | CSV_CONTENT_TYPES | TEXT_CONTENT_TYPES
)

# How many CSV preview rows / characters of extracted text to keep.
_CSV_PREVIEW_ROWS = 20
_MAX_EXTRACTED_TEXT_CHARS = 200_000


class AttachmentError(Exception):
    """Raised for invalid attachment uploads or bind operations."""


@dataclass
class LLMImageBlock:
    """An image to render as a provider vision content block."""

    media_type: str
    data: bytes  # raw image bytes (provider clients base64-encode)


@dataclass
class LLMAttachmentContent:
    """Assembled LLM content for a message's attachments.

    ``images`` are emitted as vision blocks (only when the model supports
    vision — gating happens before this is built). ``text`` is the inlined
    extracted text (PDF/CSV/text), always safe to include.
    """

    images: list[LLMImageBlock]
    text: str | None


def _is_text_like(content_type: str) -> bool:
    return content_type in TEXT_CONTENT_TYPES or content_type.startswith("text/")


def is_image(content_type: str) -> bool:
    return content_type in IMAGE_CONTENT_TYPES


class AttachmentService:
    """Validates, stores, extracts, and binds chat attachments."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        conversation_total_cap_bytes: int = DEFAULT_CONVERSATION_TOTAL_BYTES,
    ) -> None:
        self.db = db
        self.conversation_total_cap_bytes = conversation_total_cap_bytes

    @staticmethod
    def conversation_byte_limit(org_settings: dict | None) -> int:
        """Per-conversation total-bytes cap, honoring an org-settings override.

        Returns the org's ``max_attachment_bytes_per_conversation`` when it is a
        positive int, else the platform default. Callers resolve this from the
        org's settings and pass it as ``conversation_total_cap_bytes``.
        """
        if org_settings:
            override = org_settings.get(ORG_SETTINGS_LIMIT_KEY)
            if isinstance(override, int) and override > 0:
                return override
        return DEFAULT_CONVERSATION_TOTAL_BYTES

    # ------------------------------------------------------------------ #
    # Validation
    # ------------------------------------------------------------------ #

    def validate_file(self, *, content_type: str, size_bytes: int, filename: str) -> None:
        """Validate a single file's type and size. Raises AttachmentError."""
        if not filename:
            raise AttachmentError("Attachment filename is required.")
        if content_type not in SUPPORTED_CONTENT_TYPES and not _is_text_like(content_type):
            raise AttachmentError(
                f"Unsupported attachment type: {content_type!r}. "
                "Supported: images, PDFs, CSVs, and text files."
            )
        if size_bytes <= 0:
            raise AttachmentError("Attachment is empty.")
        if size_bytes > MAX_FILE_SIZE_BYTES:
            raise AttachmentError(
                f"Attachment too large ({size_bytes} bytes). "
                f"Maximum is {MAX_FILE_SIZE_BYTES // (1024 * 1024)} MB per file."
            )

    async def _conversation_total_bytes(self, conversation_id: UUID) -> int:
        result = await self.db.execute(
            select(func.coalesce(func.sum(MessageAttachment.size_bytes), 0)).where(
                MessageAttachment.conversation_id == conversation_id
            )
        )
        return int(result.scalar() or 0)

    # ------------------------------------------------------------------ #
    # Text extraction
    # ------------------------------------------------------------------ #

    def extract_text(self, *, content: bytes, content_type: str) -> str | None:
        """Extract inline text for PDF / CSV / text files. None for images."""
        if is_image(content_type):
            return None
        if content_type in PDF_CONTENT_TYPES:
            return self._extract_pdf_text(content)
        if content_type in CSV_CONTENT_TYPES:
            return self._extract_csv_preview(content)
        if _is_text_like(content_type):
            return self._decode_text(content)
        return None

    @staticmethod
    def _decode_text(content: bytes) -> str:
        text = content.decode("utf-8", errors="replace")
        return text[:_MAX_EXTRACTED_TEXT_CHARS]

    @staticmethod
    def _extract_csv_preview(content: bytes) -> str:
        text = content.decode("utf-8", errors="replace")
        lines = text.splitlines()
        preview = lines[: _CSV_PREVIEW_ROWS + 1]  # +1 to include header row
        body = "\n".join(preview)
        if len(lines) > len(preview):
            body += f"\n... ({len(lines) - len(preview)} more rows omitted)"
        return body[:_MAX_EXTRACTED_TEXT_CHARS]

    @staticmethod
    def _extract_pdf_text(content: bytes) -> str:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(content))
        parts: list[str] = []
        for page in reader.pages:
            try:
                parts.append(page.extract_text() or "")
            except Exception:  # pragma: no cover - malformed page
                # A single unparseable page should not fail the whole upload;
                # skip it and keep the rest of the document's text.
                logger.warning("Skipped an unparseable PDF page during extraction")
        return "\n\n".join(parts).strip()[:_MAX_EXTRACTED_TEXT_CHARS]

    # ------------------------------------------------------------------ #
    # Upload + store
    # ------------------------------------------------------------------ #

    @staticmethod
    def build_s3_key(conversation_id: UUID, attachment_id: UUID, filename: str) -> str:
        """Build the S3 key: _attachments/{conversation_id}/{uuid}_{filename}."""
        safe_name = filename.replace("/", "_").replace("\\", "_")
        return f"{ATTACHMENTS_PREFIX}{conversation_id}/{attachment_id}_{safe_name}"

    async def store_upload(
        self,
        *,
        conversation_id: UUID,
        filename: str,
        content_type: str,
        content: bytes,
    ) -> MessageAttachment:
        """Validate, store to S3, extract text, and persist one attachment.

        The attachment is created unbound (``message_id`` NULL); bind it later
        with :meth:`bind_to_message`. Does NOT commit — the caller commits.
        """
        size_bytes = len(content)
        self.validate_file(
            content_type=content_type, size_bytes=size_bytes, filename=filename
        )

        existing_total = await self._conversation_total_bytes(conversation_id)
        if existing_total + size_bytes > self.conversation_total_cap_bytes:
            raise AttachmentError(
                "Conversation attachment storage limit exceeded "
                f"({self.conversation_total_cap_bytes // (1024 * 1024)} MB)."
            )

        attachment_id = uuid4()
        s3_key = self.build_s3_key(conversation_id, attachment_id, filename)

        storage = get_file_storage_service(self.db)
        await storage.write_raw_to_s3(s3_key, content)

        extracted = self.extract_text(content=content, content_type=content_type)

        attachment = MessageAttachment(
            id=attachment_id,
            message_id=None,
            conversation_id=conversation_id,
            s3_key=s3_key,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            extracted_text=extracted,
        )
        self.db.add(attachment)
        await self.db.flush()
        return attachment

    # ------------------------------------------------------------------ #
    # Binding
    # ------------------------------------------------------------------ #

    async def bind_to_message(
        self,
        *,
        attachment_ids: list[UUID],
        message_id: UUID,
        conversation_id: UUID,
    ) -> list[MessageAttachment]:
        """Bind previously-uploaded attachments to a user message.

        Guards:
          - count must not exceed MAX_FILES_PER_MESSAGE
          - every attachment must belong to this conversation (cross-conversation
            binding is rejected)
          - none may already be bound to a different message

        Does NOT commit — the caller commits.
        """
        if not attachment_ids:
            return []
        if len(attachment_ids) > MAX_FILES_PER_MESSAGE:
            raise AttachmentError(
                f"Too many attachments ({len(attachment_ids)}). "
                f"Maximum is {MAX_FILES_PER_MESSAGE} per message."
            )

        result = await self.db.execute(
            select(MessageAttachment).where(
                MessageAttachment.id.in_(attachment_ids)
            )
        )
        found = {a.id: a for a in result.scalars().all()}

        missing = [aid for aid in attachment_ids if aid not in found]
        if missing:
            raise AttachmentError(
                f"Attachment(s) not found: {', '.join(str(m) for m in missing)}"
            )

        bound: list[MessageAttachment] = []
        for aid in attachment_ids:
            att = found[aid]
            if att.conversation_id != conversation_id:
                raise AttachmentError(
                    f"Attachment {aid} does not belong to this conversation."
                )
            if att.message_id is not None and att.message_id != message_id:
                raise AttachmentError(
                    f"Attachment {aid} is already bound to another message."
                )
            att.message_id = message_id
            bound.append(att)

        await self.db.flush()
        return bound

    # ------------------------------------------------------------------ #
    # LLM content assembly
    # ------------------------------------------------------------------ #

    async def build_llm_content(
        self,
        *,
        attachments: list[MessageAttachment],
        include_images: bool,
    ) -> LLMAttachmentContent:
        """Assemble LLM vision blocks + inline text for a message's attachments.

        ``include_images`` gates vision blocks on the resolved model's vision
        capability. Extracted text is always included so non-vision models still
        receive PDF/CSV/text content.
        """
        images: list[LLMImageBlock] = []
        text_parts: list[str] = []

        storage = get_file_storage_service(self.db)

        for att in attachments:
            if is_image(att.content_type):
                if include_images:
                    data = await storage.read_uploaded_file(att.s3_key)
                    images.append(
                        LLMImageBlock(media_type=att.content_type, data=data)
                    )
                else:
                    text_parts.append(
                        f"[Attached image: {att.filename} "
                        "(this model cannot view images)]"
                    )
            elif att.extracted_text:
                text_parts.append(
                    f"[Attached file: {att.filename}]\n{att.extracted_text}"
                )
            else:
                text_parts.append(f"[Attached file: {att.filename}]")

        text = "\n\n".join(text_parts) if text_parts else None
        return LLMAttachmentContent(images=images, text=text)


async def get_conversation_or_none(
    db: AsyncSession, conversation_id: UUID, user_id: UUID
) -> Conversation | None:
    """Load a conversation owned by the user, or None.

    Mirrors the ownership check used throughout the chat router (conversations
    are owned by their creating user).
    """
    result = await db.execute(
        select(Conversation)
        .where(Conversation.id == conversation_id)
        .where(Conversation.user_id == user_id)
    )
    return result.scalar_one_or_none()


def estimate_tokens(text: str | None) -> int | None:
    """Rough token estimate for the composer chip's pre-send cost hint (§16.8).

    Approximate (``len // 4``); None for empty/missing text. Used to surface
    "~N tokens" before send, not for billing.
    """
    if not text:
        return None
    return max(1, len(text) // _CHARS_PER_TOKEN)


async def load_message_attachments(
    db: AsyncSession, message_id: UUID
) -> list[MessageAttachment]:
    """Load attachments bound to a message, ordered by creation."""
    result = await db.execute(
        select(MessageAttachment)
        .where(MessageAttachment.message_id == message_id)
        .order_by(MessageAttachment.created_at)
    )
    return list(result.scalars().all())
