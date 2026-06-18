# Chat V2 UX-Quality Review — 2026-06-17

Reviewer pass against the running debug stack (port mode, `http://localhost:32944`,
`dev@gobifrost.com`) plus a code read of the gated surfaces. Goal: catch
"obviously poor UX" before the product owner logs in. **Findings only — nothing fixed.**

## Coverage — what was actually driven vs. inferred

| Surface | How verified |
|---|---|
| Chat empty/"not configured" gate | **Browser-verified** (screenshot `02-chat-empty.png`) |
| Workspaces directory page | **Browser-verified** (`10-workspaces.png`, `21-ws-list-full.png`) |
| New-workspace dialog (full flow, create → navigate) | **Browser-verified** (`11-ws-create-dialog.png`, `13`) |
| Workspace card (rendered, Private badge, hover actions) | **Browser-verified** + code |
| Chat sidebar (search, rename, export, move, delete) | **Code-inferred** — unreachable in browser (see Blocker) |
| Composer (paperclip/drag/paste, chips) | **Code-inferred** |
| Chat header (budget indicator, compact, admin stats) | **Code-inferred** |
| Assistant/user message rendering, cost-tier badges | **Code-inferred** |
| M5 compaction button | **Code-inferred** |
| M6 delegation badge | **Code-inferred** (also needs a delegating agent to trigger) |

### BLOCKER — the entire chat surface is unreachable without a working LLM key

`/chat` is hard-gated by `Chat.tsx`: if `useLLMConfig().isConfigured === false`
(platform admins only — see `useLLMConfig.ts`) the whole route is replaced with the
"AI Chat Not Configured" panel. The save endpoint (`api/src/routers/llm_config.py`
~L132) runs a **real 1-token completion** before persisting, so a placeholder key
will not open the gate. On a fresh stack with no provider key, **none** of the four
milestones (sidebar, composer/attachments, compaction, delegation) can be reached in
a browser at all. Direct DB seeding and credential lookups were correctly blocked by
sandbox policy, so the gated surfaces below are reviewed from code.

> Implication for the product owner: on a brand-new instance the very first thing
> they see at `/chat` is the empty gate. That panel is fine — but it is the *only*
> chat experience until a key is added. Worth confirming the onboarding funnel makes
> that obvious.

---

## Findings (ranked)

### P1 — clearly poor

**P1-1 — "Progress update" heuristic dims real answers.**
`ChatMessage.tsx` (`isProgressUpdate`, L77–100) renders any assistant paragraph that
*starts* with `Let me`, `I'll`, `Now`, `First,`, `Great!`, `Perfect`, `I found`,
`I see`, `I notice`, … as **dimmed, smaller `text-muted-foreground`** text. These
openers are extremely common in *final* answers ("Great question — here's the
breakdown…", "I found 3 matching tickets:"). The result is legitimate content that
looks like de-emphasized filler. The classifier is a leading-substring regex with no
length/position guard for most patterns, so it will misfire often. Code-inferred but
high-confidence. Component: `client/src/components/chat/ChatMessage.tsx`.

**P1-2 — Hardcoded "Claude" vendor name in the composer disclaimer.**
`ChatInput.tsx` L549–551 always renders "Claude is AI and can make mistakes." The
provider can be OpenAI (`llm_config` supports `openai`/`anthropic`). If an admin
configures GPT-4o, every message still says "Claude," which reads as a bug to anyone
who set up OpenAI. Component: `client/src/components/chat/ChatInput.tsx`.

### P2 — polish

**P2-1 — Cost-tier glyph set is visually incoherent.**
`platformModels.ts` L30–34 uses `⚡` (U+26A1) and `💎` (U+1F48E) — full-color
emoji — alongside `⚖` (U+2696, no VS16) which most platforms render as a thin
**monochrome** glyph, often visibly smaller. Two colorful emoji + one grey symbol on
adjacent assistant messages looks unintentional. Either force emoji presentation
(`⚖️` with VS16) or use a consistent Lucide icon set. Component:
`client/src/services/platformModels.ts`, surfaced by `ChatMessage.tsx` `CostTierBadge`.

**P2-2 — DelegationBadge uses raw palette colors, not design tokens.**
`DelegationBadge.tsx` L46–55 hardcodes `text-blue-500` / `bg-blue-500/10` /
`text-green-500` / `text-green-600` for the running/success states while the error
state correctly uses the semantic `text-destructive` token. Raw `green-500`/`blue-500`
are not dark-mode-tuned the way the app's teal/`primary` tokens are, so the badge will
read brighter/off-palette against the chat surface and is inconsistent with the rest
of the design language. Component: `client/src/components/chat/DelegationBadge.tsx`.

**P2-3 — Workspace card edit/delete are hover-only with no touch fallback.**
`Workspaces.tsx` L283 & L295: the Edit and Delete buttons are
`opacity-0 group-hover:opacity-100` with no `sm:` / always-visible fallback. On
touch devices (no hover) there is **no way to edit or delete a workspace** from the
directory. Note the chat sidebar got this right (`sm:opacity-0 sm:group-hover...`,
i.e. visible on mobile) — so this is an internal inconsistency, not just a one-off.
Component: `client/src/pages/Workspaces.tsx`.

**P2-4 — Dead "Coming soon" controls sit inline with live ones.**
The composer's left action row (`ChatInput.tsx` L453–462) leads with a permanently
**disabled `Plus` "Coming soon"** icon button immediately left of the working
paperclip. The sidebar likewise renders disabled **Toolbox** and **Artifacts** nav
rows ("Coming soon" tooltips, `ChatSidebar.tsx` L422–453). Shipping visible dead
controls in primary surfaces invites "is this broken?" on first look. Consider hiding
until implemented rather than showing greyed-out placeholders. Components:
`ChatInput.tsx`, `ChatSidebar.tsx`.

### P3 — nitpick

**P3-1 — Loading skeleton implies an avatar the real messages don't have.**
`ChatWindow.tsx` L427–449 renders a per-message skeleton with an `h-8 w-8 rounded-full`
avatar circle, but actual assistant messages (`ChatMessage.tsx`) have **no avatar** —
they're full-width markdown blocks. The skeleton shape doesn't match what loads in,
causing a small layout "pop." Component: `client/src/components/chat/ChatWindow.tsx`.

**P3-2 — Two near-identical empty states with slightly different copy.**
`ChatWindow.tsx` has an outer no-conversation empty state ("Send a message to start a
new conversation. If you need specialized capabilities, I'll find the right tools…",
L411) and an inner no-messages state ("Send a message to start the conversation. The
AI assistant will respond…", L464). Same moment to the user, two different blurbs and
two different icons (`MessageSquare` vs `Bot`). Pick one voice. Component:
`ChatWindow.tsx`.

**P3-3 — Export/rename live only in the sidebar row menu, not the open chat.**
When a conversation is open, the header (`ChatLayout.tsx` L182–274) has no
rename/export affordance — those are only on the sidebar row's `⋯` dropdown. A user
viewing a long chat must scroll the sidebar to the right row to export/rename it.
Minor, but a header-level "⋯" would be more discoverable. Component:
`client/src/components/chat/ChatLayout.tsx`.

---

## Things that are GOOD (so they aren't "fixed" by mistake)

- **New-workspace dialog** (browser-verified): clean radio-card Private/Shared
  selector, clear labels, good spacing. No issues.
- **Workspaces page** empty + populated states render cleanly; search box present;
  card shows icon, Private badge, chat count.
- **ContextBudgetIndicator**: correctly renders nothing until there's a known window
  AND used > 0, hides on mobile (`hidden sm:flex`), tone-colored bar + tooltip. Solid.
- **CompactButton**: budget-gated visibility (≥70%), lossless copy, label hides on
  mobile. Solid.
- **ChatSidebar**: inline rename has a carefully-handled focus/blur race (commit on
  Enter only); search filters title/agent/preview; per-row export/move/delete; loading
  skeletons; sensible empty-state copy. Well-built.
- **Attachment chips** (`ChatInput` + `ChatMessage`): `max-w-[160/180px] truncate`
  with a `shrink-0` remove button — the long-filename overflow is already handled, no
  overlap. Drag overlay, paste-to-attach, and per-message-cap toasts all present.
- **Header crowding**: each header item is `shrink-0` or `hidden sm:flex` and the
  title is `truncate flex-1 min-w-0`; no overlap found even with the admin
  model/token/cost cluster added.
- The teal "blue" buttons are **not** a bug — `--primary` is `oklch(.6 .13 220)`,
  a genuinely blue-leaning teal at hue 220; the buttons use `bg-primary` correctly.

## Screenshots
`/tmp/ux-chatv2/` — `02-chat-empty.png`, `10-workspaces.png`,
`11-ws-create-dialog.png`, `13-ws-after-create.png`, `21-ws-list-full.png`.
