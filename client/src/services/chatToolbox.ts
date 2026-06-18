/**
 * Chat Toolbox service.
 *
 * Typed access to an agent's bound workflow tools (`GET /api/agents/{id}/tools`)
 * plus the pure helper that computes a workspace's new `enabled_tool_ids` array
 * when a single tool is toggled.
 *
 * The toolbox is conversation-scoped: it shows the active agent's capabilities
 * for the current workspace and lets the user restrict which workflow tools are
 * enabled. Workspaces can only narrow an agent's tool set, never expand it.
 *
 * `enabled_tool_ids` semantics on the workspace (the subtle correctness point):
 *   - `null` / `undefined` → NO restriction; every one of the agent's tools is
 *     enabled. This is the default state for a fresh workspace.
 *   - an array → the explicit allowlist; only those ids are enabled.
 *
 * Because `null` means "all on", the first time a user toggles a tool OFF we
 * must MATERIALIZE the allowlist as "all of the agent's workflow tool ids except
 * the one being turned off" — otherwise sending `[]` or a single id would read
 * as "only this is on", silently disabling everything else.
 */

import { $api } from "@/lib/api-client";

/**
 * One workflow tool bound to an agent. The backend
 * (`get_agent_tools` in `api/src/routers/agents.py`) returns untyped dicts of
 * exactly this shape; we type them here for the toolbox UI.
 */
export interface AgentToolInfo {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
}

/**
 * Fetch an agent's bound workflow tools, typed as {@link AgentToolInfo}.
 * Disabled while `agentId` is undefined.
 */
export function useAgentToolList(agentId: string | undefined) {
	return $api.useQuery(
		"get",
		"/api/agents/{agent_id}/tools",
		{ params: { path: { agent_id: agentId ?? "" } } },
		{
			enabled: !!agentId,
			// The endpoint is typed as `Record<string, unknown>[]`; the rows are
			// always the AgentToolInfo shape (see backend docstring above).
			select: (rows): AgentToolInfo[] =>
				(rows as Array<Record<string, unknown>>).map((r) => ({
					id: String(r.id),
					name: String(r.name ?? ""),
					description:
						r.description == null ? null : String(r.description),
					category: r.category == null ? null : String(r.category),
				})),
		},
	);
}

/**
 * Decide whether a tool is currently enabled for a workspace, honoring the
 * null-means-all rule. `enabledToolIds === null/undefined` → every tool is
 * enabled; otherwise only ids present in the array are.
 */
export function isToolEnabled(
	toolId: string,
	enabledToolIds: string[] | null | undefined,
): boolean {
	if (enabledToolIds == null) return true;
	return enabledToolIds.includes(toolId);
}

/**
 * Compute the new `enabled_tool_ids` array after toggling a single tool.
 *
 * @param allAgentToolIds  Every workflow-tool id the agent has (the full set
 *                         we materialize from when `current` is null).
 * @param current          The workspace's existing `enabled_tool_ids`
 *                         (`null`/`undefined` = no restriction = all enabled).
 * @param toolId           The tool being toggled.
 * @param nextEnabled      The desired state after the toggle.
 *
 * Returns the full array to PATCH onto the workspace. When toggling the FIRST
 * tool off from the null (all-on) state, the array is materialized to "all
 * agent tool ids except the one turned off" so the remaining tools stay
 * enabled.
 */
export function computeNextEnabledToolIds(
	allAgentToolIds: string[],
	current: string[] | null | undefined,
	toolId: string,
	nextEnabled: boolean,
): string[] {
	// Materialize the baseline. null/undefined means "all agent tools enabled",
	// so the starting allowlist is the agent's full tool set; an existing array
	// is used as-is (restricted to ids the agent actually has).
	const base =
		current == null
			? [...allAgentToolIds]
			: current.filter((id) => allAgentToolIds.includes(id));

	const set = new Set(base);
	if (nextEnabled) {
		set.add(toolId);
	} else {
		set.delete(toolId);
	}
	// Preserve agent tool order for a stable, predictable array.
	return allAgentToolIds.filter((id) => set.has(id));
}
