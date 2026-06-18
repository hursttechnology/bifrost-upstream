/**
 * Chat V2 — TOOLBOX browser verification (DEBUG stack).
 *
 * The Toolbox is a Radix Sheet (portal) opened from the sidebar's Toolbox nav
 * button; the workflow-tool Switch writes workspace.enabled_tool_ids. jsdom
 * can't faithfully verify the portal render or the real Switch/PATCH path, so
 * this drives it in real Chromium against the debug stack.
 *
 * HOW TO RUN (debug stack URL from `./debug.sh status`):
 *   cd client && TEST_BASE_URL=http://localhost:32944 \
 *     npx playwright test e2e/chat-toolbox.debug.spec.ts \
 *     --project=chromium --no-deps --reporter=list
 *
 * Auth: the test-stack storageState is invalid against the debug stack, so this
 * spec clears it and logs in inline with the debug dev account (MFA off).
 */

import { test, expect } from "@playwright/test";

// A debug-stack conversation that exists (created during this session's drive).
const CONVERSATION_ID = "4d4a26ca-8945-4b64-b772-bbac6bd86346";
// A seeded conversation in a workspace whose agent has one workflow tool
// (echo_tool) and enabled_tool_ids=null (all-on) — used to verify the toggle.
const WORKSPACE_CONVERSATION_ID = "7208b5f9-627e-4ea8-aa75-2cf20c2e0cfc";
const WORKSPACE_ID = "fc5f9b72-6f5f-4f48-a18c-84e947efc92f";
const DEV_EMAIL = "dev@gobifrost.com";
const DEV_PASSWORD = "password";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Chat V2 Toolbox (debug stack)", () => {
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

	test("Toolbox nav button opens the Sheet and lists agent capabilities", async ({
		page,
	}) => {
		await page.goto(`/chat/${CONVERSATION_ID}`, {
			waitUntil: "domcontentloaded",
		});

		// The Toolbox nav button in the sidebar (Hammer icon + "Toolbox").
		const toolboxBtn = page.getByRole("button", { name: "Toolbox" });
		await expect(toolboxBtn).toBeVisible({ timeout: 15000 });
		await expect(toolboxBtn).toBeEnabled();
		await toolboxBtn.click();

		// The Radix Sheet (portal) opens — the surface jsdom can't verify.
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 10000 });
		await expect(sheet.getByText("Toolbox", { exact: true })).toBeVisible();

		// Capability sections render (read-only ones always present for an agent).
		await expect(
			sheet.getByRole("heading", { name: "Workflow tools" }),
		).toBeVisible();
		await expect(
			sheet.getByRole("heading", { name: "System tools" }),
		).toBeVisible();

		await test.info().attach("toolbox-panel-open", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});

	test("toggling a workflow tool off PATCHes the workspace enabled_tool_ids", async ({
		page,
	}) => {
		await page.goto(`/chat/${WORKSPACE_CONVERSATION_ID}`, {
			waitUntil: "domcontentloaded",
		});

		await page.getByRole("button", { name: "Toolbox" }).click();
		const sheet = page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 10000 });

		// The seeded agent has one workflow tool, echo_tool, with a Switch.
		const toggle = sheet.getByRole("switch", { name: "Toggle echo_tool" });
		await expect(toggle).toBeVisible({ timeout: 10000 });
		// enabled_tool_ids is null (all-on) → the tool starts enabled.
		await expect(toggle).toBeChecked();

		// Toggle it off and capture the PATCH that persists the new allowlist.
		const [patch] = await Promise.all([
			page.waitForRequest(
				(r) =>
					r.method() === "PATCH" &&
					r.url().includes(`/api/workspaces/${WORKSPACE_ID}`),
				{ timeout: 10000 },
			),
			toggle.click(),
		]);

		// Toggling the only tool off materializes the allowlist to [] (all-on
		// becomes "explicitly none"), proving the null→array semantics.
		const body = patch.postDataJSON();
		expect(body.enabled_tool_ids).toEqual([]);

		// And the switch reflects the off state after the mutation settles.
		await expect(toggle).not.toBeChecked();
	});
});
