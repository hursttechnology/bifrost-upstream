import { authFetch } from "@/lib/api-client";
import type { components } from "@/lib/v1";

// Re-export generated types for convenience. These schemas are produced by the
// backend (AttachmentPublic / AttachmentUploadResponse in
// api/src/models/contracts/agents.py); run `npm run generate:types` after the
// API is up to refresh client/src/lib/v1.d.ts.
export type AttachmentPublic = components["schemas"]["AttachmentPublic"];
export type AttachmentUploadResponse =
	components["schemas"]["AttachmentUploadResponse"];

/** Per spec §3.2: 25 MB per file, 5 files per message. */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

const IMAGE_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/gif",
]);

/** True if the content type renders as an inline image preview. */
export function isImageAttachment(contentType: string): boolean {
	return IMAGE_CONTENT_TYPES.has(contentType);
}

/**
 * Client-side validation mirroring the server's checks so the user gets
 * immediate feedback before the upload round-trip. Returns an error message,
 * or null when the file is acceptable.
 */
export function validateAttachment(file: File): string | null {
	if (file.size <= 0) {
		return `${file.name} is empty.`;
	}
	if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
		const mb = Math.round(MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024));
		return `${file.name} is too large (max ${mb} MB).`;
	}
	return null;
}

/**
 * Upload one or more files to a conversation. They are stored unbound and
 * become bound to the next user message that references their IDs.
 */
export async function uploadChatAttachments(
	conversationId: string,
	files: File[],
): Promise<AttachmentUploadResponse> {
	if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
		throw new Error(
			`Too many files (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message).`,
		);
	}
	const formData = new FormData();
	for (const file of files) {
		formData.append("files", file);
	}

	const response = await authFetch(
		`/api/chat/conversations/${conversationId}/attachments`,
		{
			method: "POST",
			body: formData,
		},
	);
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(
			error.detail || `Failed to upload attachments: ${response.statusText}`,
		);
	}
	return response.json();
}
