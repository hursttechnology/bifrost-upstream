import { describe, expect, it } from "vitest";

import {
	contextWindowForModel,
	resellerForEndpoint,
	type PlatformModel,
} from "./platformModels";

function model(id: string, ctx: number | null): PlatformModel {
	return {
		model_id: id,
		provider: "anthropic",
		display_name: id,
		cost_tier: "balanced",
		context_window: ctx,
		is_active: true,
	} as PlatformModel;
}

describe("contextWindowForModel", () => {
	const byId: Record<string, PlatformModel> = {
		"claude-sonnet-4-6": model("claude-sonnet-4-6", 200_000),
		"openrouter/some-model": model("openrouter/some-model", 128_000),
	};

	it("resolves a direct model id to its window", () => {
		expect(contextWindowForModel("claude-sonnet-4-6", null, byId)).toBe(
			200_000,
		);
	});

	it("resolves via the reseller-prefixed key", () => {
		expect(
			contextWindowForModel("some-model", "openrouter", byId),
		).toBe(128_000);
	});

	it("returns null for an unknown model or a null id", () => {
		expect(contextWindowForModel("ghost-model", null, byId)).toBeNull();
		expect(contextWindowForModel(null, null, byId)).toBeNull();
		expect(contextWindowForModel(undefined, null, byId)).toBeNull();
	});
});

describe("resellerForEndpoint", () => {
	it("maps a known reseller host", () => {
		expect(resellerForEndpoint("https://openrouter.ai/api/v1")).toBe(
			"openrouter",
		);
	});

	it("returns null for the maker's own API or an unparseable endpoint", () => {
		expect(resellerForEndpoint("https://api.anthropic.com")).toBeNull();
		expect(resellerForEndpoint(null)).toBeNull();
		expect(resellerForEndpoint("not a url")).toBeNull();
	});
});
