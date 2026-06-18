/**
 * Component tests for ToolboxPanel.
 *
 * Covers:
 *   - Closed sheet renders nothing
 *   - No-conversation copy
 *   - Workflow tools render with toggles when the conversation has a workspace
 *   - Toggling a tool OFF from the null (all-on) state materializes the
 *     allowlist to "all agent tools except the one turned off" via PATCH
 *   - No-workspace conversation hides toggles and shows the read-only note
 *   - System tools / delegated agents (name-resolved) / knowledge / MCP render
 *
 * All data hooks are mocked so nothing hits the network. (Radix Sheet/Switch
 * portal behaviour is jsdom-approximate — the lead browser-verifies the live
 * panel; see the report.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "@/test-utils";

// --- mock refs ----------------------------------------------------------

const conversationRef: { data: Record<string, unknown> | undefined } = {
	data: undefined,
};
const agentRef: { data: Record<string, unknown> | undefined } = {
	data: undefined,
};
const toolsRef: { data: unknown[] | undefined; isLoading: boolean } = {
	data: [],
	isLoading: false,
};
const workspaceRef: { data: Record<string, unknown> | undefined } = {
	data: undefined,
};
const agentsListRef: { data: Array<Record<string, unknown>> | undefined } = {
	data: [],
};
const mockUpdateMutate = vi.fn();

vi.mock("@/hooks/useChat", () => ({
	useConversation: () => ({
		data: conversationRef.data,
		isLoading: false,
	}),
}));

vi.mock("@/hooks/useAgents", () => ({
	useAgent: () => ({ data: agentRef.data, isLoading: false }),
	useAgents: () => ({ data: agentsListRef.data }),
}));

vi.mock("@/services/workspaceService", () => ({
	useWorkspace: () => ({ data: workspaceRef.data }),
	useUpdateWorkspace: () => ({
		mutate: mockUpdateMutate,
		isPending: false,
	}),
}));

// Real chatToolbox (pure helpers) but a stubbed query hook returning typed rows.
vi.mock("@/services/chatToolbox", async () => {
	const actual =
		await vi.importActual<typeof import("@/services/chatToolbox")>(
			"@/services/chatToolbox",
		);
	return {
		...actual,
		useAgentToolList: () => ({
			data: toolsRef.data,
			isLoading: toolsRef.isLoading,
		}),
	};
});

import { ToolboxPanel } from "./ToolboxPanel";

function tool(overrides: Record<string, unknown>) {
	return {
		id: "t1",
		name: "Lookup",
		description: "Looks things up",
		category: "data",
		...overrides,
	};
}

beforeEach(() => {
	conversationRef.data = {
		id: "c1",
		agent_id: "a1",
		workspace_id: "w1",
	};
	agentRef.data = {
		id: "a1",
		name: "SupportBot",
		system_tools: ["web_search"],
		delegated_agent_ids: ["a2"],
		knowledge_sources: ["kb-handbook"],
		mcp_connection_ids: ["m1", "m2"],
	};
	toolsRef.data = [
		tool({ id: "t1", name: "Lookup" }),
		tool({ id: "t2", name: "CreateTicket", category: null }),
	];
	toolsRef.isLoading = false;
	workspaceRef.data = { id: "w1", enabled_tool_ids: null };
	agentsListRef.data = [{ id: "a2", name: "BillingBot" }];
	mockUpdateMutate.mockReset();
});

describe("ToolboxPanel — open/empty", () => {
	it("renders nothing when closed", () => {
		renderWithProviders(
			<ToolboxPanel
				conversationId="c1"
				open={false}
				onOpenChange={() => {}}
			/>,
		);
		expect(screen.queryByText("Toolbox")).not.toBeInTheDocument();
	});

	it("prompts to open a conversation when none is selected", () => {
		renderWithProviders(
			<ToolboxPanel
				conversationId={undefined}
				open
				onOpenChange={() => {}}
			/>,
		);
		expect(
			screen.getByText(/open a conversation to see/i),
		).toBeInTheDocument();
	});
});

describe("ToolboxPanel — workflow tools (workspace chat)", () => {
	it("renders the agent's tools with toggles", () => {
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		expect(screen.getByText("Lookup")).toBeInTheDocument();
		expect(screen.getByText("CreateTicket")).toBeInTheDocument();
		// Two switches (one per tool).
		expect(screen.getByLabelText("Toggle Lookup")).toBeInTheDocument();
		expect(screen.getByLabelText("Toggle CreateTicket")).toBeInTheDocument();
	});

	it("materializes the allowlist on the first toggle-off from null", () => {
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		// Toggling 't2' off from null must PATCH ['t1'] — every agent tool
		// except the one turned off.
		fireEvent.click(screen.getByLabelText("Toggle CreateTicket"));
		expect(mockUpdateMutate).toHaveBeenCalledWith(
			{
				params: { path: { workspace_id: "w1" } },
				body: { enabled_tool_ids: ["t1"] },
			},
			expect.anything(),
		);
	});

	it("shows a disabled tool as toggled off (intersection display)", () => {
		workspaceRef.data = { id: "w1", enabled_tool_ids: ["t1"] };
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		expect(screen.getByLabelText("Toggle Lookup")).toBeChecked();
		expect(screen.getByLabelText("Toggle CreateTicket")).not.toBeChecked();
	});
});

describe("ToolboxPanel — no-workspace conversation", () => {
	it("hides toggles and shows the read-only note", () => {
		conversationRef.data = {
			id: "c1",
			agent_id: "a1",
			workspace_id: null,
		};
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		expect(screen.getByText("Lookup")).toBeInTheDocument();
		expect(
			screen.getByText(/tool restrictions apply to workspace chats/i),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Toggle Lookup")).not.toBeInTheDocument();
	});
});

describe("ToolboxPanel — read-only sections", () => {
	it("lists system tools, delegated agent names, knowledge, and MCP count", () => {
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		expect(screen.getByText("web_search")).toBeInTheDocument();
		// Delegated id a2 resolves to its name.
		expect(screen.getByText("BillingBot")).toBeInTheDocument();
		expect(screen.getByText("kb-handbook")).toBeInTheDocument();
		expect(screen.getByText(/2 MCP connections/i)).toBeInTheDocument();
	});

	it("falls back to the id when a delegated agent name is unknown", () => {
		agentsListRef.data = [];
		renderWithProviders(
			<ToolboxPanel conversationId="c1" open onOpenChange={() => {}} />,
		);
		expect(screen.getByText("a2")).toBeInTheDocument();
	});
});
