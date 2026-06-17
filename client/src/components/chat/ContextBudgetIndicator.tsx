/**
 * ContextBudgetIndicator (§16.5)
 *
 * Real-time, model-aware context-budget bar for the conversation header.
 * Shows `used / window` tokens with a mini progress bar whose colour tracks
 * the budget tone (muted <70%, primary 70-85%, destructive ≥85%). The window
 * comes from the platform-model catalog for the conversation's current model;
 * usage is the most recent assistant turn's input-token count.
 *
 * Renders nothing until there's a known window — an empty bar communicates
 * nothing useful and would just be header noise on a brand-new chat.
 */

import { useMemo } from "react";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	budgetState,
	computeContextUsage,
	formatCompactTokens,
	type BudgetTone,
} from "@/lib/chat-utils";
import type { components } from "@/lib/v1";

type MessagePublic = components["schemas"]["MessagePublic"];

const TONE_BAR: Record<BudgetTone, string> = {
	muted: "bg-muted-foreground/50",
	primary: "bg-primary",
	destructive: "bg-destructive",
};

const TONE_TEXT: Record<BudgetTone, string> = {
	muted: "text-muted-foreground",
	primary: "text-primary",
	destructive: "text-destructive",
};

interface ContextBudgetIndicatorProps {
	messages: MessagePublic[];
	/** The model's full context window in tokens, or null when unknown. */
	contextWindow: number | null;
	className?: string;
}

export function ContextBudgetIndicator({
	messages,
	contextWindow,
	className,
}: ContextBudgetIndicatorProps) {
	const state = useMemo(() => {
		const used = computeContextUsage(messages);
		return budgetState(used, contextWindow);
	}, [messages, contextWindow]);

	// Nothing to show until we know the window and have used some budget.
	if (state.window === null || state.used === 0) return null;

	const pct = Math.round((state.fraction ?? 0) * 100);

	return (
		<TooltipProvider delayDuration={200}>
			<Tooltip>
				<TooltipTrigger asChild>
					<div
						className={cn(
							"hidden sm:flex items-center gap-2 shrink-0 cursor-default",
							className,
						)}
						aria-label={`Context budget: ${pct}% used`}
					>
						<div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
							<div
								className={cn(
									"h-full rounded-full transition-all",
									TONE_BAR[state.tone],
								)}
								style={{ width: `${pct}%` }}
							/>
						</div>
						<span
							className={cn(
								"text-[10px] font-mono tabular-nums",
								TONE_TEXT[state.tone],
							)}
						>
							{formatCompactTokens(state.used)} /{" "}
							{formatCompactTokens(state.window)}
						</span>
					</div>
				</TooltipTrigger>
				<TooltipContent>
					{pct}% of the model's {formatCompactTokens(state.window)}-token
					context window in use.
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
