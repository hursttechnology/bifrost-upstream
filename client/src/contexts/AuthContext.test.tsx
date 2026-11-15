import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { authFetch } from "@/lib/api-client";
import {
	ACCESS_TOKEN_KEY,
	EMBED_ISOLATED_KEY,
	IMPERSONATION_TOKEN_KEY,
	clearEmbedToken,
	clearImpersonationToken,
	consumeEmbedTokenFromHash,
	getActiveToken,
	isEmbedSession,
	setImpersonationToken,
} from "@/lib/auth-token";

const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("sonner", () => ({ toast }));

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

it("shares cookie recovery between provider bootstrap and an initial API request", async () => {
	const token = `header.${btoa(JSON.stringify({ sub: "account", email: "account@example.test", roles: ["authenticated"], exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const refresh = vi.fn(async () => {
		await gate;
		return Response.json({ access_token: token });
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (url.endsWith("/auth/status"))
				return Response.json({ needs_setup: false });
			if (url.endsWith("/api/auth/refresh")) return refresh();
			return Response.json({ ok: true });
		}),
	);
	function Probe() {
		const auth = useAuth();
		return (
			<p>
				{auth.isLoading
					? "Checking session"
					: (auth.user?.email ?? "Signed out")}
			</p>
		);
	}
	render(
		<MemoryRouter>
			<AuthProvider>
				<Probe />
			</AuthProvider>
		</MemoryRouter>,
	);
	await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
	const apiRequest = authFetch("/api/profile");
	await act(async () => {
		release();
		await apiRequest;
	});
	expect(refresh).toHaveBeenCalledTimes(1);
	expect(await screen.findByText("account@example.test")).toBeVisible();
	expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(token);
});

it("reloads an existing normal tab when impersonation or logout changes shared auth", async () => {
	const reload = vi.fn();
	const originalLocation = window.location;
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...originalLocation, reload },
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ needs_setup: false })),
	);

	try {
		render(
			<MemoryRouter>
				<AuthProvider>
					<p>Normal tab</p>
				</AuthProvider>
			</MemoryRouter>,
		);
		await screen.findByText("Normal tab");

		window.dispatchEvent(
			new StorageEvent("storage", {
				key: IMPERSONATION_TOKEN_KEY,
				newValue: "impersonated-token",
				storageArea: localStorage,
			}),
		);

		window.dispatchEvent(
			new StorageEvent("storage", {
				key: ACCESS_TOKEN_KEY,
				newValue: null,
				storageArea: localStorage,
			}),
		);

		expect(reload).toHaveBeenCalledTimes(2);
	} finally {
		Object.defineProperty(window, "location", {
			configurable: true,
			value: originalLocation,
		});
	}
});

it.each(["end", "refresh"])("keeps the override when operator restoration fails at %s", async (failure) => {
	const operator = "operator-token";
	localStorage.setItem(ACCESS_TOKEN_KEY, operator);
	setImpersonationToken("impersonated-token");
	const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/auth/status")) return Response.json({ needs_setup: false });
		if (url.endsWith("/api/auth/impersonation/end")) {
			return new Response(null, { status: failure === "end" ? 500 : 204 });
		}
		if (url.endsWith("/api/auth/refresh")) return new Response(null, { status: 500 });
		return Response.json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	let endImpersonation: (() => Promise<void>) | undefined;
	function Probe() {
		endImpersonation = useAuth().endImpersonation;
		return null;
	}
	render(
		<MemoryRouter>
			<AuthProvider>
				<Probe />
			</AuthProvider>
		</MemoryRouter>,
	);
	await vi.waitFor(() => expect(endImpersonation).toBeDefined());

	await expect(endImpersonation!()).rejects.toThrow();
	const [, init] = fetchMock.mock.calls.find(([input]) =>
		String(input).endsWith("/api/auth/impersonation/end"),
	)!;
	expect(new Headers(init?.headers).get("Authorization")).toBe(
		`Bearer ${operator}`,
	);
	expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(
		"impersonated-token",
	);
});

it("keeps the browser-wide support session when logout cannot revoke it", async () => {
	localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");
	setImpersonationToken("impersonated-token");
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/auth/status")) return Response.json({ needs_setup: false });
		if (url.endsWith("/auth/logout")) return new Response(null, { status: 500 });
		return Response.json({});
	});
	vi.stubGlobal("fetch", fetchMock);
	let logout: (() => void) | undefined;
	function Probe() {
		logout = useAuth().logout;
		return null;
	}
	render(
		<MemoryRouter>
			<AuthProvider>
				<Probe />
			</AuthProvider>
		</MemoryRouter>,
	);
	await vi.waitFor(() => expect(logout).toBeDefined());

	act(() => logout!());
	await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce());

	expect(fetchMock).toHaveBeenCalledWith(
		"/api/auth/logout",
		expect.objectContaining({
			method: "POST",
			headers: { Authorization: "Bearer impersonated-token" },
		}),
	);
	expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(
		"impersonated-token",
	);
	expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("operator-token");
});

it("signs an embed out without clearing shared cookies or browser credentials", async () => {
	localStorage.setItem(ACCESS_TOKEN_KEY, "operator-token");
	setImpersonationToken("impersonated-token");
	sessionStorage.setItem("bifrost_embed_token", "embed-token");
	const fetchMock = vi.fn(async (_url: RequestInfo | URL) => Response.json({ needs_setup: false }));
	vi.stubGlobal("fetch", fetchMock);
	let logout: (() => void) | undefined;
	function Probe() {
		logout = useAuth().logout;
		return null;
	}
	render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
	await vi.waitFor(() => expect(logout).toBeDefined());
	act(() => logout!());
	expect(sessionStorage.getItem("bifrost_embed_token")).toBeNull();
	expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe("operator-token");
	expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe("impersonated-token");
	expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/auth/logout"))).toBe(false);
});

it("keeps a failed embed launch signed out without refreshing the user's session", async () => {
	const userToken = `header.${btoa(JSON.stringify({ sub: "account", email: "account@example.test", exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
	localStorage.setItem(ACCESS_TOKEN_KEY, userToken);
	sessionStorage.setItem(EMBED_ISOLATED_KEY, "1");
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/auth/refresh")) return Response.json({ access_token: userToken });
		return Response.json({ needs_setup: false });
	});
	vi.stubGlobal("fetch", fetchMock);
	let auth: ReturnType<typeof useAuth> | undefined;
	function Probe() {
		auth = useAuth();
		return null;
	}
	render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
	await vi.waitFor(() => expect(auth?.isLoading).toBe(false));

	expect(auth!.user).toBeNull();
	expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/auth/refresh"))).toBe(false);

	act(() => auth!.logout());

	expect(sessionStorage.getItem(EMBED_ISOLATED_KEY)).not.toBeNull();
	expect(getActiveToken()).toBeNull();
	expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(userToken);
});

it("restores the operator token before releasing the override to other tabs", async () => {
	const restoredToken = `header.${btoa(JSON.stringify({ sub: "operator", email: "operator@example.test", exp: Math.floor(Date.now() / 1000) + 1800 }))}.signature`;
	localStorage.setItem(ACCESS_TOKEN_KEY, "expired-operator-token");
	setImpersonationToken("impersonated-token");
	const assign = vi.fn();
	const originalLocation = window.location;
	Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/auth/impersonation/end")) return new Response(null, { status: 204 });
		if (url.endsWith("/api/auth/refresh")) {
			expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe("impersonated-token");
			return Response.json({ access_token: restoredToken });
		}
		return Response.json({ needs_setup: false });
	});
	vi.stubGlobal("fetch", fetchMock);
	const originalRemove = Storage.prototype.removeItem;
	const remove = vi.spyOn(Storage.prototype, "removeItem");
	let restoredBeforeRelease = false;
	remove.mockImplementation(function (this: Storage, key: string) {
		if (key === IMPERSONATION_TOKEN_KEY) restoredBeforeRelease = localStorage.getItem(ACCESS_TOKEN_KEY) === restoredToken;
		return originalRemove.call(this, key);
	});
	let end: (() => Promise<void>) | undefined;
	function Probe() { end = useAuth().endImpersonation; return null; }
	try {
		render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>);
		await vi.waitFor(() => expect(end).toBeDefined());
		await act(async () => { await end!(); });
		expect(restoredBeforeRelease).toBe(true);
		expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBeNull();
		expect(assign).toHaveBeenCalledWith("/users");
	} finally {
		remove.mockRestore();
		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
	}
});

describe("embed isolation through the provider and authFetch", () => {
	function base64Url(value: string): string {
		return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	}
	function jwtFor(payload: Record<string, unknown>): string {
		return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
	}
	const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
	const aMinuteAgo = () => Math.floor(Date.now() / 1000) - 60;
	const ORDINARY = jwtFor({ sub: "account", email: "account@example.test", exp: inAnHour() });
	const IMPERSONATION = jwtFor({ sub: "target", email: "target@example.test", exp: inAnHour() });
	const embedToken = (exp: number) =>
		jwtFor({ sub: "embed", embed: true, embed_kind: "app", grant: "hmac", exp });

	let sent: (string | null)[] = [];
	let refreshCalls = 0;
	let unmount: (() => void) | undefined;

	beforeEach(() => {
		sent = [];
		refreshCalls = 0;
		localStorage.setItem(ACCESS_TOKEN_KEY, ORDINARY);
		setImpersonationToken(IMPERSONATION);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.endsWith("/auth/status")) return Response.json({ needs_setup: false });
				if (url.endsWith("/api/auth/refresh")) {
					refreshCalls += 1;
					return Response.json({ access_token: ORDINARY });
				}
				const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
				sent.push(headers.get("Authorization"));
				return Response.json({ ok: true });
			}),
		);
	});

	afterEach(() => {
		unmount?.();
		unmount = undefined;
		vi.restoreAllMocks();
		window.history.replaceState(null, "", "/");
	});

	function framed(): void {
		vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
	}

	function launch(fragment: string): void {
		window.history.replaceState(null, "", `/apps/heimdall#${fragment}`);
		consumeEmbedTokenFromHash();
	}

	async function mountProvider(): Promise<void> {
		unmount?.();
		let loading = true;
		function Probe() {
			loading = useAuth().isLoading;
			return null;
		}
		unmount = render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>).unmount;
		await vi.waitFor(() => expect(loading).toBe(false));
	}

	async function lastAuthorization(): Promise<string | null> {
		await authFetch("/api/workflows/execute", { method: "POST", body: "{}" });
		return sent[sent.length - 1];
	}

	async function expectIsolated(): Promise<void> {
		expect(await lastAuthorization()).toBeNull();
		expect(getActiveToken()).toBeNull();
		expect(isEmbedSession()).toBe(true);
		expect(refreshCalls).toBe(0);
		expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(ORDINARY);
		expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(IMPERSONATION);
	}

	async function reload(): Promise<void> {
		window.history.replaceState(null, "", "/apps/heimdall");
		consumeEmbedTokenFromHash();
		await mountProvider();
	}

	function failAuthentication(): void {
		(globalThis as typeof globalThis & {
			__BIFROST_PLATFORM_AUTH_V1__: { handleAuthenticationFailure: () => void };
		}).__BIFROST_PLATFORM_AUTH_V1__.handleAuthenticationFailure();
	}

	it.each([
		["a malformed JWT-shaped token", () => "embed_token=aaa.bbb.ccc"],
		["a JWT whose payload is not an embed token", () => `embed_token=${ORDINARY}`],
		["an expired embed token", () => `embed_token=${embedToken(aMinuteAgo())}`],
	])("keeps %s isolated after bootstrap and a reload", async (_label, fragment) => {
		framed();
		launch(fragment());
		await mountProvider();
		await expectIsolated();

		await reload();
		await expectIsolated();
	});

	it("keeps a rejected embed token isolated after an auth failure and a reload", async () => {
		framed();
		const token = embedToken(inAnHour());
		launch(`embed_token=${token}`);
		await mountProvider();
		expect(await lastAuthorization()).toBe(`Bearer ${token}`);

		act(() => failAuthentication());
		await expectIsolated();

		await reload();
		await expectIsolated();
	});

	it("refuses to end impersonation with the shared operator token", async () => {
		framed();
		launch("embed_token=aaa.bbb.ccc");
		let auth: ReturnType<typeof useAuth> | undefined;
		function Probe() {
			auth = useAuth();
			return null;
		}
		unmount = render(<MemoryRouter><AuthProvider><Probe /></AuthProvider></MemoryRouter>).unmount;
		await vi.waitFor(() => expect(auth?.isLoading).toBe(false));

		await expect(auth!.endImpersonation()).rejects.toThrow();
		await expect(auth!.refreshToken()).resolves.toBe(false);

		expect(sent).toEqual([]);
		expect(refreshCalls).toBe(0);
		expect(localStorage.getItem(IMPERSONATION_TOKEN_KEY)).toBe(IMPERSONATION);
	});

	it("lets an explicit login end the isolation", async () => {
		framed();
		clearImpersonationToken();
		launch("embed_token=aaa.bbb.ccc");
		await mountProvider();

		clearEmbedToken();

		expect(isEmbedSession()).toBe(false);
		expect(await lastAuthorization()).toBe(`Bearer ${ORDINARY}`);
	});

	it("lets a fresh valid handshake replace an isolated state", async () => {
		framed();
		launch(`embed_token=${embedToken(aMinuteAgo())}`);
		await mountProvider();
		await expectIsolated();

		const fresh = embedToken(inAnHour());
		launch(`embed_token=${fresh}`);
		await mountProvider();

		expect(await lastAuthorization()).toBe(`Bearer ${fresh}`);
		expect(sessionStorage.getItem(EMBED_ISOLATED_KEY)).toBeNull();
	});

	it("leaves an ordinary tab and a valid embed launch unchanged", async () => {
		await mountProvider();
		expect(await lastAuthorization()).toBe(`Bearer ${IMPERSONATION}`);

		framed();
		const token = embedToken(inAnHour());
		launch(`embed_token=${token}`);
		await mountProvider();
		expect(await lastAuthorization()).toBe(`Bearer ${token}`);
		expect(refreshCalls).toBe(0);
	});
});
