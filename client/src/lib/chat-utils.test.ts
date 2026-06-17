import { describe, expect, it, vi, afterEach } from "vitest";
import {
	budgetState,
	computeContextUsage,
	formatCompactTokens,
	generateLocalId,
	generateMessageId,
} from "./chat-utils";

type Msg = Parameters<typeof computeContextUsage>[0][number];

describe("computeContextUsage", () => {
	it("returns the most recent assistant input-token count, not a sum", () => {
		const messages: Msg[] = [
			{ role: "user", token_count_input: null },
			{ role: "assistant", token_count_input: 1200 },
			{ role: "user", token_count_input: null },
			{ role: "assistant", token_count_input: 4800 },
		];
		expect(computeContextUsage(messages)).toBe(4800);
	});

	it("ignores user/tool messages and missing counts", () => {
		const messages: Msg[] = [
			{ role: "user", token_count_input: 999 },
			{ role: "assistant", token_count_input: null },
		];
		expect(computeContextUsage(messages)).toBe(0);
	});

	it("returns 0 for an empty conversation", () => {
		expect(computeContextUsage([])).toBe(0);
	});
});

describe("budgetState", () => {
	it("flags muted under 70%", () => {
		const s = budgetState(60_000, 100_000);
		expect(s.fraction).toBeCloseTo(0.6);
		expect(s.tone).toBe("muted");
	});

	it("flags primary in the 70-85% band", () => {
		expect(budgetState(75_000, 100_000).tone).toBe("primary");
		expect(budgetState(70_000, 100_000).tone).toBe("primary");
	});

	it("flags destructive at or above 85%", () => {
		expect(budgetState(85_000, 100_000).tone).toBe("destructive");
		expect(budgetState(99_000, 100_000).tone).toBe("destructive");
	});

	it("caps the fraction at 1 when over budget", () => {
		const s = budgetState(150_000, 100_000);
		expect(s.fraction).toBe(1);
		expect(s.tone).toBe("destructive");
	});

	it("returns a null fraction + muted tone when the window is unknown", () => {
		const s = budgetState(40_000, null);
		expect(s.window).toBeNull();
		expect(s.fraction).toBeNull();
		expect(s.tone).toBe("muted");
	});

	it("treats a non-positive window as unknown", () => {
		expect(budgetState(10, 0).fraction).toBeNull();
	});
});

describe("formatCompactTokens", () => {
	it("formats sub-thousand verbatim", () => {
		expect(formatCompactTokens(0)).toBe("0");
		expect(formatCompactTokens(980)).toBe("980");
	});

	it("formats thousands with a k suffix", () => {
		expect(formatCompactTokens(12_450)).toBe("12k");
		expect(formatCompactTokens(1_000)).toBe("1k");
	});

	it("formats millions with an M suffix", () => {
		expect(formatCompactTokens(2_000_000)).toBe("2M");
		expect(formatCompactTokens(1_250_000)).toBe("1.3M");
	});
});

const originalRandomUUID = crypto.randomUUID;
const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
const originalCrypto = globalThis.crypto;

afterEach(() => {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: originalCrypto,
	});
	Object.defineProperty(originalCrypto, "randomUUID", {
		configurable: true,
		value: originalRandomUUID,
	});
	Object.defineProperty(originalCrypto, "getRandomValues", {
		configurable: true,
		value: originalGetRandomValues,
	});
	vi.restoreAllMocks();
});

describe("chat-utils ids", () => {
	it("uses crypto.randomUUID when the browser exposes it", () => {
		Object.defineProperty(crypto, "randomUUID", {
			configurable: true,
			value: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
		});

		expect(generateMessageId()).toBe("11111111-1111-4111-8111-111111111111");
		expect(generateLocalId()).toBe("local-11111111-1111-4111-8111-111111111111");
	});

	it("falls back to getRandomValues when randomUUID is unavailable", () => {
		Object.defineProperty(crypto, "randomUUID", {
			configurable: true,
			value: undefined,
		});
		Object.defineProperty(crypto, "getRandomValues", {
			configurable: true,
			value: vi.fn((array: Uint8Array) => {
				array.set([
					0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
					0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
				]);
				return array;
			}),
		});

		expect(generateMessageId()).toBe("12345678-9abc-4ef0-9234-56789abcdef0");
	});

	it("uses a timestamp fallback only when no browser crypto API exists", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: undefined,
		});
		vi.spyOn(Date, "now").mockReturnValue(1790000000000);
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		expect(generateMessageId()).toBe("fallback-mubbs7i8-i");
	});
});
