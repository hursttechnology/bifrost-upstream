/**
 * Chat V2 — cost-tier badge browser verification (DEBUG stack).
 *
 * The per-message cost-tier badge renders a Lucide glyph (Zap/Gauge/Gem) only
 * for a message whose model maps to a platform_models cost_tier. deepseek-v4-
 * flash has no catalogue row → cost_tier null → no badge (correct). This drives
 * a seeded premium-tier message and asserts the Gem glyph renders in-situ.
 *
 * HOW TO RUN (debug stack URL from `./debug.sh status`):
 *   cd client && TEST_BASE_URL=http://localhost:32944 \
 *     npx playwright test e2e/chat-cost-tier.debug.spec.ts \
 *     --project=chromium --no-deps --reporter=list
 */

import { test, expect } from "@playwright/test";

// A conversation seeded with one premium-tier assistant message.
const CONVERSATION_ID = "a02d1042-fddb-4a73-b046-2aeb0044a787";
const DEV_EMAIL = "dev@gobifrost.com";
const DEV_PASSWORD = "password";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Chat V2 cost-tier badge (debug stack)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/login", { waitUntil: "domcontentloaded" });
		await expect(page.getByLabel("Email")).toBeVisible({ timeout: 15000 });
		await page.getByLabel("Email").fill(DEV_EMAIL);
		await page.getByLabel("Password").fill(DEV_PASSWORD);
		await page
			.getByRole("button", { name: "Sign In", exact: true })
			.click();
		await page.waitForURL((u) => !u.pathname.includes("/login"), {
			timeout: 20000,
		});
	});

	test("premium cost-tier glyph renders on a catalogued-model message", async ({
		page,
	}) => {
		await page.goto(`/chat/${CONVERSATION_ID}`, {
			waitUntil: "domcontentloaded",
		});

		// The badge is an aria-labelled span wrapping the Lucide Gem icon.
		const badge = page.getByLabel("Premium tier").first();
		await expect(badge).toBeVisible({ timeout: 15000 });
		// It wraps an <svg> (the Lucide glyph), confirming the in-situ render.
		await expect(badge.locator("svg")).toBeVisible();

		await test.info().attach("cost-tier-badge", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});
});
