"""Per-conversation export serialization (§8.3).

Pure transformation of a conversation + its messages into a portable
Markdown or JSON document. No DB access here — the router loads the rows
and hands them in, keeping this layer testable and side-effect-free.

Markdown: message-by-message, with tool calls rendered as collapsible
``<details>`` code blocks. JSON: structured, suitable for re-importing or
feeding to other tools.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from src.models.orm import Conversation, Message

_ROLE_HEADINGS = {
    "user": "User",
    "assistant": "Assistant",
    "system": "System",
    "tool": "Tool result",
    "tool_call": "Tool call",
}


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def conversation_to_dict(
    conversation: Conversation, messages: list[Message]
) -> dict[str, Any]:
    """Structured JSON representation of a conversation and its messages."""
    return {
        "id": str(conversation.id),
        "title": conversation.title,
        "agent_id": (
            str(conversation.agent_id) if conversation.agent_id else None
        ),
        "workspace_id": (
            str(conversation.workspace_id)
            if conversation.workspace_id
            else None
        ),
        "current_model": conversation.current_model,
        "instructions": conversation.instructions,
        "created_at": _iso(conversation.created_at),
        "updated_at": _iso(conversation.updated_at),
        "messages": [
            {
                "id": str(m.id),
                "role": m.role.value if hasattr(m.role, "value") else m.role,
                "content": m.content,
                "tool_calls": m.tool_calls,
                "tool_name": m.tool_name,
                "tool_result": m.tool_result,
                "tool_input": m.tool_input,
                "model": m.model,
                "cost_tier": m.cost_tier,
                "token_count_input": m.token_count_input,
                "token_count_output": m.token_count_output,
                "sequence": m.sequence,
                "created_at": _iso(m.created_at),
            }
            for m in messages
        ],
    }


def conversation_to_json(
    conversation: Conversation, messages: list[Message]
) -> str:
    """Pretty-printed JSON string of the conversation."""
    return json.dumps(
        conversation_to_dict(conversation, messages),
        indent=2,
        ensure_ascii=False,
    )


def _render_tool_call_message(m: Message) -> str:
    """A tool_call message → a collapsible details block per tool call."""
    blocks: list[str] = []
    for call in m.tool_calls or []:
        name = call.get("name", "tool") if isinstance(call, dict) else "tool"
        args = call.get("arguments") if isinstance(call, dict) else None
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                pass  # leave as-is; it's a free string, render verbatim
        rendered_args = (
            json.dumps(args, indent=2, ensure_ascii=False)
            if not isinstance(args, str)
            else args
        )
        blocks.append(
            f"<details>\n<summary>Tool call: {name}</summary>\n\n"
            f"```json\n{rendered_args}\n```\n\n</details>"
        )
    return "\n\n".join(blocks)


def _render_tool_result_message(m: Message) -> str:
    name = m.tool_name or "tool"
    result = m.tool_result if m.tool_result is not None else m.content
    rendered = (
        json.dumps(result, indent=2, ensure_ascii=False)
        if not isinstance(result, str)
        else result
    )
    return (
        f"<details>\n<summary>Tool result: {name}</summary>\n\n"
        f"```json\n{rendered}\n```\n\n</details>"
    )


def conversation_to_markdown(
    conversation: Conversation, messages: list[Message]
) -> str:
    """Formatted Markdown export, message-by-message."""
    title = conversation.title or "Untitled conversation"
    lines: list[str] = [f"# {title}", ""]

    created = _iso(conversation.created_at)
    if created:
        lines.append(f"_Exported from Bifrost — created {created}_")
        lines.append("")

    for m in messages:
        role = m.role.value if hasattr(m.role, "value") else m.role
        heading = _ROLE_HEADINGS.get(role, role.title())

        if role == "tool_call":
            body = _render_tool_call_message(m)
        elif role == "tool":
            body = _render_tool_result_message(m)
        else:
            body = (m.content or "").strip()

        lines.append(f"## {heading}")
        lines.append("")
        if body:
            lines.append(body)
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"
