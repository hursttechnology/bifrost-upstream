import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ACCESS_TOKEN_KEY,
	EMBED_ISOLATED_KEY,
	EMBED_LAUNCH_HINTS_KEY,
	EMBED_TOKEN_KEY,
	consumeEmbedTokenFromHash,
} from "@/lib/auth-token";
import { createPlatformScope } from "./scope";
import { useEmbedLaunch } from "./useEmbedLaunch";

function base64Url(value: string): string {
	return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function jwtFor(payload: Record<string, unknown>): string {
	return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.c2ln`;
}

const APP_TOKEN = jwtFor({ embed: true, embed_kind: "app", grant: "hmac" });
const FORM_TOKEN = jwtFor({ embed: true, embed_kind: "form", grant: "hmac" });

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

describe("useEmbedLaunch", () => {
	it("returns this tab's unsigned hints in an app embed", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, APP_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "12345", client_id: "678" }),
		);

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({
			isEmbed: true,
			unsigned: { ticket_id: "12345", client_id: "678" },
		});
	});

	it("returns the hints from a framed launch fragment", () => {
		vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
		window.history.replaceState(
			null,
			"",
			`/apps/heimdall#embed_token=${APP_TOKEN}&unsigned.ticket_id=9`,
		);
		consumeEmbedTokenFromHash();

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({
			isEmbed: true,
			unsigned: { ticket_id: "9" },
		});
	});

	it("drops a stored hint that is not a plain number", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, APP_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "1; drop", client_id: 5, agent_id: "1" }),
		);

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({ isEmbed: true, unsigned: {} });
	});

	it("is not an embed in a normal signed-in session", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({ isEmbed: false, unsigned: {} });
	});

	it("is not an app embed in a form embed", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, FORM_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "1" }),
		);

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({ isEmbed: false, unsigned: {} });
	});

	it("is not an embed after a failed launch", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, APP_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "1" }),
		);
		sessionStorage.setItem(EMBED_ISOLATED_KEY, "1");

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({ isEmbed: false, unsigned: {} });
	});

	it("is not an embed in a top-level tab opened from an embed link", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		window.history.replaceState(
			null,
			"",
			`/apps/heimdall#embed_token=${APP_TOKEN}&unsigned.ticket_id=9`,
		);
		consumeEmbedTokenFromHash();

		const { result } = renderHook(() => useEmbedLaunch());

		expect(result.current).toEqual({ isEmbed: false, unsigned: {} });
	});

	it("returns the same object across renders", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, APP_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "1" }),
		);

		const { result, rerender } = renderHook(() => useEmbedLaunch());
		const first = result.current;
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "2" }),
		);
		rerender();

		expect(result.current).toBe(first);
		expect(Object.isFrozen(result.current)).toBe(true);
		expect(Object.isFrozen(result.current.unsigned)).toBe(true);
	});
});

describe("createPlatformScope useEmbedLaunch", () => {
	it("exposes useEmbedLaunch to app code", () => {
		const scope = createPlatformScope();

		expect(scope.useEmbedLaunch).toBe(useEmbedLaunch);
	});
});

describe("bifrost runtime useEmbedLaunch", () => {
	it("exports useEmbedLaunch from the bifrost module", async () => {
		const runtime = await import("@/lib/bifrost-runtime");

		expect(runtime.useEmbedLaunch).toBe(useEmbedLaunch);
	});
});
