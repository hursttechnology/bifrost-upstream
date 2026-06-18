# Chat V2 — Live Browser UX Review (2026-06-17)

Method: live Playwright drive against the running debug stack at
`http://localhost:32944` (port mode, Chrome), logged in as
`dev@gobifrost.com`. Screenshots in `/tmp/ux-chatv2-v2/`. This is the
browser-verification companion to `2026-06-17-chat-v2-ux-review.md`
(code review).

## TL;DR

The completion path is **NOT actually reachable** in this stack — the
provider is configured but the org (`...0002`) has an empty allowlist
and no `default_chat_model`, so every chat send fails with
`no model available for org ...`. I did **not** modify config (read-only
scope + auto-mode classifier denied the org PATCH). As a result the
surfaces that require a rendered assistant message or real token usage
(streaming, message dimming at full emphasis, cost-tier badge in situ,
context-budget indicator, compact button, M6 delegation) could **not be
driven end-to-end in the browser** and were verified at component-render
/ code level only.

Everything else was driven live. The recently-fixed items that I *could*
verify in the live UI are confirmed correct. One real **P1** surfaced:
the conversation **Rename** action does nothing in the real browser.

## What I drove live (browser) vs. could not reach

**Drove live in the browser:**
- Login, chat shell, empty state, composer disclaimer
- Composer paperclip + attachment upload + chips (on an existing convo)
- Sidebar: New chat, search box, context menu (Rename/Export/Move to/Delete),
  Export → Markdown (real download), Delete confirm dialog
- Workspaces page: list, create dialog, narrow-viewport card controls
- Toolbox / Artifacts placeholder state + tooltip

**Could NOT reach (blocked by the model gate — no completion possible):**
- Send/receive streaming of a real assistant answer
- Live message dimming at full emphasis (verified in code instead)
- Cost-tier badge rendered on a real assistant message (verified via the
  passing ChatMessage component test instead)
- Context-budget indicator (renders only once `used > 0`)
- Compact button (renders only at ≥70% of window — needs token usage)
- M6 delegation badge (needs an agent with delegated sub-agents; no agents
  exist in this stack and none could be created to trigger it)

## Confirmation of recently-fixed items

| Item | Status | Evidence |
|------|--------|----------|
| Composer disclaimer = "AI can make mistakes…" (not "Claude is AI…") | ✅ CONFIRMED live | `10-chat.png` footer reads "AI can make mistakes. Please double-check responses." |
| No dead "+" button next to paperclip | ✅ CONFIRMED live | `10-chat.png`, `31-attach-existing.png` — only a paperclip + send arrow in the composer |
| Workspace card edit/delete controls visible without hover on small screens | ✅ CONFIRMED live | `52-workspaces-narrow.png` (390px) shows pencil + trash icons on the card with no hover |
| Cost-tier badge = Lucide icon (Zap/Gauge/Gem), not emoji | ✅ CONFIRMED (component render) | ChatMessage.test passes incl. "renders the cost-tier icon for a known tier" (aria-label "Balanced tier", lucide Gauge); code at ChatMessage.tsx:160-165 explicitly replaces the ⚡/⚖/💎 emoji. NOT seen in situ (no live assistant message). |
| Long "Let me…" answers render at full emphasis (not dimmed) | ✅ CONFIRMED (code) | `isProgressUpdate` (ChatMessage.tsx:93) only subdues paragraphs that are ≤80 chars AND single-sentence AND a progress opener; long/multi-sentence "Let me explain…" returns false → full emphasis. NOT driven live (no assistant message). |

## Findings (ranked)

### P0 — none on the surfaces I could reach.

### P1 — Conversation "Rename" does nothing in the real browser
- **Surface/route:** `/chat`, sidebar conversation context menu → Rename
- **What's wrong:** Clicking the **Rename** menu item never activates the
  inline rename editor. The `input[aria-label="Rename conversation"]`
  never enters the DOM. Reproduced across plain click, role-based click,
  force click, and keyboard activation; polled at 100 ms intervals for 2 s
  — input count stayed 0. By contrast **Export → Markdown** fired a real
  download and **Delete** opened its confirm dialog from the same menu, so
  menu actions *do* work — it's specifically Rename that fails.
- **Why the unit test misses it:** `ChatSidebar.test.tsx` drives rename
  with `fireEvent.click` in jsdom, which doesn't reproduce the Radix
  dropdown close + focus-restore timing. The bug only reproduces in a real
  browser. (Mirrors MEMORY's "regression that only reproduces with two
  tabs open" class — a test that's green for the wrong reason.)
- **Severity:** P1 — a primary, advertised sidebar action (§8.1) is dead in
  the shipping UI.
- **Screenshot:** `43g-rename.png`, `43i-kbd-rename.png` (menu closes, title
  stays truncated, no editor)
- **Likely component:** `client/src/components/chat/ChatSidebar.tsx`
  (`setRenamingId` on the Rename `DropdownMenuItem`, lines ~547-554, and the
  `RenameInput` mount/focus race, lines ~100-160). Suspect the
  `DropdownMenuItem onSelect`/`onClick` → `setRenamingId` is being clobbered
  by the menu's focus-restore or a parent re-render. Needs a browser-level
  (Playwright) test to lock it down.

### P1 (environment, not a code defect) — Chat completion path is unconfigured for the default org
- **Surface:** `/chat` send
- **What's wrong:** Sending any message fails with
  `Stream error: no model available for org 00000000-0000-0000-0000-000000000002
  (no allowlist entries and no default configured)`. The org has
  `allowed_chat_models: []` and `default_chat_model: null` (verified via
  `GET /api/organizations/...0002`). The platform provider IS configured
  (OpenRouter `deepseek/deepseek-v4-flash`, `is_configured: true`), and
  conversation **title generation succeeds** (it uses the provider directly),
  but the per-org model resolver used by the streaming chat
  (`api/shared/model_resolver.py:240`) refuses to pick a model.
- **Impact on this review:** This is exactly the blocker the brief said was
  resolved; it is not, for this org. It made the core send/receive flow and
  five dependent UI affordances un-drivable live.
- **The streamed error renders nicely** (red inline card, see
  `12-response.png`) — that part is good UX.
- **Severity:** P1 for the review run (blocks verification); whether it's a
  product P-anything depends on intended dev-stack seeding. The fix is admin
  config: set the org `default_chat_model` (or an allowlist entry) to a model
  the provider serves.
- **Screenshot:** `12-response.png`

### P2 — Attachments are disabled until the first message is sent
- **Surface:** `/chat` new-chat composer
- **What's wrong:** On a brand-new chat (before the first send), the paperclip
  is disabled — `attachEnabled = !!conversationId` (ChatInput.tsx:93), and
  `uploadFiles` early-returns when there's no `conversationId`
  (ChatInput.tsx:96). A user who wants to *start* a conversation by dropping
  in a CSV/PDF/image can't; they must send a text message first, then attach.
  On an existing conversation, attach works perfectly (chips render, 200 POST).
- **Severity:** P2 — common "drag a file in to start" expectation is silently
  unavailable; no affordance explains why the clip is greyed.
- **Screenshot:** `30-attachments.png` (new chat, no chips after setInputFiles)
  vs `31-attach-existing.png` (existing chat, both chips render correctly).
- **Likely component:** `client/src/components/chat/ChatInput.tsx` (gate the
  attach on conversation existence; consider deferring upload until the convo
  is created on first send).

### P2 — Attachment image chips show a generic file icon, not a thumbnail
- **Surface:** composer attachment chips
- **What's wrong:** An attached PNG renders with the file-image glyph but no
  actual thumbnail preview; visually it's nearly identical to the CSV chip.
- **Severity:** P2 polish.
- **Screenshot:** `31-attach-existing.png` (`10-chat.png` chip looks like the
  `test.csv` chip).
- **Likely component:** `ChatInput.tsx` attachment chip render (`attachmentIcon`).

### P2 — Delete-chat confirm uses a primary (blue) button for a destructive action
- **Surface:** `/chat` sidebar → Delete chat → confirm dialog
- **What's wrong:** The dialog correctly says "This action cannot be undone,"
  but the confirm button is rendered in primary blue, not a destructive/red
  variant. Convention (and the rest of the app) uses red for irreversible
  deletes.
- **Severity:** P2.
- **Screenshot:** `70-delete-confirm.png`
- **Likely component:** `ChatSidebar.tsx` delete `AlertDialog` action button.

### P3 — Two prominent "Coming soon" disabled nav rows in the chat sidebar
- **Surface:** `/chat` sidebar — Toolbox and Artifacts
- **What's wrong:** Both are full-width, full-prominence nav rows rendered at
  `opacity-50`, disabled, with a "Coming soon" tooltip. They read as primary
  navigation and invite a click that does nothing. For a shipping surface,
  parking two dead primary rows at the top of the sidebar is a little
  unpolished — consider a subtler treatment or hiding until implemented.
- **Severity:** P3 nitpick (intentional placeholders, clearly labelled).
- **Screenshot:** `62-toolbox-tooltip.png`
- **Likely component:** `ChatSidebar.tsx:424-453`.

### P3 — Inline length/sentence guard on dimming reads string children only
- **Surface:** assistant message paragraph dimming
- **What's wrong:** `isProgressUpdate` is fed text extracted via
  `children.filter(typeof === "string").join("")` (ChatMessage.tsx:330-340),
  so a paragraph that opens with inline markdown (e.g. **bold** "Let me")
  yields a shorter measured string than what's visible. Edge cases where a
  long answer's first words are bolded/inline-coded could in principle slip
  past the 80-char / sentence guards. Low likelihood, worth a note.
- **Severity:** P3.
- **Likely component:** `ChatMessage.tsx` markdown `p` renderer.

## Notes on un-driven surfaces (gate-blocked)

- **Context-budget indicator** (`ContextBudgetIndicator.tsx:63`) renders
  nothing until `state.window !== null && state.used > 0`. Needs a real
  completion.
- **Compact button** (`CompactButton.tsx:69`) renders only when
  `shouldSuggestCompaction(used, window)` (≥70% of window). Needs token usage.
- **M6 delegation badge** appears only when an agent has delegated
  sub-agents. No agents exist in this stack (`GET /api/agents` → `[]`) and
  none could be created through the chat UI to trigger it.

All three are gated behind a working completion path; re-run after the org
`default_chat_model` is set to verify them live.
