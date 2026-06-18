/**
 * ArtifactRenderer — renders ONE artifact's inert preview plus its file list.
 *
 * Inert only: markdown is rendered through the same ReactMarkdown pipeline the
 * chat transcript uses (no raw-HTML execution beyond what that pipeline already
 * permits); image / pdf / csv previews fetch a scoped, expiring download URL on
 * demand. There is no html / svg / react execution path here by design — the
 * backend only ever emits the four inert preview kinds.
 */

import { createElement, useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	formatFileSize,
	getArtifactDownloadUrl,
	getArtifactIcon,
	type ArtifactFilePublic,
	type ArtifactInfo,
} from "@/services/chatArtifacts";

interface ArtifactRendererProps {
	artifact: ArtifactInfo;
	conversationId: string;
}

/** Markdown renderer mirroring the assistant config in ChatMessage. */
function ArtifactMarkdown({ source }: { source: string }) {
	return (
		<div className="prose prose-slate dark:prose-invert max-w-none prose-p:my-2 prose-p:leading-7 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-pre:p-0 prose-pre:bg-transparent">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeRaw]}
				components={{
					code({ className, children }) {
						const match = /language-(\w+)/.exec(className || "");
						const content = String(children).replace(/\n$/, "");
						const isCodeBlock = content.includes("\n") || className;
						if (isCodeBlock) {
							return (
								<SyntaxHighlighter
									style={oneDark}
									language={match?.[1] || "text"}
									PreTag="div"
									className="rounded-md !my-2"
								>
									{content}
								</SyntaxHighlighter>
							);
						}
						return (
							<code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">
								{children}
							</code>
						);
					},
					a: ({ href, children }) => (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary hover:underline"
						>
							{children}
						</a>
					),
					table: ({ children }) => (
						<div className="my-2 overflow-x-auto">
							<table className="min-w-full border-collapse border border-border">
								{children}
							</table>
						</div>
					),
					th: ({ children }) => (
						<th className="border border-border px-3 py-2 bg-muted font-semibold text-left">
							{children}
						</th>
					),
					td: ({ children }) => (
						<td className="border border-border px-3 py-2">
							{children}
						</td>
					),
				}}
			>
				{source}
			</ReactMarkdown>
		</div>
	);
}

/**
 * Resolve a fresh download URL for a file id. Returns the url + a loading flag
 * and (on failure) an error message. Re-fetches whenever the inputs change.
 */
function useDownloadUrl(
	conversationId: string,
	fileId: string | null | undefined,
) {
	// Keyed by fileId so a changed input resets to the loading state without a
	// synchronous setState in the effect body (set-state-in-effect rule).
	const [state, setState] = useState<{
		fileId: string | null | undefined;
		url: string | null;
		error: string | null;
	}>({ fileId, url: null, error: null });

	useEffect(() => {
		if (!fileId) return;
		let cancelled = false;
		getArtifactDownloadUrl(conversationId, fileId)
			.then((res) => {
				if (!cancelled) setState({ fileId, url: res.url, error: null });
			})
			.catch((e) => {
				if (!cancelled)
					setState({
						fileId,
						url: null,
						error: (e as Error)?.message || "Failed to load",
					});
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, fileId]);

	// If the input changed since the last settled result, treat as loading.
	const fresh = state.fileId === fileId;
	const url = fresh ? state.url : null;
	const error = fresh ? state.error : null;
	return { url, error, isLoading: !url && !error && !!fileId };
}

function ImagePreview({
	conversationId,
	fileId,
	alt,
}: {
	conversationId: string;
	fileId: string;
	alt: string;
}) {
	const { url, error, isLoading } = useDownloadUrl(conversationId, fileId);
	if (isLoading) {
		return <Skeleton className="h-48 w-full" data-testid="artifact-image-loading" />;
	}
	if (error || !url) {
		return (
			<p className="text-sm text-destructive">
				{error || "Failed to load image."}
			</p>
		);
	}
	return (
		<img
			src={url}
			alt={alt}
			loading="lazy"
			className="max-h-96 w-auto rounded-md border border-border"
		/>
	);
}

function PdfPreview({
	conversationId,
	fileId,
}: {
	conversationId: string;
	fileId: string;
}) {
	const { url, error, isLoading } = useDownloadUrl(conversationId, fileId);
	if (isLoading) {
		return <Skeleton className="h-10 w-40" />;
	}
	if (error || !url) {
		return (
			<p className="text-sm text-destructive">
				{error || "Failed to load PDF."}
			</p>
		);
	}
	return (
		<Button asChild variant="outline" size="sm">
			<a href={url} target="_blank" rel="noopener noreferrer">
				<FileText className="h-4 w-4" />
				Open PDF
				<ExternalLink className="h-3.5 w-3.5 opacity-70" />
			</a>
		</Button>
	);
}

/** Parse the first `maxRows` rows of CSV text into a cell grid (RFC-lite). */
function parseCsv(text: string, maxRows: number): string[][] {
	const rows: string[][] = [];
	const lines = text.split(/\r\n|\n|\r/);
	for (const line of lines) {
		if (rows.length >= maxRows) break;
		if (line.length === 0) continue;
		const cells: string[] = [];
		let current = "";
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQuotes) {
				if (ch === '"') {
					if (line[i + 1] === '"') {
						current += '"';
						i++;
					} else {
						inQuotes = false;
					}
				} else {
					current += ch;
				}
			} else if (ch === '"') {
				inQuotes = true;
			} else if (ch === ",") {
				cells.push(current);
				current = "";
			} else {
				current += ch;
			}
		}
		cells.push(current);
		rows.push(cells);
	}
	return rows;
}

const CSV_PREVIEW_ROWS = 20;

function CsvPreview({
	conversationId,
	fileId,
}: {
	conversationId: string;
	fileId: string;
}) {
	const { url, error, isLoading } = useDownloadUrl(conversationId, fileId);
	// Keyed by url so a changed source resets without a synchronous setState.
	const [csv, setCsv] = useState<{
		url: string | null;
		rows: string[][] | null;
		error: string | null;
	}>({ url: null, rows: null, error: null });

	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		fetch(url)
			.then((r) => r.text())
			.then((text) => {
				if (!cancelled)
					setCsv({
						url,
						rows: parseCsv(text, CSV_PREVIEW_ROWS),
						error: null,
					});
			})
			.catch((e) => {
				if (!cancelled)
					setCsv({
						url,
						rows: null,
						error: (e as Error)?.message || "Failed to load CSV",
					});
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	const fresh = csv.url === url;
	const rows = fresh ? csv.rows : null;
	const fetchError = fresh ? csv.error : null;

	if (isLoading || (url && !rows && !fetchError)) {
		return <Skeleton className="h-32 w-full" />;
	}
	if (error || fetchError) {
		return (
			<p className="text-sm text-destructive">
				{error || fetchError || "Failed to load CSV."}
			</p>
		);
	}
	if (!rows || rows.length === 0) {
		return <p className="text-sm text-muted-foreground">Empty file.</p>;
	}

	const [header, ...body] = rows;
	return (
		<div className="overflow-x-auto">
			<table className="min-w-full border-collapse border border-border text-sm">
				<thead>
					<tr>
						{header.map((cell, i) => (
							<th
								key={i}
								className="border border-border px-3 py-1.5 bg-muted font-semibold text-left"
							>
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((row, r) => (
						<tr key={r}>
							{row.map((cell, c) => (
								<td
									key={c}
									className="border border-border px-3 py-1.5"
								>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** One row in the files list: icon + name + size + download button. */
function FileIcon({ contentType }: { contentType: string }) {
	// createElement (not <Icon/>) so the linter doesn't read a function-call
	// result rendered as a JSX tag as a component declared during render.
	return createElement(getArtifactIcon(contentType), {
		className: "h-4 w-4 shrink-0 text-muted-foreground",
	});
}

function ArtifactFileRow({
	file,
	conversationId,
}: {
	file: ArtifactFilePublic;
	conversationId: string;
}) {
	const [isFetching, setIsFetching] = useState(false);

	const handleDownload = async () => {
		setIsFetching(true);
		try {
			const { url } = await getArtifactDownloadUrl(conversationId, file.id);
			window.open(url, "_blank", "noopener,noreferrer");
		} finally {
			setIsFetching(false);
		}
	};

	return (
		<div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
			<FileIcon contentType={file.content_type} />
			<span className="min-w-0 flex-1 truncate text-sm" title={file.filename}>
				{file.filename}
			</span>
			<span className="shrink-0 text-xs text-muted-foreground">
				{formatFileSize(file.size_bytes)}
			</span>
			<Button
				variant="ghost"
				size="icon-sm"
				className="shrink-0"
				disabled={isFetching}
				onClick={handleDownload}
				aria-label={`Download ${file.filename}`}
			>
				{isFetching ? (
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
				) : (
					<Download className="h-3.5 w-3.5" />
				)}
			</Button>
		</div>
	);
}

export function ArtifactRenderer({
	artifact,
	conversationId,
}: ArtifactRendererProps) {
	const preview = artifact.preview;
	const files = artifact.files ?? [];

	return (
		<div className="space-y-3">
			{preview && (
				<div data-testid="artifact-preview">
					{preview.kind === "markdown" && preview.inline != null && (
						<ArtifactMarkdown source={preview.inline} />
					)}
					{preview.kind === "image" && preview.file_id && (
						<ImagePreview
							conversationId={conversationId}
							fileId={preview.file_id}
							alt={artifact.title || "Artifact image"}
						/>
					)}
					{preview.kind === "pdf" && preview.file_id && (
						<PdfPreview
							conversationId={conversationId}
							fileId={preview.file_id}
						/>
					)}
					{preview.kind === "csv" && preview.file_id && (
						<CsvPreview
							conversationId={conversationId}
							fileId={preview.file_id}
						/>
					)}
				</div>
			)}

			{files.length > 0 && (
				<div className="space-y-1.5" data-testid="artifact-files">
					{files.map((file) => (
						<ArtifactFileRow
							key={file.id}
							file={file}
							conversationId={conversationId}
						/>
					))}
				</div>
			)}
		</div>
	);
}
