"""Unit tests for M6 multi-agent delegation within a single chat turn.

The primary agent calls a ``delegate_to_<agent>`` tool mid-turn; the delegated
agent runs and its result returns as a tool result the primary continues from.
These tests assert that:

- ``delegation_started`` / ``delegation_complete`` chunks bracket the delegate
  call with the right DelegationInfo payload.
- the delegated result still flows through the normal ``tool_result`` chunk and
  is fed back into the LLM as a tool message (so the primary "continues from"
  it).
- a non-delegation tool call does NOT emit delegation chunks.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from src.models.contracts.agents import ToolResult
from src.services.agent_executor import AgentExecutor
from src.services.llm import LLMStreamChunk, ToolCallRequest


def _make_session_factory():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.flush = AsyncMock()
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=session)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=ctx)


def _make_delegated_agent(name="Researcher"):
    return SimpleNamespace(
        id=uuid4(),
        name=name,
        description="Does research",
        is_active=True,
    )


def _make_primary_agent(delegated):
    return SimpleNamespace(
        id=uuid4(),
        name="Coordinator",
        organization_id=uuid4(),
        system_tools=[],
        llm_model=None,
        llm_max_tokens=None,
        delegated_agents=[delegated],
        tools=[],
    )


def _make_conversation():
    return SimpleNamespace(
        id=uuid4(),
        user_id=uuid4(),
        workspace_id=None,
        current_model=None,
        instructions=None,
        active_leaf_message_id=None,
        compaction_through_sequence=None,
    )


def _stream_factory(tool_calls_by_iter):
    """Build a fake llm_client.stream that yields tool calls then a final reply.

    ``tool_calls_by_iter`` is a list: first call yields those tool calls, the
    second call yields a final text delta + done (loop terminates).
    """
    state = {"i": 0}

    async def stream(**kwargs):
        idx = state["i"]
        state["i"] += 1
        if idx < len(tool_calls_by_iter):
            for tc in tool_calls_by_iter[idx]:
                yield LLMStreamChunk(type="tool_call", tool_call=tc)
            yield LLMStreamChunk(type="done", input_tokens=5, output_tokens=3)
        else:
            yield LLMStreamChunk(type="delta", content="All done.")
            yield LLMStreamChunk(type="done", input_tokens=2, output_tokens=4)

    return stream


@pytest.fixture
def executor():
    return AgentExecutor(_make_session_factory())


async def _drive_chat(executor, agent, conversation, stream_fn):
    """Patch out all the heavy collaborators and collect emitted chunks."""
    saved_msg = SimpleNamespace(id=uuid4())

    llm_client = MagicMock()
    llm_client.stream = stream_fn
    llm_client.model_name = "test-model"
    llm_client.provider_name = "test"

    choice = SimpleNamespace(model_id="test-model", context_window=200000)
    owner = SimpleNamespace(organization_id=agent.organization_id)

    with (
        patch.object(executor, "_get_agent_tools", AsyncMock(return_value=[
            MagicMock(name="delegate_to_researcher"),
        ])),
        patch.object(executor, "_build_message_history", AsyncMock(return_value=[])),
        patch.object(executor, "_save_message", AsyncMock(return_value=saved_msg)),
        patch.object(executor, "_update_tool_call_message", AsyncMock()),
        patch.object(executor, "_record_ai_usage", AsyncMock()),
        patch("src.services.agent_executor.get_llm_client", AsyncMock(return_value=llm_client)),
        patch("shared.model_resolver.resolve_model", AsyncMock(return_value=choice)),
        patch("shared.model_resolver.model_supports_vision", AsyncMock(return_value=False)),
    ):
        # owner lookup + role lookup happen on a _db() session; stub session.get
        # to return the owner and role rows.
        async def fake_get(model, _id):
            return owner

        sess_ctx = executor._session_factory.return_value
        sess = await sess_ctx.__aenter__()
        sess.get = AsyncMock(side_effect=fake_get)
        role_result = MagicMock()
        role_result.all = MagicMock(return_value=[])
        sess.execute = AsyncMock(return_value=role_result)

        chunks = []
        async for chunk in executor.chat(
            agent=agent,
            conversation=conversation,
            user_message="Research X for me",
            enable_routing=False,
        ):
            chunks.append(chunk)
    return chunks


@pytest.mark.asyncio
async def test_delegation_emits_started_and_complete_chunks(executor):
    delegated = _make_delegated_agent("Researcher")
    agent = _make_primary_agent(delegated)
    conversation = _make_conversation()

    tc = ToolCallRequest(
        id="call_1",
        name="delegate_to_researcher",
        arguments={"task": "Find facts about X"},
    )

    # The delegate tool execution returns the sub-agent's response envelope.
    exec_result = ToolResult(
        tool_call_id="call_1",
        tool_name="delegate_to_researcher",
        result={"response": "Here are the facts.", "agent": "Researcher"},
        error=None,
        duration_ms=42,
    )

    with patch.object(executor, "_execute_tool", AsyncMock(return_value=exec_result)):
        chunks = await _drive_chat(
            executor, agent, conversation, _stream_factory([[tc]])
        )

    types = [c.type for c in chunks]
    assert "delegation_started" in types
    assert "delegation_complete" in types
    # started precedes the tool_result which precedes complete
    assert types.index("delegation_started") < types.index("tool_result")
    assert types.index("tool_result") < types.index("delegation_complete")

    started = next(c for c in chunks if c.type == "delegation_started")
    assert started.delegation is not None
    assert started.delegation.agent_name == "Researcher"
    assert started.delegation.agent_id == str(delegated.id)
    assert started.delegation.task == "Find facts about X"
    assert started.delegation.response is None

    complete = next(c for c in chunks if c.type == "delegation_complete")
    assert complete.delegation is not None
    assert complete.delegation.agent_name == "Researcher"
    assert complete.delegation.response == "Here are the facts."
    assert complete.delegation.error is None
    assert complete.delegation.duration_ms == 42

    # The primary "continues from" the delegated result: the loop ran a second
    # LLM turn and produced a final reply.
    done = next(c for c in chunks if c.type == "done")
    assert done.content == "All done."


@pytest.mark.asyncio
async def test_non_delegation_tool_emits_no_delegation_chunks(executor):
    delegated = _make_delegated_agent("Researcher")
    agent = _make_primary_agent(delegated)
    conversation = _make_conversation()

    tc = ToolCallRequest(
        id="call_1",
        name="some_workflow_tool",
        arguments={"foo": "bar"},
    )
    exec_result = ToolResult(
        tool_call_id="call_1",
        tool_name="some_workflow_tool",
        result={"ok": True},
        error=None,
        duration_ms=10,
    )

    with patch.object(executor, "_execute_tool", AsyncMock(return_value=exec_result)):
        chunks = await _drive_chat(
            executor, agent, conversation, _stream_factory([[tc]])
        )

    types = [c.type for c in chunks]
    assert "delegation_started" not in types
    assert "delegation_complete" not in types
    assert "tool_result" in types
