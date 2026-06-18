/**
 * ToolboxPanel — the active agent's capabilities surface for the current
 * conversation/workspace (chat-toolbox design, 2026-06-18).
 *
 * A right-side Sheet, opened from the chat sidebar's Toolbox nav button. It is
 * conversation-scoped and workspace-aware: it shows the effective tool set the
 * agent brings to THIS chat, and — when the conversation lives in a workspace —
 * lets the user restrict which workflow tools are enabled.
 *
 * Sections:
 *   1. Workflow tools  — toggleable (writes workspace.enabled_tool_ids) when the
 *                        conversation has a workspace; read-only otherwise.
 *   2. System tools    — read-only (agent.system_tools).
 *   3. Delegated agents — read-only, names resolved from the agents list.
 *   4. Knowledge       — read-only (agent.knowledge_sources).
 *   5. MCP             — read-only count (agent.mcp_connection_ids).
 *
 * Workspaces only NARROW an agent's tool set (chat-UX §2.4):
 *   effective = agent.tool_ids ∩ workspace.enabled_tool_ids.
 * The `enabled_tool_ids === null` (no-restriction = all-on) semantics are
 * handled in `@/services/chatToolbox` — see computeNextEnabledToolIds.
 */

import {
	Boxes,
	BrainCircuit,
	Hammer,
	Plug,
	Users,
	Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useAgent, useAgents } from "@/hooks/useAgents";
import { useConversation } from "@/hooks/useChat";
import {
	computeNextEnabledToolIds,
	isToolEnabled,
	useAgentToolList,
	type AgentToolInfo,
} from "@/services/chatToolbox";
import {
	useUpdateWorkspace,
	useWorkspace,
} from "@/services/workspaceService";

interface ToolboxPanelProps {
	conversationId: string | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ToolboxPanel({
	conversationId,
	open,
	onOpenChange,
}: ToolboxPanelProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="sm:max-w-2xl flex flex-col p-0 gap-0"
			>
				<SheetHeader className="border-b">
					<SheetTitle className="flex items-center gap-2">
						<Hammer className="h-4 w-4 text-primary" />
						Toolbox
					</SheetTitle>
					<SheetDescription>
						What the active agent can do in this chat. Toggle workflow
						tools to restrict them for the workspace.
					</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto p-6 space-y-6">
					{!conversationId ? (
						<p className="text-sm text-muted-foreground">
							Open a conversation to see its agent's toolbox.
						</p>
					) : (
						open && <ToolboxBody conversationId={conversationId} />
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

/** A titled section with an icon header. */
function Section({
	icon: Icon,
	title,
	count,
	children,
}: {
	icon: typeof Wrench;
	title: string;
	count?: number;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<h3 className="flex items-center gap-2 text-sm font-medium">
				<Icon className="h-4 w-4 text-muted-foreground" />
				{title}
				{count !== undefined && (
					<Badge variant="secondary" className="text-[10px]">
						{count}
					</Badge>
				)}
			</h3>
			{children}
		</section>
	);
}

function ToolboxBody({ conversationId }: { conversationId: string }) {
	const { data: conversation, isLoading: convLoading } =
		useConversation(conversationId);

	const agentId = conversation?.agent_id ?? undefined;
	const workspaceId = conversation?.workspace_id ?? undefined;

	const { data: agent, isLoading: agentLoading } = useAgent(agentId);
	const { data: tools, isLoading: toolsLoading } = useAgentToolList(agentId);
	const { data: workspace } = useWorkspace(workspaceId);
	const { data: agentList } = useAgents();
	const updateWorkspace = useUpdateWorkspace();

	if (convLoading || agentLoading) {
		return (
			<p className="text-sm text-muted-foreground">Loading toolbox…</p>
		);
	}

	if (!agentId || !agent) {
		return (
			<p className="text-sm text-muted-foreground">
				This conversation has no agent yet. Send a message to assign one.
			</p>
		);
	}

	const allToolIds = (tools ?? []).map((t) => t.id);
	const enabledToolIds = workspace?.enabled_tool_ids;
	const hasWorkspace = !!workspaceId;

	const handleToggle = (tool: AgentToolInfo, nextEnabled: boolean) => {
		if (!workspaceId) return;
		const next = computeNextEnabledToolIds(
			allToolIds,
			enabledToolIds,
			tool.id,
			nextEnabled,
		);
		updateWorkspace.mutate(
			{
				params: { path: { workspace_id: workspaceId } },
				body: { enabled_tool_ids: next },
			},
			{
				onError: (err) =>
					toast.error("Could not update tool", {
						description: (err as Error)?.message,
					}),
			},
		);
	};

	// Resolve delegated agent ids → names from the agents list.
	const nameById = new Map(
		(agentList ?? []).map((a) => [a.id, a.name] as const),
	);
	const delegated = agent.delegated_agent_ids ?? [];
	const systemTools = agent.system_tools ?? [];
	const knowledge = agent.knowledge_sources ?? [];
	const mcpCount = (agent.mcp_connection_ids ?? []).length;

	return (
		<>
			{/* 1. Workflow tools */}
			<Section icon={Wrench} title="Workflow tools" count={tools?.length}>
				{!hasWorkspace && (
					<p className="text-xs text-muted-foreground">
						Tool restrictions apply to workspace chats.
					</p>
				)}
				{toolsLoading ? (
					<p className="text-sm text-muted-foreground">
						Loading tools…
					</p>
				) : (tools?.length ?? 0) === 0 ? (
					<p className="text-sm text-muted-foreground">
						This agent has no workflow tools.
					</p>
				) : (
					<div className="space-y-1">
						{tools!.map((tool) => {
							const enabled = isToolEnabled(
								tool.id,
								enabledToolIds,
							);
							return (
								<div
									key={tool.id}
									className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
								>
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium truncate">
												{tool.name}
											</span>
											{tool.category && (
												<Badge
													variant="outline"
													className="text-[10px] shrink-0"
												>
													{tool.category}
												</Badge>
											)}
										</div>
										{tool.description && (
											<p className="text-xs text-muted-foreground line-clamp-2">
												{tool.description}
											</p>
										)}
									</div>
									{hasWorkspace && (
										<Switch
											checked={enabled}
											disabled={updateWorkspace.isPending}
											onCheckedChange={(v) =>
												handleToggle(tool, v)
											}
											aria-label={`Toggle ${tool.name}`}
										/>
									)}
								</div>
							);
						})}
					</div>
				)}
			</Section>

			{/* 2. System tools */}
			<Section
				icon={Boxes}
				title="System tools"
				count={systemTools.length}
			>
				{systemTools.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No system tools.
					</p>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{systemTools.map((name) => (
							<Badge
								key={name}
								variant="secondary"
								className="gap-1 font-normal"
							>
								<Wrench className="h-3 w-3 text-muted-foreground" />
								{name}
							</Badge>
						))}
					</div>
				)}
			</Section>

			{/* 3. Delegated agents */}
			<Section
				icon={Users}
				title="Delegated agents"
				count={delegated.length}
			>
				{delegated.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No delegated agents.
					</p>
				) : (
					<ul className="space-y-1">
						{delegated.map((id) => (
							<li
								key={id}
								className="text-sm text-foreground/90 rounded-md border border-border px-3 py-1.5"
							>
								{nameById.get(id) ?? id}
							</li>
						))}
					</ul>
				)}
			</Section>

			{/* 4. Knowledge */}
			<Section
				icon={BrainCircuit}
				title="Knowledge"
				count={knowledge.length}
			>
				{knowledge.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No knowledge sources.
					</p>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{knowledge.map((src) => (
							<Badge
								key={src}
								variant="outline"
								className="font-normal"
							>
								{src}
							</Badge>
						))}
					</div>
				)}
			</Section>

			{/* 5. MCP */}
			<Section icon={Plug} title="MCP">
				<p className="text-sm text-muted-foreground">
					{mcpCount === 0
						? "No MCP connections."
						: `${mcpCount} MCP connection${mcpCount === 1 ? "" : "s"}.`}
				</p>
			</Section>
		</>
	);
}
