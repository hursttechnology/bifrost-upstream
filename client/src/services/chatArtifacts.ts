import { FileImage, FileSpreadsheet, FileText, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiClient, handleApiError } from "@/lib/api-client";
import type { components } from "@/lib/v1";

// Re-export generated types for convenience. These schemas are produced by the
// backend (ArtifactInfo / ArtifactPreviewPublic / ArtifactFilePublic /
// ArtifactDownloadResponse in api/src/models/contracts/agents.py); run
// `npm run generate:types` after the API is up to refresh client/src/lib/v1.d.ts.
export type ArtifactInfo = components["schemas"]["ArtifactInfo"];
export type ArtifactPreviewPublic =
	components["schemas"]["ArtifactPreviewPublic"];
export type ArtifactFilePublic = components["schemas"]["ArtifactFilePublic"];
export type ArtifactDownloadResponse =
	components["schemas"]["ArtifactDownloadResponse"];

/** Preview kinds that render inert (no html/svg/react execution). */
export type InertPreviewKind = "markdown" | "image" | "pdf" | "csv";

const INERT_PREVIEW_KINDS: ReadonlySet<string> = new Set<InertPreviewKind>([
	"markdown",
	"image",
	"pdf",
	"csv",
]);

/**
 * Type guard: true if the preview kind is one of the four inert kinds we render
 * client-side. Anything else is not displayed inline (no html/svg/react).
 */
export function isInertPreviewKind(kind: string): kind is InertPreviewKind {
	return INERT_PREVIEW_KINDS.has(kind);
}

const IMAGE_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/gif",
]);

const SPREADSHEET_CONTENT_TYPES = new Set([
	"text/csv",
	"application/csv",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Pick a Lucide icon for an artifact file by content type. Images get the image
 * glyph, spreadsheets/CSV the table glyph, plain text/markdown the document
 * glyph, and everything else the generic "artifact" sparkle.
 */
export function getArtifactIcon(contentType: string): LucideIcon {
	if (IMAGE_CONTENT_TYPES.has(contentType)) return FileImage;
	if (SPREADSHEET_CONTENT_TYPES.has(contentType)) return FileSpreadsheet;
	if (
		contentType === "text/plain" ||
		contentType === "text/markdown" ||
		contentType === "application/pdf"
	) {
		return FileText;
	}
	return Sparkles;
}

/** Human-readable file size (e.g. "1.2 MB"). */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	// One decimal place, but drop a trailing ".0".
	const rounded = Math.round(value * 10) / 10;
	return `${rounded} ${units[unitIndex]}`;
}

/**
 * Mint a scoped, expiring download URL for one artifact file. The URL is minted
 * per request by the API (never stored on the artifact). `artifactId` is the
 * artifact file id (ArtifactFilePublic.id / ArtifactPreviewPublic.file_id).
 */
export async function getArtifactDownloadUrl(
	conversationId: string,
	artifactId: string,
): Promise<ArtifactDownloadResponse> {
	const { data, error } = await apiClient.GET(
		"/api/chat/conversations/{conversation_id}/artifacts/{artifact_id}/download",
		{
			params: {
				path: {
					conversation_id: conversationId,
					artifact_id: artifactId,
				},
			},
		},
	);
	if (error) handleApiError(error);
	if (!data) {
		throw new Error("No download URL returned for artifact");
	}
	return data;
}
