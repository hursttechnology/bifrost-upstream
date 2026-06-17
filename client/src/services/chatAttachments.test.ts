import { beforeEach, describe, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/api-client";
import {
	MAX_ATTACHMENT_SIZE_BYTES,
	MAX_ATTACHMENTS_PER_MESSAGE,
	isImageAttachment,
	uploadChatAttachments,
	validateAttachment,
} from "./chatAttachments";

vi.mock("@/lib/api-client", () => ({
	authFetch: vi.fn(),
}));

function fakeFile(name: string, size: number, type = "text/plain"): File {
	const f = new File(["x"], name, { type });
	Object.defineProperty(f, "size", { value: size });
	return f;
}

describe("isImageAttachment", () => {
	it("recognizes image content types", () => {
		expect(isImageAttachment("image/png")).toBe(true);
		expect(isImageAttachment("image/jpeg")).toBe(true);
		expect(isImageAttachment("application/pdf")).toBe(false);
		expect(isImageAttachment("text/plain")).toBe(false);
	});
});

describe("validateAttachment", () => {
	it("accepts a normal file", () => {
		expect(validateAttachment(fakeFile("a.txt", 100))).toBeNull();
	});

	it("rejects an empty file", () => {
		expect(validateAttachment(fakeFile("a.txt", 0))).toMatch(/empty/);
	});

	it("rejects an oversize file", () => {
		expect(
			validateAttachment(fakeFile("big.png", MAX_ATTACHMENT_SIZE_BYTES + 1)),
		).toMatch(/too large/);
	});
});

describe("uploadChatAttachments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("posts a multipart body to the conversation attachments endpoint", async () => {
		const expected = { attachments: [{ id: "att-1" }] };
		vi.mocked(authFetch).mockResolvedValue({
			ok: true,
			json: async () => expected,
		} as Response);

		const result = await uploadChatAttachments("conv-1", [
			fakeFile("a.txt", 10),
			fakeFile("b.csv", 20, "text/csv"),
		]);

		expect(authFetch).toHaveBeenCalledTimes(1);
		const [url, opts] = vi.mocked(authFetch).mock.calls[0];
		expect(url).toBe("/api/chat/conversations/conv-1/attachments");
		expect(opts?.method).toBe("POST");
		expect(opts?.body).toBeInstanceOf(FormData);
		const body = opts?.body as FormData;
		expect(body.getAll("files")).toHaveLength(2);
		expect(result).toEqual(expected);
	});

	it("throws when more than the per-message limit are supplied", async () => {
		const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) =>
			fakeFile(`f${i}.txt`, 10),
		);
		await expect(uploadChatAttachments("conv-1", files)).rejects.toThrow(
			/Too many files/,
		);
		expect(authFetch).not.toHaveBeenCalled();
	});

	it("surfaces the server error detail on failure", async () => {
		vi.mocked(authFetch).mockResolvedValue({
			ok: false,
			statusText: "Bad Request",
			json: async () => ({ detail: "Unsupported attachment type" }),
		} as Response);

		await expect(
			uploadChatAttachments("conv-1", [fakeFile("a.zip", 10, "application/zip")]),
		).rejects.toThrow(/Unsupported attachment type/);
	});
});
