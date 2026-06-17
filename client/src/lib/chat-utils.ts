// client/src/lib/chat-utils.ts
/**
 * Chat message utility functions for unified message model
 */

import type { components } from "@/lib/v1";

type MessagePublic = components["schemas"]["MessagePublic"];

/**
 * Extended message type with streaming state flags
 */
export interface UnifiedMessage extends MessagePublic {
  isStreaming?: boolean;
  isOptimistic?: boolean;
  isFinal?: boolean;
  localId?: string; // Client-generated ID for dedup
  // Tool call fields (for role: "tool_call")
  tool_state?: "running" | "completed" | "error";
  tool_result?: unknown;
  tool_input?: Record<string, unknown>;
}

/**
 * Compute the model's current working-context size from a message list.
 *
 * The relevant number for a context-budget indicator is what the model saw
 * on its most recent turn — i.e. the latest assistant message's input-token
 * count (which already includes system prompt + history + the new user turn).
 * Cumulative input+output across the whole conversation would over-count,
 * since each turn re-sends the prior context. Returns 0 when no assistant
 * message has reported an input count yet.
 */
export function computeContextUsage(
  messages: Pick<MessagePublic, "role" | "token_count_input">[],
): number {
  let usage = 0;
  for (const m of messages) {
    if (m.role === "assistant" && typeof m.token_count_input === "number") {
      usage = m.token_count_input; // last writer wins → most recent turn
    }
  }
  return usage;
}

export type BudgetTone = "muted" | "primary" | "destructive";

export interface BudgetState {
  /** Tokens currently in the model's working context. */
  used: number;
  /** The model's full context window, or null when unknown. */
  window: number | null;
  /** Fraction 0..1 of the window in use, or null when window unknown. */
  fraction: number | null;
  /** Whether the percentage crossed the compaction-warning line (≥85%). */
  tone: BudgetTone;
}

/**
 * Map raw usage + window into the indicator's visual state (§16.5):
 *   <70% muted · 70-85% primary · ≥85% destructive.
 * Window unknown → muted with a null fraction (bar renders empty).
 */
export function budgetState(used: number, window: number | null): BudgetState {
  if (!window || window <= 0) {
    return { used, window: null, fraction: null, tone: "muted" };
  }
  const fraction = Math.min(used / window, 1);
  const tone: BudgetTone =
    fraction >= 0.85 ? "destructive" : fraction >= 0.7 ? "primary" : "muted";
  return { used, window, fraction, tone };
}

/**
 * Compact token formatting for the budget bar: 980 → "980", 12450 → "12k",
 * 1_250_000 → "1.3M". Tuned for terse header display, not exactness.
 */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}k`;
  }
  return String(count);
}

/**
 * Generate a stable UUID for client-side messages
 */
export function generateMessageId(): string {
  const browserCrypto = globalThis.crypto;

  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }

  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  return `fallback-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Generate a local ID for client-side deduplication
 * This is sent to the server and echoed back to match optimistic messages
 */
export function generateLocalId(): string {
  return `local-${generateMessageId()}`;
}

/**
 * Normalize content for comparison (trim whitespace, collapse multiple spaces)
 * Helps match optimistic messages to server messages even with minor formatting differences
 */
export function normalizeContent(content: string | null | undefined): string {
  if (!content) return "";
  return content.trim().replace(/\s+/g, " ");
}

/**
 * Merge two messages, preserving content if incoming is empty
 */
export function mergeMessages(
  existing: UnifiedMessage,
  incoming: UnifiedMessage
): UnifiedMessage {
  // Preserve existing content if incoming is empty
  const shouldKeepExistingContent =
    (!incoming.content || incoming.content.trim().length === 0) &&
    existing.content &&
    existing.content.trim().length > 0;

  // Deep merge tool_calls
  const mergedToolCalls = incoming.tool_calls ?? existing.tool_calls;

  // Filter out undefined values from incoming so they don't overwrite
  // existing API data (e.g. token_count_input, model, duration_ms)
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, v]) => v !== undefined)
  );

  return {
    ...existing,
    ...definedIncoming,
    content: shouldKeepExistingContent ? existing.content : incoming.content,
    tool_calls: mergedToolCalls,
    // Preserve earliest createdAt
    created_at:
      new Date(existing.created_at).getTime() <
      new Date(incoming.created_at).getTime()
        ? existing.created_at
        : incoming.created_at,
    // Use latest streaming state
    isStreaming: incoming.isStreaming ?? existing.isStreaming,
    isFinal: incoming.isFinal ?? existing.isFinal,
    isOptimistic: incoming.isOptimistic ?? existing.isOptimistic,
  };
}

/**
 * Integrate incoming messages into existing array
 * - Deduplication is now handled by the chat store's dedupStateByConversation
 * - This function just merges and sorts for consistency
 */
export function integrateMessages(
  existing: UnifiedMessage[],
  incoming: UnifiedMessage[]
): UnifiedMessage[] {
  const byId = new Map<string, UnifiedMessage>();

  // Index existing messages
  existing.forEach((m) => {
    byId.set(m.id, m);
  });

  // Merge incoming (updates existing, adds new)
  incoming.forEach((m) => {
    const existingMsg = byId.get(m.id);
    if (existingMsg) {
      byId.set(m.id, mergeMessages(existingMsg, m));
    } else {
      byId.set(m.id, m);
    }
  });

  // Sort by createdAt + ID for stability
  return Array.from(byId.values()).sort((a, b) => {
    const timeDiff =
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
  });
}
