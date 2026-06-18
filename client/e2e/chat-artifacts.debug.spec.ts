/**
 * Chat V2 — ARTIFACTS browser verification (DEBUG stack).
 *
 * This is the real reason for the browser pass: the Artifacts panel is a Radix
 * Sheet rendered through a portal, and the inline artifact card expands an
 * inert ArtifactRenderer — neither of which jsdom can faithfully verify
 * (portal-focus + real layout). This spec drives an artifact that is already
 * seeded on the DEBUG stack and asserts the inline card + the Sheet panel in a
 * real Chromium.
 *
 * WHY THE DEBUG STACK (not the test stack): there is no public endpoint that
 * mints a completed artifact without real LLM tool output, and seeding one
 * through deepseek is fragile. The debug stack already has a "Quarterly Report"
 * artifact (markdown preview "Revenue up 12%" + report.md + breakdown.csv) on
 * conversation 4d4a26ca-8945-4b64-b772-bbac6bd86346, so we verify the risky
 * RENDERING path against that fixture.
 *
 * HOW TO RUN (debug stack URL from `./debug.sh status`):
 *   cd client && TEST_BASE_URL=http://localhost:32944 \
 *     npx playwright test e2e/chat-artifacts.debug.spec.ts \
 *     --project=platform-admin --no-deps
 *
 * Auth: the platform-admin storageState is for the TEST stack and is invalid
 * against the debug stack, so this spec clears it and logs in inline with the
 * debug dev account (MFA disabled on the debug stack).
 */

import { test, expect } from "@playwright/test";

// The debug stack's pre-seeded conversation carrying the Quarterly Report.
const CONVERSATION_ID = "4d4a26ca-8945-4b64-b772-bbac6bd86346";
const DEV_EMAIL = "dev@gobifrost.com";
const DEV_PASSWORD = "password";

// Ignore the test-stack auth state — we authenticate against the debug stack.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Chat V2 Artifacts (debug stack)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/login", { waitUntil: "domcontentloaded" });
		await expect(page.getByLabel("Email")).toBeVisible({ timeout: 15000 });
		await page.getByLabel("Email").fill(DEV_EMAIL);
		await page.getByLabel("Password").fill(DEV_PASSWORD);
		await page
			.getByRole("button", { name: "Sign In", exact: true })
			.click();
		// Debug stack has MFA disabled — we land directly on an authed route.
		await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
			timeout: 15000,
		});
	});

	test("inline artifact card renders, expands the markdown preview, and the Artifacts Sheet lists the artifact + CSV file", async ({
		page,
	}, testInfo) => {
		await page.goto(`/chat/${CONVERSATION_ID}`);

		// (a) The inline artifact card renders in the message stream. The card's
		// header shows the artifact title "Quarterly Report".
		const card = page
			.getByRole("button", { name: /Quarterly Report/ })
			.first();
		await expect(card).toBeVisible({ timeout: 20000 });

		// (b) Expanding the card reveals the inert markdown preview, which
		// contains "Revenue up".
		await card.click();
		await expect(
			page.getByText(/Revenue up/i).first(),
		).toBeVisible({ timeout: 10000 });

		// (c) The Artifacts nav button (sidebar) opens the Artifacts panel — a
		// Radix Sheet rendered through a portal. THIS is the surface jsdom can't
		// verify. Open it and confirm the artifact is listed.
		await page.getByRole("button", { name: "Artifacts" }).click();
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 10000 });
		await expect(
			sheet.getByText("Artifacts", { exact: true }).first(),
		).toBeVisible();
		// The panel lists the artifact by title.
		await expect(
			sheet.getByText(/Quarterly Report/).first(),
		).toBeVisible({ timeout: 10000 });

		// (d) The CSV file row is present in the panel (breakdown.csv).
		await expect(
			sheet.getByText(/breakdown\.csv/).first(),
		).toBeVisible({ timeout: 10000 });

		// Screenshot of the open panel for the report.
		const shot = await page.screenshot({ fullPage: false });
		await testInfo.attach("artifacts-panel-open", {
			body: shot,
			contentType: "image/png",
		});
	});
});
