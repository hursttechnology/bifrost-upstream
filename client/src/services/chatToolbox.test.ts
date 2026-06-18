import { describe, expect, it } from "vitest";

import {
	computeNextEnabledToolIds,
	isToolEnabled,
} from "./chatToolbox";

describe("isToolEnabled", () => {
	it("treats null/undefined as all-enabled (no restriction)", () => {
		expect(isToolEnabled("a", null)).toBe(true);
		expect(isToolEnabled("a", undefined)).toBe(true);
	});

	it("honors an explicit allowlist", () => {
		expect(isToolEnabled("a", ["a", "b"])).toBe(true);
		expect(isToolEnabled("c", ["a", "b"])).toBe(false);
	});

	it("treats an empty array as nothing enabled", () => {
		expect(isToolEnabled("a", [])).toBe(false);
	});
});

describe("computeNextEnabledToolIds — the null-vs-array materialization", () => {
	const all = ["a", "b", "c"];

	it("materializes 'all except the one turned off' on the FIRST toggle-off from null", () => {
		// Workspace had no restriction (null = all on). Turning 'b' off must NOT
		// produce ['b'] or [] — it must keep a and c enabled.
		expect(computeNextEnabledToolIds(all, null, "b", false)).toEqual([
			"a",
			"c",
		]);
	});

	it("does the same from undefined", () => {
		expect(computeNextEnabledToolIds(all, undefined, "c", false)).toEqual([
			"a",
			"b",
		]);
	});

	it("adds a tool back to an existing allowlist", () => {
		expect(computeNextEnabledToolIds(all, ["a"], "b", true)).toEqual([
			"a",
			"b",
		]);
	});

	it("removes a tool from an existing allowlist", () => {
		expect(computeNextEnabledToolIds(all, ["a", "b", "c"], "a", false)).toEqual(
			["b", "c"],
		);
	});

	it("preserves agent tool order regardless of allowlist order", () => {
		expect(
			computeNextEnabledToolIds(all, ["c", "a"], "b", true),
		).toEqual(["a", "b", "c"]);
	});

	it("drops ids the agent no longer has when re-materializing", () => {
		// 'z' is stale (agent dropped it); it should not survive into the result.
		expect(
			computeNextEnabledToolIds(all, ["a", "z"], "b", true),
		).toEqual(["a", "b"]);
	});

	it("toggling on when already null keeps everything enabled", () => {
		// Edge: turning a tool 'on' from the all-on state is a no-op set that
		// still yields the full set.
		expect(computeNextEnabledToolIds(all, null, "a", true)).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});
