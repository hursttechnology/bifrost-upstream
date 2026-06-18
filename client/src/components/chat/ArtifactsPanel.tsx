/**
 * ArtifactsPanel — a right-side Sheet listing every artifact generated across
 * the active conversation's messages. Each artifact renders through the same
 * inert ArtifactRenderer used inline in the transcript.
 *
 * Messages are read from the persisted API (useMessages) so the panel works
 * regardless of streaming state.
 */

import { Sparkles } from "lucide-react";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useMessages } from "@/hooks/useChat";
import { ArtifactRenderer } from "@/components/chat/ArtifactRenderer";
import type { ArtifactInfo } from "@/services/chatArtifacts";

interface ArtifactsPanelProps {
	conversationId: string | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface FlatArtifact {
	key: string;
	artifact: ArtifactInfo;
}

export function ArtifactsPanel({
	conversationId,
	open,
	onOpenChange,
}: ArtifactsPanelProps) {
	const { data: messages, isLoading } = useMessages(
		open ? conversationId : undefined,
	);

	const artifacts: FlatArtifact[] = (messages ?? []).flatMap((m) =>
		(m.artifacts ?? []).map((artifact, i) => ({
			key: `${m.id}-${i}`,
			artifact,
		})),
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="sm:max-w-2xl flex flex-col p-0 gap-0"
			>
				<SheetHeader className="border-b">
					<SheetTitle className="flex items-center gap-2">
						<Sparkles className="h-4 w-4 text-primary" />
						Artifacts
					</SheetTitle>
					<SheetDescription>
						Files and previews generated in this conversation.
					</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto p-6 space-y-4">
					{!conversationId ? (
						<p className="text-sm text-muted-foreground">
							Open a conversation to see its artifacts.
						</p>
					) : isLoading ? (
						<p className="text-sm text-muted-foreground">
							Loading artifacts…
						</p>
					) : artifacts.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No artifacts yet. Ask the agent to generate a
							document, chart, or file.
						</p>
					) : (
						artifacts.map(({ key, artifact }) => (
							<div
								key={key}
								className="rounded-lg border border-border p-4"
							>
								{artifact.title && (
									<h3 className="mb-2 text-sm font-medium">
										{artifact.title}
									</h3>
								)}
								<ArtifactRenderer
									artifact={artifact}
									conversationId={conversationId}
								/>
							</div>
						))
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
