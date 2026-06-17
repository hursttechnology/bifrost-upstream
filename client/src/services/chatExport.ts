/**
 * Per-conversation export (§8.3).
 *
 * The backend export endpoint returns a downloadable file (Markdown or JSON)
 * with a Content-Disposition filename — not a JSON envelope — so this uses a
 * raw authenticated fetch + a blob download rather than the typed apiClient.
 */

import { authFetch } from "@/lib/api-client";

export type ExportFormat = "markdown" | "json";

/** Parse the filename from a Content-Disposition header, if present. */
export function filenameFromDisposition(
	header: string | null,
	fallback: string,
): string {
	if (!header) return fallback;
	const match = /filename="?([^";]+)"?/i.exec(header);
	return match?.[1] ?? fallback;
}

/**
 * Fetch a conversation export and trigger a browser download. Resolves once
 * the download has been initiated; rejects on a non-2xx response.
 */
export async function exportConversation(
	conversationId: string,
	format: ExportFormat,
): Promise<void> {
	const res = await authFetch(
		`/api/chat/conversations/${conversationId}/export?format=${format}`,
	);
	if (!res.ok) {
		throw new Error(`Export failed (${res.status})`);
	}

	const blob = await res.blob();
	const fallback = `${conversationId}.${format === "json" ? "json" : "md"}`;
	const filename = filenameFromDisposition(
		res.headers.get("Content-Disposition"),
		fallback,
	);

	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
