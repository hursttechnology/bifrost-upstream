"""Unit tests for chat export serialization (§8.3).

Pure transforms — no DB. Construct ORM instances in memory and assert on the
Markdown / JSON output shape.
"""

import json
from datetime import datetime, timezone
from uuid import uuid4

from src.models.enums import MessageRole
from src.models.orm import Conversation, Message
from src.services import chat_export


def _conv(**kw) -> Conversation:
    now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    defaults = dict(
        id=uuid4(),
        user_id=uuid4(),
        title="My chat",
        channel="chat",
        created_at=now,
        updated_at=now,
    )
    defaults.update(kw)
    return Conversation(**defaults)


def _msg(role: MessageRole, seq: int, **kw) -> Message:
    now = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    defaults = dict(
        id=uuid4(),
        conversation_id=uuid4(),
        role=role,
        sequence=seq,
        created_at=now,
    )
    defaults.update(kw)
    return Message(**defaults)


def test_markdown_renders_title_and_turns():
    conv = _conv(title="Onboarding")
    messages = [
        _msg(MessageRole.USER, 0, content="How do I onboard a client?"),
        _msg(MessageRole.ASSISTANT, 1, content="Here are the steps...", cost_tier="balanced"),
    ]
    md = chat_export.conversation_to_markdown(conv, messages)

    assert md.startswith("# Onboarding")
    assert "## User" in md
    assert "How do I onboard a client?" in md
    assert "## Assistant" in md
    assert "Here are the steps..." in md
    assert md.endswith("\n")


def test_markdown_renders_tool_calls_as_collapsible_blocks():
    conv = _conv()
    messages = [
        _msg(
            MessageRole.TOOL_CALL,
            0,
            tool_calls=[{"id": "t1", "name": "create_ticket", "arguments": {"subject": "Hi"}}],
        ),
        _msg(MessageRole.TOOL, 1, tool_name="create_ticket", tool_result={"ticket_id": 42}),
    ]
    md = chat_export.conversation_to_markdown(conv, messages)

    assert "<details>" in md
    assert "Tool call: create_ticket" in md
    assert "Tool result: create_ticket" in md
    assert '"subject": "Hi"' in md
    assert '"ticket_id": 42' in md


def test_markdown_falls_back_to_default_title():
    conv = _conv(title=None)
    md = chat_export.conversation_to_markdown(conv, [])
    assert md.startswith("# Untitled conversation")


def test_json_round_trips_structure():
    conv = _conv(title="Export me", current_model="claude-sonnet-4-6")
    messages = [
        _msg(MessageRole.USER, 0, content="hello"),
        _msg(
            MessageRole.ASSISTANT,
            1,
            content="hi",
            model="claude-sonnet-4-6",
            cost_tier="fast",
            token_count_input=120,
            token_count_output=8,
        ),
    ]
    raw = chat_export.conversation_to_json(conv, messages)
    parsed = json.loads(raw)

    assert parsed["title"] == "Export me"
    assert parsed["current_model"] == "claude-sonnet-4-6"
    assert len(parsed["messages"]) == 2
    assert parsed["messages"][0]["role"] == "user"
    assert parsed["messages"][1]["cost_tier"] == "fast"
    assert parsed["messages"][1]["token_count_input"] == 120
    # created_at serialized as ISO string, not a datetime.
    assert isinstance(parsed["created_at"], str)
