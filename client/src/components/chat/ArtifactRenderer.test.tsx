/**
 * Component tests for ArtifactRenderer.
 *
 * The download-URL service is mocked so nothing hits the network; we assert the
 * inert preview paths (markdown), the image loading state, the files list, and
 * the per-file download button.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test-utils";
import { ArtifactRenderer } from "./ArtifactRenderer";
import type { ArtifactInfo } from "@/services/chatArtifacts";

const mockGetDownloadUrl = vi.fn();
vi.mock("@/services/chatArtifacts", async () => {
	const actual =
		await vi.importActual<typeof import("@/services/chatArtifacts")>(
			"@/services/chatArtifacts",
		);
	return {
		...actual,
		getArtifactDownloadUrl: (conversationId: string, artifactId: string) =>
			mockGetDownloadUrl(conversationId, artifactId),
	};
});

beforeEach(() => {
	mockGetDownloadUrl.mockReset();
});

describe("ArtifactRenderer — markdown preview", () => {
	it("renders the inline markdown through the markdown pipeline", () => {
		const artifact: ArtifactInfo = {
			title: "Report",
			preview: { kind: "markdown", inline: "# Heading\n\nBody text." },
			files: [],
		};
		renderWithProviders(
			<ArtifactRenderer artifact={artifact} conversationId="conv-1" />,
		);
		expect(
			screen.getByRole("heading", { level: 1, name: /heading/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/body text\./i)).toBeInTheDocument();
		// Markdown previews never fetch a download URL.
		expect(mockGetDownloadUrl).not.toHaveBeenCalled();
	});
});

describe("ArtifactRenderer — image preview", () => {
	it("shows a loading skeleton while the URL resolves", () => {
		// Never resolves during this assertion window.
		mockGetDownloadUrl.mockReturnValue(new Promise(() => {}));
		const artifact: ArtifactInfo = {
			title: "Chart",
			preview: { kind: "image", file_id: "file-1" },
			files: [],
		};
		renderWithProviders(
			<ArtifactRenderer artifact={artifact} conversationId="conv-1" />,
		);
		expect(screen.getByTestId("artifact-image-loading")).toBeInTheDocument();
		expect(mockGetDownloadUrl).toHaveBeenCalledWith("conv-1", "file-1");
	});

	it("renders the <img> once the URL resolves", async () => {
		mockGetDownloadUrl.mockResolvedValue({
			url: "https://s3/signed-image",
			expires_in: 300,
		});
		const artifact: ArtifactInfo = {
			title: "Chart",
			preview: { kind: "image", file_id: "file-1" },
			files: [],
		};
		renderWithProviders(
			<ArtifactRenderer artifact={artifact} conversationId="conv-1" />,
		);
		const img = await screen.findByRole("img", { name: /chart/i });
		expect(img).toHaveAttribute("src", "https://s3/signed-image");
	});
});

describe("ArtifactRenderer — files list", () => {
	it("renders one row per file with name, size, and a download button", () => {
		const artifact: ArtifactInfo = {
			title: "Bundle",
			preview: null,
			files: [
				{
					id: "f-1",
					filename: "data.csv",
					content_type: "text/csv",
					size_bytes: 2048,
				},
				{
					id: "f-2",
					filename: "summary.md",
					content_type: "text/markdown",
					size_bytes: 512,
				},
			],
		};
		renderWithProviders(
			<ArtifactRenderer artifact={artifact} conversationId="conv-1" />,
		);

		expect(screen.getByText("data.csv")).toBeInTheDocument();
		expect(screen.getByText("summary.md")).toBeInTheDocument();
		expect(screen.getByText("2 KB")).toBeInTheDocument();
		expect(screen.getByText("512 B")).toBeInTheDocument();
		expect(
			screen.getByLabelText("Download data.csv"),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText("Download summary.md"),
		).toBeInTheDocument();
	});

	it("fetches a download URL and opens it when a download button is clicked", async () => {
		mockGetDownloadUrl.mockResolvedValue({
			url: "https://s3/signed-file",
			expires_in: 300,
		});
		const openSpy = vi
			.spyOn(window, "open")
			.mockImplementation(() => null);

		const artifact: ArtifactInfo = {
			title: "Bundle",
			preview: null,
			files: [
				{
					id: "f-1",
					filename: "data.csv",
					content_type: "text/csv",
					size_bytes: 2048,
				},
			],
		};
		const { user } = renderWithProviders(
			<ArtifactRenderer artifact={artifact} conversationId="conv-1" />,
		);

		await user.click(screen.getByLabelText("Download data.csv"));

		expect(mockGetDownloadUrl).toHaveBeenCalledWith("conv-1", "f-1");
		await waitFor(() =>
			expect(openSpy).toHaveBeenCalledWith(
				"https://s3/signed-file",
				"_blank",
				"noopener,noreferrer",
			),
		);
		openSpy.mockRestore();
	});
});
