"""add message_attachments table (Chat V2 M4 — Attachments)

User-uploaded files (images, PDFs, CSVs, text) attached to chat messages.
Content lives in S3 under ``_attachments/{conversation_id}/{uuid}_{filename}``;
only metadata + extracted text live here. ``message_id`` is nullable: an
attachment is uploaded to a conversation first, then bound to the user message
at send time. See §3.3 of the chat UX design spec.

Revision ID: 20260617_message_attachments
Revises: 20260617_merge_chatv2_main
Create Date: 2026-06-17
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260617_message_attachments"
down_revision = "20260617_merge_chatv2_main"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "message_attachments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "message_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("s3_key", sa.String(length=1024), nullable=False),
        sa.Column("filename", sa.String(length=500), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "ix_message_attachments_message_id",
        "message_attachments",
        ["message_id"],
    )
    op.create_index(
        "ix_message_attachments_conversation_id",
        "message_attachments",
        ["conversation_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_message_attachments_conversation_id",
        table_name="message_attachments",
    )
    op.drop_index(
        "ix_message_attachments_message_id",
        table_name="message_attachments",
    )
    op.drop_table("message_attachments")
