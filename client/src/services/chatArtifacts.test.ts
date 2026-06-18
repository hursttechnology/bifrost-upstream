import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileImage, FileSpreadsheet, FileText, Sparkles } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import {
	formatFileSize,
	getArtifactDownloadUrl,
	getArtifactIcon,
	isInertPreviewKind,
} from "./chatArtifacts";

vi.mock("@/lib/api-client", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/api-client")>(
			"@/lib/api-client",
		);
	return {
		...actual,
		apiClient: { GET: vi.fn() },
	};
});

describe("isInertPreviewKind", () => {
	it("recognizes the four inert kinds", () => {
		expect(isInertPreviewKind("markdown")).toBe(true);
		expect(isInertPreviewKind("image")).toBe(true);
		expect(isInertPreviewKind("pdf")).toBe(true);
		expect(isInertPreviewKind("csv")).toBe(true);
	});

	it("rejects everything else (no html/svg/react)", () => {
		expect(isInertPreviewKind("html")).toBe(false);
		expect(isInertPreviewKind("svg")).toBe(false);
		expect(isInertPreviewKind("react")).toBe(false);
		expect(isInertPreviewKind("")).toBe(false);
	});
});

describe("getArtifactIcon", () => {
	it("maps content types to the right Lucide icon", () => {
		expect(getArtifactIcon("image/png")).toBe(FileImage);
		expect(getArtifactIcon("image/webp")).toBe(FileImage);
		expect(getArtifactIcon("text/csv")).toBe(FileSpreadsheet);
		expect(getArtifactIcon("application/pdf")).toBe(FileText);
		expect(getArtifactIcon("text/markdown")).toBe(FileText);
		expect(getArtifactIcon("text/plain")).toBe(FileText);
	});

	it("falls back to the sparkle for unknown types", () => {
		expect(getArtifactIcon("application/octet-stream")).toBe(Sparkles);
		expect(getArtifactIcon("application/zip")).toBe(Sparkles);
	});
});

describe("formatFileSize", () => {
	it("formats bytes / KB / MB / GB", () => {
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(512)).toBe("512 B");
		expect(formatFileSize(1024)).toBe("1 KB");
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatFileSize(1024 * 1024)).toBe("1 MB");
		expect(formatFileSize(Math.round(1.2 * 1024 * 1024))).toBe("1.2 MB");
		expect(formatFileSize(1024 * 1024 * 1024)).toBe("1 GB");
	});

	it("guards against bad input", () => {
		expect(formatFileSize(-1)).toBe("—");
		expect(formatFileSize(Number.NaN)).toBe("—");
	});
});

describe("getArtifactDownloadUrl", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls the download endpoint with the conversation + artifact ids", async () => {
		const expected = { url: "https://s3/signed", expires_in: 300 };
		vi.mocked(apiClient.GET).mockResolvedValue({
			data: expected,
			error: undefined,
		} as never);

		const result = await getArtifactDownloadUrl("conv-1", "file-9");

		expect(apiClient.GET).toHaveBeenCalledTimes(1);
		const [path, opts] = vi.mocked(apiClient.GET).mock.calls[0] as [
			string,
			{ params: { path: Record<string, string> } },
		];
		expect(path).toBe(
			"/api/chat/conversations/{conversation_id}/artifacts/{artifact_id}/download",
		);
		expect(opts.params.path).toEqual({
			conversation_id: "conv-1",
			artifact_id: "file-9",
		});
		expect(result).toEqual(expected);
	});

	it("throws when the endpoint returns an error", async () => {
		vi.mocked(apiClient.GET).mockResolvedValue({
			data: undefined,
			error: { detail: "Artifact not found" },
		} as never);

		await expect(getArtifactDownloadUrl("conv-1", "missing")).rejects.toThrow();
	});

	it("throws when no data is returned", async () => {
		vi.mocked(apiClient.GET).mockResolvedValue({
			data: undefined,
			error: undefined,
		} as never);

		await expect(
			getArtifactDownloadUrl("conv-1", "file-9"),
		).rejects.toThrow(/No download URL/);
	});
});
