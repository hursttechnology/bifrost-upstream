import { describe, expect, it } from "vitest";

import { renderWithProviders, screen } from "@/test-utils";
import { ContextBudgetIndicator } from "./ContextBudgetIndicator";
import type { components } from "@/lib/v1";

type MessagePublic = components["schemas"]["MessagePublic"];

function assistant(tokens: number): MessagePublic {
	return {
		id: `m-${tokens}`,
		conversation_id: "c1",
		role: "assistant",
		content: "ok",
		token_count_input: tokens,
		sequence: 0,
		created_at: "2026-04-20T12:00:00Z",
	} as MessagePublic;
}

describe("ContextBudgetIndicator", () => {
	it("renders the compact used/window label when both are known", () => {
		renderWithProviders(
			<ContextBudgetIndicator
				messages={[assistant(32_000)]}
				contextWindow={200_000}
			/>,
		);
		expect(screen.getByText("32k / 200k")).toBeInTheDocument();
		expect(
			screen.getByLabelText(/Context budget: 16% used/),
		).toBeInTheDocument();
	});

	it("renders nothing when the context window is unknown", () => {
		const { container } = renderWithProviders(
			<ContextBudgetIndicator
				messages={[assistant(32_000)]}
				contextWindow={null}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing before any tokens are used", () => {
		const { container } = renderWithProviders(
			<ContextBudgetIndicator messages={[]} contextWindow={200_000} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
