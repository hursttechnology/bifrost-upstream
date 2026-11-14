/**
 * Auth token storage utilities.
 *
 * The platform stores three distinct kinds of access token:
 *
 * 1. The user's normal access token — issued by the login flow, kept in
 *    `localStorage`, shared across all tabs of the same origin.
 *
 * 2. An embed token — minted by `/embed/apps/{slug}` (or `/embed/forms/{id}`)
 *    after a successful HMAC check, scoped to a single application or form
 *    plus a set of `verified_params`, valid for ~8 hours, with no refresh
 *    flow. Embed tokens are kept in `sessionStorage` so they stay isolated
 *    to the iframe / tab that received them and never overwrite the user's
 *    normal session in another tab on the same origin.
 *
 * 3. An impersonation token — short-lived and revocable, kept in
 *    `localStorage` so every regular tab shares the support session without
 *    replacing the operator's normal login or refresh cookies.
 *
 * The embed token is delivered via a URL fragment (`#embed_token=…`) so it
 * never reaches the server in a Referer header or proxy log. An app embed's
 * fragment may also carry unsigned launch hints
 * (`&unsigned.ticket_id=…&unsigned.client_id=…`). They are kept apart from
 * the token and are never a credential.
 */

export const ACCESS_TOKEN_KEY = "bifrost_access_token";
export const EMBED_TOKEN_KEY = "bifrost_embed_token";
/** This tab's unsigned embed launch hints, JSON `{ticket_id?, client_id?}`. */
export const EMBED_LAUNCH_HINTS_KEY = "bifrost_embed_launch_hints";
/** Set when this framed tab received a malformed embed fragment. */
export const EMBED_LAUNCH_FAILED_KEY = "bifrost_embed_launch_failed";
/** A short-lived support-session token, isolated to the current browser tab. */
export const IMPERSONATION_TOKEN_KEY = "bifrost_impersonation_token";

const EMBED_TOKEN_FIELD = "embed_token";
const UNSIGNED_HINT_FIELDS = {
	"unsigned.ticket_id": "ticket_id",
	"unsigned.client_id": "client_id",
} as const;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UNSIGNED_HINT_VALUE = /^[0-9]{1,12}$/;

/** Unsigned values from an app embed link. Never use them for authorisation. */
export interface EmbedLaunchHints {
	ticket_id?: string;
	client_id?: string;
}

export interface EmbedLaunch {
	isEmbed: boolean;
	unsigned: EmbedLaunchHints;
}

export interface EmbedTokenClaims {
	embed?: boolean;
	embed_kind?: "app" | "form";
	grant?: "hmac" | "public";
	form_id?: string;
}

export interface ImpersonationTokenClaims {
	sub?: string;
	email?: string;
	name?: string;
	org_id?: string | null;
	impersonated_by_user_id?: string;
	impersonation_session_id?: string;
	exp?: number;
}

function parseTokenClaims<T>(token: string): T | null {
	try {
		const encoded = token.split(".")[1];
		if (!encoded) return null;
		const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		return JSON.parse(atob(padded)) as T;
	} catch {
		return null;
	}
}

/**
 * Detect whether this browsing context is rendered inside an iframe.
 * A SecurityError when reading `window.top` indicates a cross-origin parent —
 * which is itself proof that we're framed.
 */
export function isInIframe(): boolean {
	try {
		return window.top !== window.self;
	} catch {
		return true;
	}
}

function fragmentKey(segment: string): string {
	const separator = segment.indexOf("=");
	return separator === -1 ? segment : segment.slice(0, separator);
}

/** True when a fragment is an embed launch (well formed or not). */
function isEmbedFragment(segments: string[]): boolean {
	return segments.some((segment) => {
		const key = fragmentKey(segment);
		return key === EMBED_TOKEN_FIELD || key.startsWith("unsigned.");
	});
}

/**
 * Parse `embed_token=<jwt>` followed by zero or more unsigned hint segments,
 * each key at most once. Returns null for a malformed fragment. A hint whose
 * value is not 1 to 12 ASCII digits is dropped; the token still stands.
 */
function parseEmbedFragment(
	segments: string[],
): { token: string; hints: EmbedLaunchHints } | null {
	const [first, ...rest] = segments;
	const tokenPrefix = `${EMBED_TOKEN_FIELD}=`;
	if (!first.startsWith(tokenPrefix)) return null;
	const token = first.slice(tokenPrefix.length);
	if (!JWT_SHAPE.test(token)) return null;

	const hints: EmbedLaunchHints = {};
	const seen = new Set<string>();
	for (const segment of rest) {
		const separator = segment.indexOf("=");
		if (separator === -1) return null;
		const key = segment.slice(0, separator);
		if (
			!Object.prototype.hasOwnProperty.call(UNSIGNED_HINT_FIELDS, key) ||
			seen.has(key)
		) {
			return null;
		}
		seen.add(key);
		const value = segment.slice(separator + 1);
		if (UNSIGNED_HINT_VALUE.test(value)) {
			hints[UNSIGNED_HINT_FIELDS[key as keyof typeof UNSIGNED_HINT_FIELDS]] =
				value;
		}
	}
	return { token, hints };
}

/** Remove this tab's embed capability and hints, keeping any failure marker. */
function dropEmbedCapability(): void {
	sessionStorage.removeItem(EMBED_TOKEN_KEY);
	sessionStorage.removeItem(EMBED_LAUNCH_HINTS_KEY);
}

/**
 * Consume an `#embed_token=…` fragment from the current URL, if present,
 * and store the token in sessionStorage with any unsigned launch hints kept
 * separately. Strips the fragment from the URL either way so the token never
 * lingers in the address bar or history.
 *
 * Only stores the token when running inside an iframe — opening an embed
 * URL in a regular tab would otherwise turn that tab into a sticky embed
 * session, surprising the user. The HMAC check on the server is the real
 * security boundary; the iframe guard is purely UX hygiene.
 *
 * A malformed embed fragment inside an iframe fails closed: the tab keeps no
 * usable credential and never falls back to the ordinary signed-in session.
 */
export function consumeEmbedTokenFromHash(): void {
	if (typeof window === "undefined") return;
	const segments = window.location.hash.replace(/^#/, "").split("&");
	if (!isEmbedFragment(segments)) return;

	const launch = parseEmbedFragment(segments);

	// Always strip the fragment so the token doesn't sit in the URL bar.
	window.history.replaceState(
		null,
		"",
		window.location.pathname + window.location.search,
	);

	if (!isInIframe()) return;

	dropEmbedCapability();
	if (launch === null) {
		sessionStorage.setItem(EMBED_LAUNCH_FAILED_KEY, "1");
		return;
	}
	sessionStorage.removeItem(EMBED_LAUNCH_FAILED_KEY);
	sessionStorage.setItem(EMBED_TOKEN_KEY, launch.token);
	sessionStorage.setItem(EMBED_LAUNCH_HINTS_KEY, JSON.stringify(launch.hints));
}

function embedLaunchFailed(): boolean {
	return sessionStorage.getItem(EMBED_LAUNCH_FAILED_KEY) !== null;
}

/**
 * Describe this tab's app embed launch. `isEmbed` is true only for a valid
 * app embed token; `unsigned` holds the launch hints, which anyone in the
 * frame can change and which must never be used for authorisation.
 */
export function getEmbedLaunch(): EmbedLaunch {
	const claims = embedLaunchFailed() ? null : getEmbedTokenClaims();
	if (claims?.embed !== true || claims.embed_kind !== "app") {
		return { isEmbed: false, unsigned: {} };
	}
	const unsigned: EmbedLaunchHints = {};
	try {
		const stored = JSON.parse(
			sessionStorage.getItem(EMBED_LAUNCH_HINTS_KEY) ?? "{}",
		) as Record<string, unknown>;
		for (const key of Object.values(UNSIGNED_HINT_FIELDS)) {
			const value = stored[key];
			if (typeof value === "string" && UNSIGNED_HINT_VALUE.test(value)) {
				unsigned[key] = value;
			}
		}
	} catch {
		return { isEmbed: true, unsigned: {} };
	}
	return { isEmbed: true, unsigned };
}

/**
 * Return the access token to attach to outbound requests from this tab.
 * Prefers this tab's embed token, then the browser-wide impersonation token,
 * then the user's normal access token. Embed capability sessions are isolated
 * from support sessions even when the operator starts impersonating elsewhere.
 * A failed embed launch in this tab yields no token at all.
 */
export function getActiveToken(): string | null {
	if (embedLaunchFailed()) return null;
	const embed = sessionStorage.getItem(EMBED_TOKEN_KEY);
	if (embed) return embed;
	const impersonation = localStorage.getItem(IMPERSONATION_TOKEN_KEY);
	if (impersonation) return impersonation;
	return localStorage.getItem(ACCESS_TOKEN_KEY);
}

/** Read non-sensitive routing claims from the tab-scoped embed token. */
export function getEmbedTokenClaims(): EmbedTokenClaims | null {
	const token = sessionStorage.getItem(EMBED_TOKEN_KEY);
	return token ? parseTokenClaims<EmbedTokenClaims>(token) : null;
}

/** Save a browser-wide support session without disturbing the operator login. */
export function setImpersonationToken(token: string): void {
	localStorage.setItem(IMPERSONATION_TOKEN_KEY, token);
}

/** End the browser-wide support session. */
export function clearImpersonationToken(): void {
	localStorage.removeItem(IMPERSONATION_TOKEN_KEY);
}

export function isImpersonating(): boolean {
	return (
		!isEmbedSession() &&
		localStorage.getItem(IMPERSONATION_TOKEN_KEY) !== null
	);
}

/** Read non-sensitive claims used to render the support-session chrome. */
export function getImpersonationTokenClaims(): ImpersonationTokenClaims | null {
	if (isEmbedSession()) return null;
	const token = localStorage.getItem(IMPERSONATION_TOKEN_KEY);
	return token ? parseTokenClaims<ImpersonationTokenClaims>(token) : null;
}

/**
 * True when this tab is operating as an embed session (has an embed token
 * in sessionStorage, or a failed embed launch). Used to skip the
 * normal-session refresh flow, which doesn't apply to embed tokens.
 */
export function isEmbedSession(): boolean {
	return sessionStorage.getItem(EMBED_TOKEN_KEY) !== null || embedLaunchFailed();
}

/**
 * Clear this context's access tokens on logout and ordinary hard auth failures.
 * An embed owns only its capability token, so clearing that token never ends a
 * support session that another regular tab started. A failed embed launch
 * stays failed: only an explicit login (`clearEmbedToken`) ends it.
 */
export function clearAuthTokens(): void {
	if (isEmbedSession()) {
		dropEmbedCapability();
		return;
	}
	localStorage.removeItem(ACCESS_TOKEN_KEY);
	dropEmbedCapability();
	clearImpersonationToken();
}

/**
 * Drop any embed token, launch hints and failed-launch marker from this tab.
 * Called from the regular login flow: if a user explicitly logs in from a tab
 * that previously held an embed token, the new login should win and not be
 * shadowed by sessionStorage.
 */
export function clearEmbedToken(): void {
	dropEmbedCapability();
	sessionStorage.removeItem(EMBED_LAUNCH_FAILED_KEY);
}
