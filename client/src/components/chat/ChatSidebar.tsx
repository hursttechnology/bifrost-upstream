/**
 * ChatSidebar Component
 *
 * Primary nav stays put: + New chat, Workspaces, Toolbox (placeholder),
 * Artifacts (opens the per-conversation artifacts panel). When a workspace is
 * active the `Workspaces` row
 * swaps for a workspace-identity row with an exit `×` and a settings gear.
 *
 * Recent shows:
 *   - In workspace mode → only that workspace's chats.
 *   - Unscoped → only general-pool chats (workspace_id IS NULL). Workspace
 *     chats are reachable by entering the workspace.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	ChevronRight,
	Download,
	FileJson,
	FileText,
	FolderKanban,
	FolderInput,
	Hammer,
	MessageSquare,
	MoreHorizontal,
	Pencil,
	Plus,
	Search,
	Settings2,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	useConversations,
	useCreateConversation,
	useDeleteConversation,
	useUpdateConversation,
} from "@/hooks/useChat";
import { exportConversation } from "@/services/chatExport";
import { ArtifactsPanel } from "@/components/chat/ArtifactsPanel";
import type { ConversationSummary } from "@/hooks/useChat";
import { cn } from "@/lib/utils";
import {
	useMoveConversation,
	useWorkspaces,
	type Workspace,
} from "@/services/workspaceService";
import { useChatStore } from "@/stores/chatStore";
import { toast } from "sonner";

interface ChatSidebarProps {
	className?: string;
	/** When set, the sidebar enters workspace mode (re-scoped). */
	activeWorkspace?: Workspace | null;
	/** Triggered when the user opens the workspace settings Sheet. */
	onOpenWorkspaceSettings?: () => void;
	/** Mobile: close the sidebar overlay. */
	onClose?: () => void;
	/** Mobile: a conversation was chosen — collapse the overlay. */
	onConversationSelected?: () => void;
}

/**
 * Inline rename editor (§8.1). Self-focuses on mount, deferred a tick so the
 * dropdown menu's focus-restore (radix returns focus to the trigger on close)
 * doesn't fight it. Enter commits; Escape or losing focus cancels (reverts) —
 * commit is an explicit Enter, which keeps the focus-restore race from ever
 * persisting an unintended rename.
 */
function RenameInput({
	initial,
	onCommit,
	onCancel,
}: {
	initial: string;
	onCommit: (value: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	const settled = useRef(false);
	// Becomes true only after focus has settled. Guards against the spurious
	// focusout that fires synchronously when focus first moves into the field
	// (and the dropdown menu's focus-restore race) — without it the editor
	// would cancel itself before the user types. Commit is always an explicit
	// Enter; blur (click-away) discards, matching a standard inline editor.
	const ready = useRef(false);

	useEffect(() => {
		// The editor mounts as the dropdown menu closes. Radix restores focus
		// to the (now-unmounted) trigger during its close, which steals focus
		// from us on the first attempt — so re-assert focus across a few frames
		// until it lands, then arm blur-to-cancel. Without the retry the input
		// mounts but never holds focus (jsdom doesn't reproduce this race, so
		// the unit test can't catch it — verified in a real browser).
		let frame = 0;
		let raf = 0;
		const tryFocus = () => {
			const el = ref.current;
			if (!el) return;
			if (document.activeElement !== el && frame < 10) {
				el.focus();
				el.select();
				frame += 1;
				raf = requestAnimationFrame(tryFocus);
				return;
			}
			// Focus has landed (or we gave up gracefully); arm blur-to-cancel
			// on the next tick so the close-race focusout doesn't trip it.
			setTimeout(() => {
				ready.current = true;
			}, 0);
		};
		raf = requestAnimationFrame(tryFocus);
		return () => cancelAnimationFrame(raf);
	}, []);

	const finish = (commit: boolean, next: string) => {
		if (settled.current) return; // guard double-fire (Enter → blur)
		settled.current = true;
		if (commit) onCommit(next);
		else onCancel();
	};

	return (
		<Input
			ref={ref}
			value={value}
			aria-label="Rename conversation"
			className="h-6 px-1.5 py-0 text-sm"
			onClick={(e) => e.stopPropagation()}
			onChange={(e) => setValue(e.target.value)}
			onBlur={() => {
				if (ready.current) finish(false, value);
			}}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Enter") {
					finish(true, e.currentTarget.value);
				} else if (e.key === "Escape") {
					finish(false, value);
				}
			}}
		/>
	);
}

export function ChatSidebar({
	className,
	activeWorkspace,
	onOpenWorkspaceSettings,
	onClose,
	onConversationSelected,
}: ChatSidebarProps) {
	const navigate = useNavigate();
	const [searchTerm, setSearchTerm] = useState("");
	const [deleteTarget, setDeleteTarget] =
		useState<ConversationSummary | null>(null);
	// Inline rename (§8.1): the id currently being renamed (draft lives in
	// the RenameInput child).
	const [renamingId, setRenamingId] = useState<string | null>(null);
	// Set when Rename is chosen so the dropdown's onCloseAutoFocus can suppress
	// Radix's focus-restore (which would otherwise blur-cancel the new editor).
	const renameIntent = useRef<string | null>(null);
	// Artifacts panel (lists every artifact in the active conversation).
	const [artifactsOpen, setArtifactsOpen] = useState(false);

	const { activeConversationId, setActiveConversation, setActiveAgent } =
		useChatStore();

	const inWorkspaceMode = !!activeWorkspace;

	// Pool filter: in workspace mode → that workspace; else → general pool only.
	const { data: conversations, isLoading: isLoadingConversations } =
		useConversations(
			inWorkspaceMode
				? { workspaceId: activeWorkspace.id }
				: { pool: "general" },
		);

	const createConversation = useCreateConversation();
	const deleteConversation = useDeleteConversation();
	const updateConversation = useUpdateConversation();
	const moveConversation = useMoveConversation();
	const { data: workspacesForMove } = useWorkspaces();

	const filteredConversations = conversations?.filter((c) => {
		if (!searchTerm) return true;
		const term = searchTerm.toLowerCase();
		return (
			c.title?.toLowerCase().includes(term) ||
			c.agent_name?.toLowerCase().includes(term) ||
			c.last_message_preview?.toLowerCase().includes(term)
		);
	});

	const handleNewChat = () => {
		setActiveConversation(null);
		setActiveAgent(null);
		if (activeWorkspace) {
			// Workspace chats must be created up-front so the conversation is
			// bound to the workspace (the deferred create in ChatWindow has no
			// workspace context).
			createConversation.mutate(
				{
					body: {
						channel: "chat",
						workspace_id: activeWorkspace.id,
					},
				},
				{
					onSuccess: (data) => {
						navigate(
							`/chat/${data.id}?workspace=${activeWorkspace.id}`,
						);
						onConversationSelected?.();
					},
				},
			);
			return;
		}
		navigate("/chat");
		onConversationSelected?.();
	};

	const handleSelectConversation = (conv: ConversationSummary) => {
		setActiveConversation(conv.id);
		setActiveAgent(conv.agent_id ?? null);
		// Update URL to enable bookmarking/sharing
		navigate(
			inWorkspaceMode
				? `/chat/${conv.id}?workspace=${activeWorkspace.id}`
				: `/chat/${conv.id}`,
		);
		onConversationSelected?.();
	};

	const handleDeleteConfirm = () => {
		if (deleteTarget) {
			const wasActive = activeConversationId === deleteTarget.id;
			deleteConversation.mutate({
				params: { path: { conversation_id: deleteTarget.id } },
			});
			setDeleteTarget(null);
			if (wasActive) {
				navigate(
					inWorkspaceMode
						? `/chat?workspace=${activeWorkspace.id}`
						: "/chat",
				);
			}
		}
	};

	const handleMove = (conv: ConversationSummary, target: string | null) => {
		moveConversation.mutate(
			{
				params: { path: { conversation_id: conv.id } },
				body: { workspace_id: target },
			},
			{
				onSuccess: () => {
					toast.success(
						target
							? "Moved to workspace"
							: "Moved to general chats",
					);
				},
				onError: (err) =>
					toast.error("Move failed", {
						description: (err as Error)?.message,
					}),
			},
		);
	};

	const commitRename = (conv: ConversationSummary, draft: string) => {
		const next = draft.trim();
		setRenamingId(null);
		// No-op when blank or unchanged — just close the editor.
		if (!next || next === (conv.title || "")) return;
		updateConversation.mutate(
			{
				params: { path: { conversation_id: conv.id } },
				body: { title: next },
			},
			{
				onError: (err) =>
					toast.error("Rename failed", {
						description: (err as Error)?.message,
					}),
			},
		);
	};

	const handleExport = (
		conv: ConversationSummary,
		format: "markdown" | "json",
	) => {
		exportConversation(conv.id, format).catch((err) =>
			toast.error("Export failed", {
				description: (err as Error)?.message,
			}),
		);
	};

	const formatTime = (dateStr: string) => {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);
		if (diffMins < 1) return "now";
		if (diffMins < 60) return `${diffMins}m`;
		if (diffHours < 24) return `${diffHours}h`;
		if (diffDays < 7) return `${diffDays}d`;
		return date.toLocaleDateString();
	};

	const navRowClass =
		"flex items-center gap-2.5 px-2.5 py-1.5 rounded-md w-full text-left text-sm transition-colors hover:bg-accent";

	// Move-to candidates: every workspace the user can see.
	const moveTargets = workspacesForMove ?? [];

	return (
		<TooltipProvider delayDuration={300}>
			<div
				className={cn(
					"flex flex-col h-full bg-background border-r w-72",
					className,
				)}
			>
				{/* === Top block — primary nav (always visible) =============== */}
				<div className="p-3 border-b space-y-1">
					{onClose && (
						<div className="flex justify-end lg:hidden">
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={onClose}
								aria-label="Close chat sidebar"
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
					)}
					<button
						type="button"
						onClick={handleNewChat}
						disabled={createConversation.isPending}
						className={cn(navRowClass, "font-medium")}
					>
						<Plus className="h-4 w-4" />
						<span>New chat</span>
					</button>

					{/* Workspace identity row (replaces "Workspaces" while inside one) */}
					{inWorkspaceMode && activeWorkspace ? (
						<div
							className={cn(
								navRowClass,
								"bg-accent/50 cursor-default hover:bg-accent/50 gap-2",
							)}
						>
							<FolderKanban className="h-4 w-4 text-primary shrink-0" />
							<span className="font-medium truncate flex-1">
								{activeWorkspace.name}
							</span>
							{onOpenWorkspaceSettings && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-6 shrink-0"
											onClick={onOpenWorkspaceSettings}
										>
											<Settings2 className="h-3.5 w-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Workspace settings
									</TooltipContent>
								</Tooltip>
							)}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-6 shrink-0"
										onClick={() => navigate("/chat")}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Exit workspace</TooltipContent>
							</Tooltip>
						</div>
					) : (
						<button
							type="button"
							onClick={() => navigate("/workspaces")}
							className={navRowClass}
						>
							<FolderKanban className="h-4 w-4" />
							<span>Workspaces</span>
						</button>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								disabled
								className={cn(
									navRowClass,
									"opacity-50 cursor-not-allowed hover:bg-transparent",
								)}
							>
								<Hammer className="h-4 w-4" />
								<span>Toolbox</span>
							</button>
						</TooltipTrigger>
						<TooltipContent>Coming soon</TooltipContent>
					</Tooltip>
					<button
						type="button"
						onClick={() => setArtifactsOpen(true)}
						className={navRowClass}
					>
						<Sparkles className="h-4 w-4" />
						<span>Artifacts</span>
					</button>
				</div>

				{/* === Search ================================================ */}
				<div className="p-3 border-b">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder={
								inWorkspaceMode
									? "Search this workspace..."
									: "Search chats..."
							}
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="pl-9 h-8 text-sm"
						/>
					</div>
				</div>

				{/* === Recent ================================================ */}
				<div className="flex-1 overflow-y-auto p-3 pt-2">
					<h3 className="text-[10px] font-medium tracking-wider uppercase text-muted-foreground mb-2 px-1">
						Recent
					</h3>
					{isLoadingConversations ? (
						<div className="space-y-2">
							{[1, 2, 3].map((i) => (
								<Skeleton key={i} className="h-12 w-full" />
							))}
						</div>
					) : filteredConversations &&
					  filteredConversations.length > 0 ? (
						<div className="space-y-0.5">
							{filteredConversations.map((conv) => (
								<div
									key={conv.id}
									className={cn(
										"group flex items-start gap-2 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-accent transition-colors",
										activeConversationId === conv.id &&
											"bg-accent",
									)}
									onClick={() =>
										handleSelectConversation(conv)
									}
								>
									<MessageSquare className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
									<div className="flex-1 min-w-0">
										<div className="flex items-center justify-between gap-2">
											{renamingId === conv.id ? (
												<RenameInput
													initial={conv.title || ""}
													onCommit={(v) =>
														commitRename(conv, v)
													}
													onCancel={() =>
														setRenamingId(null)
													}
												/>
											) : (
												<span className="font-medium text-sm truncate">
													{conv.title ||
														conv.agent_name ||
														"Untitled"}
												</span>
											)}
											<span className="text-[10px] opacity-0 group-hover:opacity-70 shrink-0 text-muted-foreground">
												{formatTime(conv.updated_at)}
											</span>
										</div>
										{conv.last_message_preview && (
											<p className="text-xs text-muted-foreground truncate">
												{conv.last_message_preview}
											</p>
										)}
									</div>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="icon-sm"
												className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0"
												aria-label={`Actions for ${conv.title || conv.agent_name || "Untitled"}`}
												onClick={(e) =>
													e.stopPropagation()
												}
											>
												<MoreHorizontal className="h-3 w-3" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											onClick={(e) => e.stopPropagation()}
											onCloseAutoFocus={(e) => {
												// Mount the inline editor only AFTER the menu has fully
												// closed (its dismiss overlay is gone) — otherwise the
												// editor mounts under the lingering overlay, which
												// intercepts pointer/focus and the field never sticks.
												// We also prevent Radix's default focus-restore to the
												// trigger so the editor's own focus wins. (jsdom can't
												// reproduce this overlay/focus race; verified live.)
												if (renameIntent.current === conv.id) {
													e.preventDefault();
													renameIntent.current = null;
													setRenamingId(conv.id);
												}
											}}
										>
											<DropdownMenuItem
												onSelect={() => {
													// Defer the actual rename to onCloseAutoFocus (above)
													// so the menu closes cleanly first.
													renameIntent.current = conv.id;
												}}
											>
												<Pencil className="h-3.5 w-3.5 mr-2" />
												Rename
											</DropdownMenuItem>
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<Download className="h-3.5 w-3.5 mr-2" />
													<span>Export</span>
													<ChevronRight className="ml-auto h-3 w-3" />
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent>
													<DropdownMenuItem
														onClick={() =>
															handleExport(
																conv,
																"markdown",
															)
														}
													>
														<FileText className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
														Markdown
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() =>
															handleExport(
																conv,
																"json",
															)
														}
													>
														<FileJson className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
														JSON
													</DropdownMenuItem>
												</DropdownMenuSubContent>
											</DropdownMenuSub>
											<DropdownMenuSeparator />
											<DropdownMenuSub>
												<DropdownMenuSubTrigger>
													<FolderInput className="h-3.5 w-3.5 mr-2" />
													<span>Move to</span>
													<ChevronRight className="ml-auto h-3 w-3" />
												</DropdownMenuSubTrigger>
												<DropdownMenuSubContent>
													{conv.workspace_id && (
														<DropdownMenuItem
															onClick={() =>
																handleMove(
																	conv,
																	null,
																)
															}
														>
															General chats
														</DropdownMenuItem>
													)}
													{moveTargets
														.filter(
															(w) =>
																w.id !==
																conv.workspace_id,
														)
														.map((w) => (
															<DropdownMenuItem
																key={w.id}
																onClick={() =>
																	handleMove(
																		conv,
																		w.id,
																	)
																}
															>
																<FolderKanban className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
																{w.name}
															</DropdownMenuItem>
														))}
													{moveTargets.length === 0 && (
														<DropdownMenuItem disabled>
															No workspaces yet
														</DropdownMenuItem>
													)}
												</DropdownMenuSubContent>
											</DropdownMenuSub>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={() =>
													setDeleteTarget(conv)
												}
												className="text-destructive focus:text-destructive"
											>
												<Trash2 className="h-3.5 w-3.5 mr-2" />
												Delete chat
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground py-2 px-1">
							{searchTerm
								? "No matching chats"
								: inWorkspaceMode
									? "No chats in this workspace yet"
									: "No chats yet"}
						</p>
					)}
				</div>

				<ArtifactsPanel
					conversationId={activeConversationId ?? undefined}
					open={artifactsOpen}
					onOpenChange={setArtifactsOpen}
				/>

				<AlertDialog
					open={!!deleteTarget}
					onOpenChange={(open) => !open && setDeleteTarget(null)}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete chat?</AlertDialogTitle>
							<AlertDialogDescription>
								This will delete the chat "
								{deleteTarget?.title ||
									deleteTarget?.agent_name ||
									"Untitled"}
								". This action cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={handleDeleteConfirm}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</TooltipProvider>
	);
}
