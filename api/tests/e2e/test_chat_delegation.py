"""E2E: multi-agent delegation within a single chat turn (M6).

Drives the REAL ``AgentExecutor.chat()`` path against the test database with
real Agent + Conversation rows and a real ``AutonomousAgentExecutor`` running
the delegated sub-agent. Only the two LLM clients and the model resolver are
stubbed (so the test is deterministic and needs no API key): the primary
agent's stream emits a ``delegate_to_<agent>`` tool call then a final reply,
and the delegated agent's completion returns its answer.

Asserts the full M6 contract end to end:
- ``delegation_started`` / ``delegation_complete`` chunks bracket the call.
- the delegated agent actually ran (its response is carried back).
- the delegated result is persisted as a tool result and the primary
  continues from it (final assistant message saved).
"""

from datetime import datetime, timezone
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, select
from sqlalchemy.orm import selectinload

from src.models.enums import AgentAccessLevel, MessageRole
from src.models.orm import Agent, Conversation, Message
from src.models.orm.organizations import Organization
from src.models.orm.users import User
from src.services.agent_executor import AgentExecutor
from src.services.llm import LLMResponse, LLMStreamChunk, ToolCallRequest

pytestmark = [pytest.mark.e2e]


@pytest_asyncio.fixture
async def delegation_world(
    async_session_factory,
) -> AsyncGenerator[dict, None]:
    """Seed org + user + primary agent + delegated agent + conversation.

    Committed (not flushed) so the fresh sessions opened inside
    ``AgentExecutor`` and ``AutonomousAgentExecutor`` can see the rows; torn
    down explicitly afterwards.
    """
    org_id = uuid4()
    user_id = uuid4()
    delegated_id = uuid4()
    primary_id = uuid4()
    conv_id = uuid4()
    now = datetime.now(timezone.utc)

    async with async_session_factory() as s:
        s.add(
            Organization(
                id=org_id,
                name=f"deleg-org-{org_id.hex[:8]}",
                is_active=True,
                created_by="test@example.com",
                created_at=now,
                updated_at=now,
                default_chat_model="claude-haiku-4-5",
            )
        )
        s.add(
            User(
                id=user_id,
                email=f"deleg-{user_id.hex[:8]}@example.com",
                name="Deleg User",
                is_active=True,
                is_superuser=True,
                is_verified=True,
                is_registered=True,
                organization_id=org_id,
                created_at=now,
                updated_at=now,
            )
        )
        s.add(
            Agent(
                id=delegated_id,
                name=f"Researcher {delegated_id.hex[:6]}",
                description="Researches things",
                system_prompt="You research things.",
                channels=["chat"],
                access_level=AgentAccessLevel.AUTHENTICATED,
                organization_id=org_id,
                is_active=True,
                knowledge_sources=[],
                system_tools=[],
                created_by="test@example.com",
                created_at=now,
                updated_at=now,
            )
        )
        s.add(
            Agent(
                id=primary_id,
                name=f"Coordinator {primary_id.hex[:6]}",
                description="Coordinates",
                system_prompt="You coordinate and delegate.",
                channels=["chat"],
                access_level=AgentAccessLevel.AUTHENTICATED,
                organization_id=org_id,
                is_active=True,
                knowledge_sources=[],
                system_tools=[],
                created_by="test@example.com",
                created_at=now,
                updated_at=now,
            )
        )
        await s.flush()
        # Link the delegation self-M2M.
        primary = (
            await s.execute(
                select(Agent)
                .options(selectinload(Agent.delegated_agents))
                .where(Agent.id == primary_id)
            )
        ).scalar_one()
        delegated = await s.get(Agent, delegated_id)
        primary.delegated_agents.append(delegated)
        s.add(
            Conversation(
                id=conv_id,
                user_id=user_id,
                agent_id=primary_id,
                channel="chat",
                created_at=now,
                updated_at=now,
            )
        )
        await s.commit()

    yield {
        "org_id": org_id,
        "user_id": user_id,
        "primary_id": primary_id,
        "delegated_id": delegated_id,
        "conv_id": conv_id,
    }

    async with async_session_factory() as s:
        await s.execute(delete(Message).where(Message.conversation_id == conv_id))
        await s.execute(delete(Conversation).where(Conversation.id == conv_id))
        # Clear the M2M before deleting agents.
        primary = (
            await s.execute(
                select(Agent)
                .options(selectinload(Agent.delegated_agents))
                .where(Agent.id == primary_id)
            )
        ).scalar_one_or_none()
        if primary is not None:
            primary.delegated_agents.clear()
            await s.flush()
        await s.execute(delete(Agent).where(Agent.id.in_([primary_id, delegated_id])))
        await s.execute(delete(User).where(User.id == user_id))
        await s.execute(delete(Organization).where(Organization.id == org_id))
        await s.commit()


@pytest.mark.asyncio
async def test_delegation_within_turn_end_to_end(
    async_session_factory, delegation_world
):
    world = delegation_world
    delegate_slug = None

    # Load the primary agent (with delegated_agents) so we can compute the
    # delegate tool slug and pass the agent into chat().
    async with async_session_factory() as s:
        primary = (
            await s.execute(
                select(Agent)
                .options(
                    selectinload(Agent.delegated_agents),
                    selectinload(Agent.tools),
                )
                .where(Agent.id == world["primary_id"])
            )
        ).scalar_one()
        conversation = await s.get(Conversation, world["conv_id"])
        from src.services.execution.agent_helpers import agent_delegation_slug

        delegated = primary.delegated_agents[0]
        delegate_slug = agent_delegation_slug(delegated.name)

    # Primary LLM: first stream a delegate tool call, then a final reply.
    primary_state = {"i": 0}

    async def primary_stream(**kwargs):
        idx = primary_state["i"]
        primary_state["i"] += 1
        if idx == 0:
            yield LLMStreamChunk(
                type="tool_call",
                tool_call=ToolCallRequest(
                    id="call_deleg",
                    name=delegate_slug,
                    arguments={"task": "Research the capital of France"},
                ),
            )
            yield LLMStreamChunk(type="done", input_tokens=10, output_tokens=4)
        else:
            yield LLMStreamChunk(
                type="delta", content="Paris, per the Researcher."
            )
            yield LLMStreamChunk(type="done", input_tokens=8, output_tokens=6)

    primary_llm = MagicMock()
    primary_llm.stream = primary_stream
    primary_llm.model_name = "claude-haiku-4-5"
    primary_llm.provider_name = "anthropic"

    # Delegated (autonomous) LLM: returns its answer with no tool calls.
    delegate_llm = AsyncMock()
    delegate_llm.complete = AsyncMock(
        return_value=LLMResponse(
            content="The capital of France is Paris.",
            tool_calls=None,
            finish_reason="end_turn",
            input_tokens=20,
            output_tokens=8,
        )
    )
    delegate_llm.model_name = "claude-haiku-4-5"
    delegate_llm.provider_name = "anthropic"

    choice = MagicMock()
    choice.model_id = "claude-haiku-4-5"
    choice.context_window = 200000

    executor = AgentExecutor(async_session_factory)

    with (
        patch(
            "src.services.agent_executor.get_llm_client",
            AsyncMock(return_value=primary_llm),
        ),
        patch(
            "src.services.execution.autonomous_agent_executor.get_llm_client",
            AsyncMock(return_value=delegate_llm),
        ),
        patch(
            "shared.model_resolver.resolve_model",
            AsyncMock(return_value=choice),
        ),
        patch(
            "shared.model_resolver.model_supports_vision",
            AsyncMock(return_value=False),
        ),
    ):
        chunks = []
        async for chunk in executor.chat(
            agent=primary,
            conversation=conversation,
            user_message="What's the capital of France?",
            enable_routing=False,
        ):
            chunks.append(chunk)

    types = [c.type for c in chunks]
    assert "error" not in types, [c.error for c in chunks if c.type == "error"]
    assert "delegation_started" in types
    assert "delegation_complete" in types
    assert types.index("delegation_started") < types.index("delegation_complete")

    complete = next(c for c in chunks if c.type == "delegation_complete")
    assert complete.delegation is not None
    assert complete.delegation.agent_name == delegated.name
    # The delegated agent actually ran — its answer flows back.
    assert "Paris" in (complete.delegation.response or "")
    assert complete.delegation.error is None

    done = next(c for c in chunks if c.type == "done")
    assert done.content == "Paris, per the Researcher."

    # The delegated result was persisted as a tool result and the primary
    # continued: a TOOL_CALL message for the delegate + a final assistant
    # message exist in the conversation.
    async with async_session_factory() as s:
        rows = (
            await s.execute(
                select(Message).where(Message.conversation_id == world["conv_id"])
            )
        ).scalars().all()
    roles = [m.role for m in rows]
    assert MessageRole.TOOL_CALL in roles
    assert MessageRole.ASSISTANT in roles
    deleg_call = next(
        (m for m in rows if m.tool_name == delegate_slug), None
    )
    assert deleg_call is not None
    assert deleg_call.tool_state == "completed"
