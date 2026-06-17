import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { exportConversation, filenameFromDisposition } from "./chatExport";

const authFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
	authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

describe("filenameFromDisposition", () => {
	it("extracts a quoted filename", () => {
		expect(
			filenameFromDisposition('attachment; filename="my-chat.md"', "x.md"),
		).toBe("my-chat.md");
	});

	it("extracts an unquoted filename", () => {
		expect(
			filenameFromDisposition("attachment; filename=notes.json", "x.json"),
		).toBe("notes.json");
	});

	it("falls back when the header is missing or unparseable", () => {
		expect(filenameFromDisposition(null, "fallback.md")).toBe("fallback.md");
		expect(filenameFromDisposition("attachment", "fallback.md")).toBe(
			"fallback.md",
		);
	});
});

describe("exportConversation", () => {
	let clickSpy: Mock<(download: string, href: string) => void>;
	let createdUrl = "blob:mock";

	beforeEach(() => {
		authFetchMock.mockReset();
		clickSpy = vi.fn();
		createdUrl = "blob:mock";
		// jsdom lacks createObjectURL/revokeObjectURL.
		globalThis.URL.createObjectURL = vi.fn(() => createdUrl);
		globalThis.URL.revokeObjectURL = vi.fn();
		vi.spyOn(
			HTMLAnchorElement.prototype,
			"click",
		).mockImplementation(function (this: HTMLAnchorElement) {
			clickSpy(this.download, this.href);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests the right format and triggers a named download", async () => {
		authFetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			blob: async () => new Blob(["# hi"], { type: "text/markdown" }),
			headers: new Headers({
				"Content-Disposition": 'attachment; filename="chat.md"',
			}),
		});

		await exportConversation("conv-123", "markdown");

		expect(authFetchMock).toHaveBeenCalledWith(
			"/api/chat/conversations/conv-123/export?format=markdown",
		);
		expect(clickSpy).toHaveBeenCalledWith("chat.md", createdUrl);
		expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(createdUrl);
	});

	it("uses a fallback filename when the server omits a disposition", async () => {
		authFetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			blob: async () => new Blob(["{}"], { type: "application/json" }),
			headers: new Headers(),
		});

		await exportConversation("conv-9", "json");

		expect(clickSpy).toHaveBeenCalledWith("conv-9.json", createdUrl);
	});

	it("throws on a non-2xx response", async () => {
		authFetchMock.mockResolvedValue({
			ok: false,
			status: 404,
			blob: async () => new Blob([]),
			headers: new Headers(),
		});

		await expect(exportConversation("missing", "markdown")).rejects.toThrow(
			/404/,
		);
		expect(clickSpy).not.toHaveBeenCalled();
	});
});
