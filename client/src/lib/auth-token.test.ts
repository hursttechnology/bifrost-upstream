import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ACCESS_TOKEN_KEY,
	EMBED_LAUNCH_FAILED_KEY,
	EMBED_LAUNCH_HINTS_KEY,
	EMBED_TOKEN_KEY,
	IMPERSONATION_TOKEN_KEY,
	clearAuthTokens,
	clearEmbedToken,
	clearImpersonationToken,
	consumeEmbedTokenFromHash,
	getActiveToken,
	getEmbedLaunch,
	getImpersonationTokenClaims,
	isEmbedSession,
	isImpersonating,
	setImpersonationToken,
	getEmbedTokenClaims,
} from "./auth-token";

function tokenFor(payload: Record<string, unknown>): string {
	return `header.${btoa(JSON.stringify(payload)).replace(/=/g, "")}.signature`;
}

function base64Url(value: string): string {
	return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** A JWT-shaped token (three base64url segments) with the given claims. */
function jwtFor(payload: Record<string, unknown>): string {
	return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
}

const APP_TOKEN = jwtFor({ embed: true, embed_kind: "app", grant: "hmac" });
const SECOND_APP_TOKEN = jwtFor({
	embed: true,
	embed_kind: "app",
	grant: "hmac",
	jti: "second",
});
const FORM_TOKEN = jwtFor({ embed: true, embed_kind: "form", grant: "hmac" });

function setUrl(hash: string): void {
	window.history.replaceState(null, "", `/apps/heimdall?view=tab${hash}`);
}

function inIframe(): void {
	vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
}

function storedHints(): unknown {
	const raw = sessionStorage.getItem(EMBED_LAUNCH_HINTS_KEY);
	return raw === null ? null : JSON.parse(raw);
}

function expectFragmentStripped(): void {
	expect(window.location.hash).toBe("");
	expect(window.location.pathname).toBe("/apps/heimdall");
	expect(window.location.search).toBe("?view=tab");
}

describe("getEmbedTokenClaims", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
	});

	it("reads the form binding from this tab's embed token", () => {
		sessionStorage.setItem(
			EMBED_TOKEN_KEY,
			tokenFor({
				embed: true,
				embed_kind: "form",
				grant: "public",
				form_id: "form-1",
			}),
		);

		expect(getEmbedTokenClaims()).toMatchObject({
			embed_kind: "form",
			grant: "public",
			form_id: "form-1",
		});
	});

	it("does not read a token from another storage boundary", () => {
		localStorage.setItem(
			EMBED_TOKEN_KEY,
			tokenFor({ embed_kind: "form", form_id: "wrong-tab" }),
		);
		expect(getEmbedTokenClaims()).toBeNull();
	});

	it("returns null for malformed tokens", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, "not-a-jwt");
		expect(getEmbedTokenClaims()).toBeNull();
	});
});

describe("impersonation token storage", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
	});

	it("uses a browser-wide impersonation token without replacing the operator token", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");

		setImpersonationToken("impersonated-token");

		expect(getActiveToken()).toBe("impersonated-token");
		expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(
			"impersonated-token",
		);
		expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("operator-token");
		expect(sessionStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBeNull();
		expect(isImpersonating()).toBe(true);
	});

	it("keeps the embed token active while another tab is impersonating", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");
		sessionStorage.setItem(EMBED_TOKEN_KEY, "embed-token");

		setImpersonationToken("impersonated-token");

		expect(getActiveToken()).toBe("embed-token");
		expect(isImpersonating()).toBe(false);
		expect(getImpersonationTokenClaims()).toBeNull();
	});

	it("clears the browser-wide impersonation session", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");
		setImpersonationToken("impersonated-token");

		clearImpersonationToken();

		expect(getActiveToken()).toBe("operator-token");
		expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("operator-token");
		expect(isImpersonating()).toBe(false);
	});

	it("does not end another tab's support session when an embed clears its capability", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");
		sessionStorage.setItem(EMBED_TOKEN_KEY, "embed-token");
		setImpersonationToken("impersonated-token");

		clearAuthTokens();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBeNull();
		expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("operator-token");
		expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(
			"impersonated-token",
		);
	});
});

describe("consumeEmbedTokenFromHash in an iframe", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		inIframe();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setUrl("");
	});

	it("accepts an old-style fragment with only the token", () => {
		setUrl(`#embed_token=${APP_TOKEN}`);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBe(APP_TOKEN);
		expect(storedHints()).toEqual({});
		expect(getActiveToken()).toBe(APP_TOKEN);
		expect(getEmbedLaunch()).toEqual({ isEmbed: true, unsigned: {} });
		expectFragmentStripped();
	});

	it("stores the token and both hints separately", () => {
		setUrl(
			`#embed_token=${APP_TOKEN}&unsigned.ticket_id=12345&unsigned.client_id=678`,
		);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBe(APP_TOKEN);
		expect(storedHints()).toEqual({ ticket_id: "12345", client_id: "678" });
		expect(getEmbedLaunch()).toEqual({
			isEmbed: true,
			unsigned: { ticket_id: "12345", client_id: "678" },
		});
		expectFragmentStripped();
	});

	it.each([
		["unsigned.ticket_id=1", { ticket_id: "1" }],
		["unsigned.client_id=999999999999", { client_id: "999999999999" }],
	])("accepts the hint %s alone", (segment, expected) => {
		setUrl(`#embed_token=${APP_TOKEN}&${segment}`);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBe(APP_TOKEN);
		expect(getEmbedLaunch().unsigned).toEqual(expected);
	});

	it.each([
		["over-long", "1234567890123"],
		["non-numeric", "12a"],
		["empty", ""],
		["signed", "-1"],
		["Unicode digits", "١٢٣"],
		["encoded", "1%202"],
		["extra equals", "1=2"],
	])("drops a %s hint value but keeps the token", (_label, value) => {
		setUrl(
			`#embed_token=${APP_TOKEN}&unsigned.ticket_id=${value}&unsigned.client_id=678`,
		);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBe(APP_TOKEN);
		expect(getEmbedLaunch()).toEqual({
			isEmbed: true,
			unsigned: { client_id: "678" },
		});
		expect(sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY)).toBeNull();
	});

	it("keeps the token and hints across a reload in the same frame", () => {
		setUrl(`#embed_token=${APP_TOKEN}&unsigned.ticket_id=5`);
		consumeEmbedTokenFromHash();

		setUrl("");
		consumeEmbedTokenFromHash();

		expect(getActiveToken()).toBe(APP_TOKEN);
		expect(getEmbedLaunch()).toEqual({
			isEmbed: true,
			unsigned: { ticket_id: "5" },
		});
	});

	it("replaces old hints entirely when a new launch has none", () => {
		setUrl(
			`#embed_token=${APP_TOKEN}&unsigned.ticket_id=5&unsigned.client_id=6`,
		);
		consumeEmbedTokenFromHash();

		setUrl(`#embed_token=${SECOND_APP_TOKEN}`);
		consumeEmbedTokenFromHash();

		expect(getActiveToken()).toBe(SECOND_APP_TOKEN);
		expect(getEmbedLaunch()).toEqual({ isEmbed: true, unsigned: {} });
	});

	it("reports a form embed as not an app embed launch", () => {
		setUrl(`#embed_token=${FORM_TOKEN}`);

		consumeEmbedTokenFromHash();

		expect(getActiveToken()).toBe(FORM_TOKEN);
		expect(isEmbedSession()).toBe(true);
		expect(getEmbedLaunch()).toEqual({ isEmbed: false, unsigned: {} });
	});

	it.each([
		["a duplicated hint key", `#embed_token=${APP_TOKEN}&unsigned.ticket_id=1&unsigned.ticket_id=2`],
		["a duplicated embed_token", `#embed_token=${APP_TOKEN}&embed_token=${SECOND_APP_TOKEN}`],
		["an unknown unsigned key", `#embed_token=${APP_TOKEN}&unsigned.agent_id=9`],
		["an unknown key", `#embed_token=${APP_TOKEN}&foo=1`],
		["a non-JWT token", "#embed_token=not-a-jwt"],
		["a two-segment token", "#embed_token=aaa.bbb"],
		["a token with base64 padding", "#embed_token=aaa.bbb=.ccc"],
		["an empty token", "#embed_token="],
		["an empty token before hints", "#embed_token=&unsigned.ticket_id=1"],
		["a segment without equals", `#embed_token=${APP_TOKEN}&unsigned.ticket_id`],
		["a trailing ampersand", `#embed_token=${APP_TOKEN}&`],
		["hints before the token", `#unsigned.ticket_id=1&embed_token=${APP_TOKEN}`],
	])("fails closed on %s", (_label, hash) => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		localStorage.setItem(IMPERSONATION_TOKEN_KEY, "impersonation-token");
		sessionStorage.setItem(EMBED_TOKEN_KEY, SECOND_APP_TOKEN);
		sessionStorage.setItem(
			EMBED_LAUNCH_HINTS_KEY,
			JSON.stringify({ ticket_id: "77" }),
		);
		setUrl(hash);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_TOKEN_KEY)).toBeNull();
		expect(sessionStorage.getItem(EMBED_LAUNCH_HINTS_KEY)).toBeNull();
		expect(sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY)).not.toBeNull();
		expect(getActiveToken()).toBeNull();
		expect(isEmbedSession()).toBe(true);
		expect(isImpersonating()).toBe(false);
		expect(getEmbedLaunch()).toEqual({ isEmbed: false, unsigned: {} });
		expectFragmentStripped();
	});

	it("stays closed after a reload and after an auth-failure clear", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		setUrl("#embed_token=not-a-jwt");
		consumeEmbedTokenFromHash();

		setUrl("");
		consumeEmbedTokenFromHash();
		clearAuthTokens();

		expect(getActiveToken()).toBeNull();
		expect(isEmbedSession()).toBe(true);
		expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("user-token");
	});

	it("lets an explicit login clear the failed launch", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		setUrl("#embed_token=not-a-jwt");
		consumeEmbedTokenFromHash();

		clearEmbedToken();

		expect(sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY)).toBeNull();
		expect(isEmbedSession()).toBe(false);
		expect(getActiveToken()).toBe("user-token");
	});

	it("lets a new valid launch replace a failed one", () => {
		setUrl("#embed_token=not-a-jwt");
		consumeEmbedTokenFromHash();

		setUrl(`#embed_token=${APP_TOKEN}&unsigned.client_id=4`);
		consumeEmbedTokenFromHash();

		expect(sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY)).toBeNull();
		expect(getActiveToken()).toBe(APP_TOKEN);
		expect(getEmbedLaunch()).toEqual({
			isEmbed: true,
			unsigned: { client_id: "4" },
		});
	});

	it("leaves an unrelated fragment alone", () => {
		sessionStorage.setItem(EMBED_TOKEN_KEY, APP_TOKEN);
		setUrl("#details");

		consumeEmbedTokenFromHash();

		expect(window.location.hash).toBe("#details");
		expect(getActiveToken()).toBe(APP_TOKEN);
		expect(sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY)).toBeNull();
	});
});

describe("consumeEmbedTokenFromHash in a normal tab", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
	});

	afterEach(() => {
		setUrl("");
	});

	it("keeps the user's session after a malformed fragment", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		setUrl(`#embed_token=${APP_TOKEN}&foo=1`);

		consumeEmbedTokenFromHash();

		expect(getActiveToken()).toBe("user-token");
		expect(isEmbedSession()).toBe(false);
		expect(sessionStorage.length).toBe(0);
		expectFragmentStripped();
	});

	it("hands a valid embed link off to the user's own session", () => {
		localStorage.setItem(ACCESS_TOKEN_KEY, "user-token");
		setUrl(
			`#embed_token=${APP_TOKEN}&unsigned.ticket_id=12345&unsigned.client_id=678`,
		);

		consumeEmbedTokenFromHash();

		expect(sessionStorage.length).toBe(0);
		expect(getActiveToken()).toBe("user-token");
		expect(getEmbedLaunch()).toEqual({ isEmbed: false, unsigned: {} });
		expectFragmentStripped();
	});
});
