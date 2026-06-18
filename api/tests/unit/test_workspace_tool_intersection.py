"""Unit tests for the workspace tool-intersection in AgentExecutor (Toolbox).

Proves the chat-ux-design §2.4 rule is actually applied at execution time:
a workspace's ``enabled_tool_ids`` restricts (never expands) the WORKFLOW tools
the LLM sees. System tools, delegation, and MCP tools pass through untouched.

This guards against the prior dead-code state where ``effective_tool_ids`` existed
but was never called in the executor — so a Toolbox toggle had no runtime effect.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from src.services.agent_executor import AgentExecutor
from src.services.llm.base import ToolDefinition


def _tool(name: str) -> ToolDefinition:
    return ToolDefinition(name=name, description=name, parameters={})


def _executor_with_workspace(workspace) -> AgentExecutor:
    """Build an executor whose _db() yields a session returning `workspace`."""
    ex = AgentExecutor.__new__(AgentExecutor)  # bypass __init__ (needs a session factory)

    session = AsyncMock()
    session.get = AsyncMock(return_value=workspace)

    @asynccontextmanager
    async def _db():
        yield session

    ex._db = _db  # type: ignore[method-assign]
    return ex


def _conversation(workspace_id):
    conv = MagicMock()
    conv.workspace_id = workspace_id
    conv.id = uuid4()
    return conv


@pytest.mark.asyncio
async def test_workspace_restricts_workflow_tools():
    wf_keep, wf_drop = uuid4(), uuid4()
    ws = MagicMock()
    ws.enabled_tool_ids = [str(wf_keep)]  # only keep one of the two workflow tools

    ex = _executor_with_workspace(ws)
    ex._tool_workflow_id_map = {"keep_tool": wf_keep, "drop_tool": wf_drop}

    tools = [_tool("keep_tool"), _tool("drop_tool")]
    out = await ex._apply_workspace_tool_intersection(tools, _conversation(uuid4()))

    names = {t.name for t in out}
    assert names == {"keep_tool"}


@pytest.mark.asyncio
async def test_system_and_mcp_tools_are_not_gated():
    wf = uuid4()
    mcp_conn = uuid4()
    ws = MagicMock()
    ws.enabled_tool_ids = []  # restrict ALL workflow tools

    ex = _executor_with_workspace(ws)
    # System tool 'search_knowledge' has no id; an MCP tool carries a connection id
    # but its name is mcp__-prefixed.
    mcp_name = f"mcp__{mcp_conn}__do_thing"
    ex._tool_workflow_id_map = {"wf_tool": wf, mcp_name: mcp_conn}

    tools = [_tool("search_knowledge"), _tool("wf_tool"), _tool(mcp_name)]
    out = await ex._apply_workspace_tool_intersection(tools, _conversation(uuid4()))

    names = {t.name for t in out}
    # wf_tool is gated out; system + MCP survive.
    assert names == {"search_knowledge", mcp_name}


@pytest.mark.asyncio
async def test_no_workspace_is_passthrough():
    ex = _executor_with_workspace(None)
    ex._tool_workflow_id_map = {"a": uuid4()}
    tools = [_tool("a"), _tool("b")]
    out = await ex._apply_workspace_tool_intersection(tools, _conversation(None))
    assert {t.name for t in out} == {"a", "b"}


@pytest.mark.asyncio
async def test_enabled_tool_ids_none_is_passthrough():
    ws = MagicMock()
    ws.enabled_tool_ids = None  # "no restriction" — distinct from empty list
    ex = _executor_with_workspace(ws)
    ex._tool_workflow_id_map = {"a": uuid4()}
    tools = [_tool("a"), _tool("b")]
    out = await ex._apply_workspace_tool_intersection(tools, _conversation(uuid4()))
    assert {t.name for t in out} == {"a", "b"}
