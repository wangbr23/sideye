# Journal

Append-only. One entry per work session. Newest at the bottom. Do not edit past entries; if something is wrong now, say so in a new one.

## 2026-09-10 — project created

Initialized project scaffold (AGENTS.md, CLEANCODE.md, decisions log, and TODO). Nothing built yet.

## 2026-09-10 — grilled the Sideye code-review MVP into a spec

Ran a grilling interview over the Sideye idea (OpenCode plugin opening a browser review platform over worktree/commit diffs, AI explanations, feedback loop to the agent, swe-factory lesson integration). Settled 28 decisions across scope, review targets, surface/snapshots, analysis, handoff, and lesson capture; recorded four load-bearing ones in `docs/decisions.md`. Spec: `docs/specs/sideye-code-review-mvp.md`. Open items needing prototypes: review UI feel, large-diff behavior, analysis prompt tuning.

## 2026-09-10 — design review pass on the MVP implementation design

Drafted `docs/designs/2026-09-10-sideye-code-review-mvp.md` and ran the review step without the independent reviewer (Codex hit its usage limit; the design-reviewer subagent was unavailable), so the critique was a self-review against the spec, decisions log, and swe-factory source. Seven findings, all accepted: in-process server instead of a detached child (kills orphan risk and `sideye stop`), per-launch bearer token on the loopback API, prompt-injection framing for diff content, no bundler, `.gitignore`-respecting untracked capture with size caps, single-active-review enforcement, and a CLI-launch acceptance scenario. One new architecture decision logged in `docs/decisions.md`; rollout order written into `TODO.md` as T1–T8.

## 2026-09-10 — low-level design + reusable /lld command

Added a low-level design (`docs/designs/2026-09-10-sideye-code-review-mvp-lld.md`) deriving the MVP into package layout, data model, HTTP API, three flow sequences, the git capture pipeline, session integration, and test mapping. It pins the mechanisms the HLD left open, most notably cross-process review reuse: a 0600 lockfile in TMPDIR carrying port+token so a second launch can return the existing URL — a bounded, documented weakening of the "other local processes can't read review data" stance, flagged as an open question. Also created a reusable global skill (`~/.config/opencode/skills/low-level-design`, mirrored to `~/.claude/skills/`) plus a `/lld` slash-command wrapper, so future projects get the same HLD→LLD derivation flow. Restart opencode to load the new skill/command.

## 2026-09-10 — review API opened to local agents (split auth)

Decision made in session: the per-launch token no longer guards every route. The read/comment surface (state, events, comments, questions) is now open to any local agent with a required author label — enabling second-opinion agents to read a review and comment like co-reviewers — while submit, plan approval, and round capture stay gated by the reviewer token embedded in the human's URL. Comments from any author are treated as untrusted data in prompts, like diff content. Supersedes the token-auth portion of the 2026-09-10 implementation-architecture decision (new decisions entry appended); spec, HLD, LLD (§4 and cross-references), and TODO T1 updated to match.

## 2026-09-10 — T1 done: package scaffold + data model types

Committed the planning docs left uncommitted by prior sessions first, then completed T1: package.json (bin `sideye` → src/cli.ts, exports → src/index.ts, test/typecheck scripts), strict tsconfig (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `src/types.ts` ported verbatim from LLD §3, placeholder entry files for cli/index, and a type-shape smoke test under `bun test`. Dev deps: typescript, @types/bun. Verified: `bun test` 3 pass, `bun run typecheck` clean. Next unblocked: T9, T11, T12, T18 (all depend only on T1).

## 2026-09-10 — T9 done: worktree tracked-diff capture

`src/git/capture.ts` runs `git diff HEAD` + `git diff HEAD --numstat` via Bun `$` with repo cwd, returning raw text for T11's parser (numstat carried now so binary detection lands wholly in parse). Empty diff is valid (clean worktree); git failures propagate. Real-repo tests under `bun test` (temp fixtures, 6 cases: clean, unstaged, staged, mixed, untracked-excluded, non-repo throws). Loop decision: user asked for ~6 agent tasks per batch without /compact (they compact manually between batches).

## 2026-09-10 — T10 done: untracked-file capture with caps

`captureUntrackedFiles` reads `??` entries from `git status --porcelain=v1 -z -uall` (`-uall` added so untracked dirs expand to files), embeds each as a synthetic added-file hunk. Caps per LLD §6: 100 KiB/file → `truncated` + clipped (whole lines); 50 files → rest path-only (`hunks: []`, `truncated: true`). One extension beyond LLD text: NUL-byte sniff (first 8 KiB) marks untracked binary files `binary: true` with no hunks, mirroring tracked binary detection, so binary content never enters prompts/UI. 8 new tests; suite 17 pass, typecheck clean.

## 2026-09-10 — T11 done: unified-diff parser

`parseDiff(diffText, numstatText)` walks raw git diff text into DiffFile[]/Hunk[]: added/deleted/renamed/modified statuses, hunk counts (count-less `@@ -3 +3 @@` defaults to 1), `\ No newline` marker handling, CRLF-safe content (trailing `\r` stripped), binary via numstat `-` rows (brace-form rename paths supported) with the diff-body `Binary files` line as fallback. 12 tests; suite 29 pass, typecheck clean. One test-fixture fix along the way: git always emits `a/`/`b/` prefixes even for deleted files.

## 2026-09-10 — T12 done: review server skeleton + auth tiers

`startReviewServer` on `127.0.0.1:0` (throws if Bun reports no port) with a `handlers` map keyed `"METHOD /path"` that later tasks extend, `generateReviewerToken` (32 random bytes base64url), timing-safe bearer check on the four control routes (401 without/malformed token; 404 until real handlers land), static serving for exactly `/`, `/app.js`, `/style.css` from `frontend/` (placeholders committed; real UI is T16), `/api/health` with repoPath for lockfile reuse. Real-server tests on ephemeral ports. Suite 34 pass, typecheck clean.

## 2026-09-10 — T2 done: commit-target capture

`captureCommitDiff(repoPath, sha)`: merge detection via `git show -s --format=%P` (2+ parents → clear rejection error), root commit via `git diff-tree --root -r -p/--numstat --format=`, otherwise `git diff <first-parent> <sha>` + numstat. 4 tests (first-parent diff, root commit, merge rejection, invalid sha); suite 38 pass, typecheck clean. Frontier-order correction: T2 became unblocked alongside T13 (T10+T11 done) and is lower-numbered, so it went first — recompute the frontier every round, not just once.

## 2026-09-10 — T13 done: AppState store + round assembly

`src/server/state.ts`: `createState` (plain AppState with token/sessionID/repoPath/target, empty rounds/comments/analysis/sseClients), `captureTarget` (worktree → tracked diff + untracked; commit → commit diff, untracked ignored), `parseRoundFiles` (parsed tracked files + synthetic untracked files), and `captureRound` appending frozen Round N+1 — clean worktree gives a valid file-less round. 6 store/assembly tests; suite 44 pass, typecheck clean. Comment/analysis/submission mutators intentionally deferred to T15/T19/T21.

## 2026-09-10 — T14 done: state projection + SSE channel

`projectState` serves the open tier everything reviewers and agents may read but **excludes the reviewer token and SSE client set** (the token only ever travels in the reviewer URL). `buildHandlers(state)` maps `GET /api/state` and `GET /api/events`; `sse.ts` fans out `event:`/`data:` frames to all connected controllers and drops failed/cancelled ones. `http.ts` now consults the handler map for open-tier routes too (control routes keep the bearer guard first). One LLD mechanical correction: `AppState.sseClients` is `Set<ReadableStreamDefaultController<Uint8Array>>` — the actual push mechanism — not `WritableStream` as sketched. Real-stream tests: token non-leak, SSE connect/fan-out/drop. Suite 48 pass, typecheck clean.

Stopped after 8 tasks (T1, T9, T10, T11, T12, T2, T13, T14) — user asked for ~6 then a manual /compact. Remaining frontier when resuming: T15, T16, T17, T18.

## 2026-09-10 — T15 done: open-tier comments route

`addComment(state, input: unknown)` in `src/server/state.ts` validates and appends: author required (400 per LLD §4 — attribution, not auth), non-empty body, scope must be inline/file/overall. Anchor validation against frozen rounds: `anchor.round` must be an existing captured round; overall scope forbids file/hunkIndex/lineRange; file scope requires an existing file path and forbids hunk fields; inline requires an existing file+hunkIndex and validates optional `lineRange` against the hunk's new-side span (`newStart..newStart+newLines-1`). Route `POST /api/comments` wired in `routes.ts` (open tier, no token): malformed JSON/invalid input → 400 with a specific error message (agents consume this surface, §11.5), success → 200 with the created Comment. isLesson defaults false when omitted.

Interpretation note: LLD says lineRange is "within the hunk's new-side lines" without pinning coordinates — implemented as new-side file line numbers (newStart..newStart+newLines-1), which is the only coordinate set the stored hunk makes checkable. Comments intentionally not broadcast via SSE — LLD §4's event list has no comment event; consumers refetch /api/state.

Tests: state.test.ts (round-scoped anchoring after later captures, 11-case validation table, file/overall scope shapes), auth.test.ts (real-server open-tier POST without token, 400 no-author/blank-author/bad-JSON, comment visible in /api/state). Suite 56 pass, typecheck clean. Also ran the real server manually against this repo and exercised POST /api/comments via fetch (200/400/400 + state projection) as an end-to-end check.

## 2026-09-10 — T16 done: read-only diff frontend

Vanilla-DOM frontend (no framework/bundler, LLD §8): `index.html` shell (header with target label + round selector, split diff-pane/side-panel), `app.js` renders from `/api/state` JSON, `style.css` with add/del coloring and status badges. All content is inserted via `textContent`/DOM APIs — diff paths and content are untrusted data, no innerHTML. Hunks render lazily via IntersectionObserver (placeholder striped box sized from line count, swapped in ~300px before viewport; binary/truncated files get header notes, no content). SSE: EventSource on `/api/events`; named events (analysis.update/answer/plan.ready/status.ready/round.prompt) trigger a full `/api/state` refetch; `onopen` (initial + every reconnect) resets failures, hides banner, refetches; 3 consecutive `onerror`s show the persistent reconnect banner per LLD §8/§9. Latest round selected by default; user selection sticks across refetches.

Browser-verified end to end with Playwright against the real server serving `frontend/`: diff renders with line numbers/origins; round selector switches rounds; below-viewport hunks stay pending until scrolled (3 pending → rendered on scroll); killing the server shows the banner; a fresh server renders 3 rounds with latest selected and banner hidden. Note: the transient-recovery path (server returns on the same port) wasn't browser-provable — a dead review stays dead by design (§9, "review dies with its launcher"); banner-show and refetch-on-open are each verified separately. Suite 56 pass, typecheck clean (frontend/ is outside tsc include — plain JS by design).

## 2026-09-10 — T17 done: launch orchestration

`src/launch.ts`: `launchReview({ repoPath, sessionID, target, openBrowser? })` → (1) in-process Map guard keyed by repoPath returns the existing URL (LLD §2: refuse second in-process start); (2) lockfile reuse — `$TMPDIR/sideye/<sha256(repoPath)>.json` mode 0600 holding only `{repoPath, port, reviewerToken, pid, createdAt}` (connection metadata, never review data); reuse requires pid alive AND `GET /api/health` answering with the same repoPath, else the lock is removed and taken over; (3) fresh start builds state, **captures round 1 inside launch** so capture failures (merge target, bad sha) surface at launch with a clear error (§9 "rejected at launch") — a decision beyond the LLD's launch text, which lists capture under flow (b); (4) reviewer URL `http://127.0.0.1:<port>/?reviewer=<token>`; (5) best-effort `open`/`xdg-open`, failure swallowed. staticDir resolves to `../frontend` relative to launch.ts (source-run layout; matches the no-bundler stack). `stopReview(repoPath)` exported for teardown/tests.

Cross-process reuse is proven against real child bun processes (lockfile + alive pid + healthy endpoint), plus dead-pid takeover, dead-port takeover (health check fails), and corrupt-lockfile takeover. Bun gotcha worth keeping: `subprocess.exitCode` stays `null` forever after `kill()` in Bun 1.4 — `await child.exited` is the reliable signal; the dead-pid test hung 5s on this until switched to `.exited`. End-to-end manual run: process A launched (browser opened), curl 200 on the reviewer URL; process B (separate bun process) reused A's URL verbatim; killing A, next launch took over fresh. Suite 62 pass, typecheck clean.

## 2026-09-10 — T18 done: OpenCode session client link

Added `@opencode-ai/sdk@1.18.30` and `src/session/client.ts`: `createSessionClient({ baseUrl, healthTimeoutMs? })` builds the SDK client and runs a loud startup health check (LLD §7): `client.global.health()` must return `healthy: true`, with a bounded `AbortSignal.timeout` (default 3s) applied via a custom `fetch` wrapper that only guards `/global/health` — blocking prompts (T19+) legitimately run for minutes, so the timeout must not leak onto other requests. All failure modes (SDK puts fetch/HTTP errors in `result.error` instead of throwing — discovered, not documented) funnel into one message: `OpenCode health check failed at <baseUrl>: <reason>` with the cause attached.

Surface choice: the package's v2 surface (`@opencode-ai/sdk/v2`) is the only one with `global.health()` (the legacy surface's Global class has just `event()`); docs were ahead of the legacy surface. Bun gotcha: `typeof fetch` under Bun types carries a `preconnect` property — the custom fetch wrapper satisfies it via `Object.assign(fn, { preconnect() {} })` without a cast.

Tests use a real stub HTTP server (healthy, unhealthy body, HTTP 500, hung response with 200ms healthTimeout → bounded loud failure). E2E: ran a real `opencode serve --port 4466` (1.18.30) — client linked, health `{healthy:true, version:"1.18.30"}`, `session.list()` returned sessions. Suite 66 pass, typecheck clean.

## 2026-09-10 — T21 done: findings-accept and submit routes

`acceptFinding(state, { round, findingId })` (control tier): validates the finding exists in that round's analysis, rejects duplicates (no double-listing in the payload), records `{round, findingId}` on the new `AppState.acceptedFindings` array — a minimal data-model extension beyond the LLD's AppState (acceptance state had nowhere to live before submit); also projected in `projectState` so the UI can render accepted marks. `submitReview(state, { requests: string[] })` serializes the SubmitPayload: explicit requests first (origin "user"), then accepted findings resolved to their claim text (origin "accepted-finding"), `lessons: []` until T7's lesson-candidate plumbing lands. A submission is single-shot: second submit → 400 "a submission already exists" (the §5c flow proceeds one way — plan → approval → fix → status; no amend path is designed).

Routes `POST /api/findings/accept` + `POST /api/submit` wired in routes.ts (token-guarded automatically by http.ts); the JSON-parse helper is now shared by all three POST routes. Fixed a latent test-helper bug while here: routes.test.ts's startServer generated its own token instead of using the state's — the real flow embeds the state's token in the server.

Tests: mutator table (accept/duplicate/unknown/bad-body, submit serialize + lock + malformed, empty payload) and real-server round-trips (token-guarded accept/submit, 400 validation, projection shows acceptedFindings + submission). Suite 72 pass, typecheck clean. The route tests run real Bun.serve with real bearer auth — end-to-end surface exercised there.

## 2026-09-10 — T19 done: analysis pipeline

`runAnalysis(state, round, client)` in a new `src/server/analysis.ts` (the LLD §2 layout has no slot for the pipeline — placed next to the server state/SSE it orchestrates; deviation noted). Batching per LLD §5b: ≤5 files or ≤400 changed lines, whichever trips first, binary/hunk-less files excluded (batching + caps live in `session/schemas.ts` next to the caps constants). Per batch: blocking `session.prompt` (SDK v2: `client.session.prompt({ sessionID, parts, format: { type: "json_schema", schema } })` — v2 flattened the legacy path/body args, and structured output sits on `info.structured`) → zod validation → one repair retry with the zod issues appended → plain-text fallback: the batch's raw text parts land in the new optional `AnalysisResult.unparsed` (data-model extension for the LLD's "unparsed analysis" pane). `info.error` (e.g. StructuredOutputError) takes the same retry path. Batches merge; result stored in `state.analysis`; `analysis.update` SSE broadcast; merged result returned. Transport failures propagate loudly.

Added `zod@4.6.1` — `z.toJSONSchema()` produces the schema sent to the model, so validation and prompt-schema can't drift. `session/client.ts` re-exports `AssistantMessage`/`Part` SDK types for downstream modules.

Honest boundary: tests run the full path (real client link + health check, real HTTP `session.prompt`, real zod, real SSE) against a stub OpenCode server with queued responses — a live-model run needs a configured provider and spends tokens, so it's not automated; the HLD's manual acceptance list (T26) covers the real-model loop. Suite 79 pass, typecheck clean.

## 2026-09-10 — T20 done: Q&A route + prompt

`POST /api/questions` (open tier): body `{ author (required — the split-auth decision covers questions), question (required), anchor? }`. Anchor fields are independently optional (round → file → hunkIndex → lineRange, each requiring the previous and validated against the frozen round — looser than comment scopes, which forbid partial anchors per scope). `askQuestion` in state.ts resolves the anchor and builds the prompt via new `questionPrompt`/`renderAnchorContext` in session/prompts.ts (plain-text mode, no format; same sideye: prefix + data-not-instructions framing; anchor context quotes the referenced hunk with line numbers). No state mutation — questions are transient. Answer extracted from the response's text parts, returned in the HTTP response AND broadcast as SSE `answer` { question, answer }.

Plumbing: `buildHandlers(state, deps?)` now takes `{ client?: OpenCodeClient }` and `LaunchOptions` carries an optional client passed through — T8/T24 hand their linked client to the server here. Without a client the route 500s loudly ("OpenCode session is not linked") instead of pretending.

Tests: real review server + real stub OpenCode — answer in HTTP + SSE, prompt contains question/author/quoted hunk context, anchor-optional flow, validation table (author/question/bad round/hunk/range), unlinked-client 500. Same honest boundary as T19: live-model run not automated (provider credentials); HLD manual scenarios cover it. Suite 83 pass, typecheck clean.

## 2026-09-10 — T3 done: analysis panel UI

Side panel becomes tabbed (Analysis / Findings / Comments / Status — last two placeholder empty states until T4/T5/T7 fill them; Comments/Status still render after those tasks, just richer). Analysis tab: per-file purpose cards and per-hunk rationale cards, each with a colored confidence badge (green "evidence" / amber "inference") and quote-source citation chips; failed-batch text renders in a distinct "Unparsed analysis" pane. Findings tab is the visually distinct section (red-bordered cards): id, claim, optional file·hunk locator, citations, and an "Accept as request" button posting `{round, findingId}` with `Authorization: Bearer <reviewer token from ?reviewer=>` to the T21 control route; accepted state (from /api/state projection) renders a green "accepted" badge and removes the button. Accept failures surface as an inline error note; the analysis content itself stays open-tier read-only.

Browser-verified end to end against the real server with injected analysis: tabs switch, both analysis sections render with badges/citations, accept succeeds (badge flips, button gone, second finding untouched), and the no-token path shows "Accept failed (401): reviewer token required" inline. Test suite untouched (frontend is outside tsc/bun test) — 83 pass, typecheck clean.

## 2026-09-10 — T8 done: `sideye review` CLI launcher

`src/cli.ts` implements the full CLI flow (LLD §5a, HLD §3): optional `review` subcommand + `[commit-sha]` + `--repo <path>` arg parse; commit targets pre-flight `captureCommitDiff` so merge/invalid-sha rejections surface BEFORE any server or browser exists (§9) — Bun's ShellError wraps git's real stderr as a non-string property, so the CLI unwraps `err.stderr` for a readable message ("commit target rejected: fatal: ambiguous argument …" — the raw message was just "Failed with exit code 128", which is how the argv bug got found: "review" was being parsed as the sha). New `session/cli-connection.ts`: `connectCliOpencode()` boots a dedicated headless OpenCode via the SDK's `createOpencodeServer` (spawns `opencode serve`, port 0, 15s timeout) and links a client; the URL is returned explicitly (the SDK client does not expose its baseUrl — an earlier `_client.config` peek failed and was removed). Then `createSessionClient` loud health check, `session.create` dedicated session, `launchReview` (client passed through T20's plumbing), print the reviewer URL, and hold the process — SIGINT/SIGTERM → `stopReview` + server close; the review dies with the process by design.

Server fix discovered live: Bun.serve's default 10s `idleTimeout` was killing quiet SSE connections (browser tab kept reconnecting every 10s) — `idleTimeout: 255` (Bun's max) in `startReviewServer`; drops beyond that are survivable by design (frontend reconnect-refetch loop).

CLI e2e tests spawn the REAL `opencode` binary (skipped loudly if absent): URL launch with commit target (state shows commit sha + files, untracked excluded, session id present), SIGTERM ends the review (health unreachable), second CLI run reuses the first's reviewer URL via the lockfile, invalid sha fails loudly, --help. Spawn-heavy tests carry explicit 30s timeouts (bun's default 5s was too tight under full-suite load, and the orphaned read promise then rejected unhandled between tests). Three consecutive full-suite runs green: 87 pass, typecheck clean.

## 2026-09-10 — T4 done: comments UI + Q&A UI

All in `frontend/` (app.js now ~530 lines of plain DOM code — the whole frontend logic; split candidate if it grows further, noted). Commenting per LLD §8: gutter click on a diff line → inline form mounted at that line (new-side/context lines anchor `lineRange [n,n]`; deleted lines have no new-side number → hunk-anchored without lineRange, form lands at hunk end); per-file header button → file-scope form under the header; header "Comment" button → overall form at the top of the Comments tab. One shared draft state (`openForm`) survives re-renders — SSE reconnects/refreshes re-mount it with text intact (the lazy hunk renders immediately when a draft targets it). Author is fixed `"human"` (the browser's identity); mark-as-lesson checkbox posts `isLesson`; failures show inline in the form.

Comments tab: round-scoped list (anchor.round === selected), each card showing author, scope tag, anchor location, lesson badge, body. Q&A: ask box (author "human", no anchor from this UI in MVP) → POST /api/questions → answer renders as a Q&A card; SSE `answer` events (other tabs) append too.

Bug found in browser e2e and fixed: the answer appeared TWICE in the asking tab — the server broadcasts the SSE event BEFORE returning the HTTP response, so both the event listener and the response handler logged it. Fix: the route now issues an `answerId` in both the SSE payload and the HTTP response; both client paths dedupe by id. Also fixed a latent T3 issue: two `as`-casts in app.js (invalid JS — Bun transpiles them on serve, which masked it; `node --check` caught it) removed; frontend is now plain valid JS.

Browser-verified end to end with a stub OpenCode behind the real server: gutter/file/header forms post correctly (server cards show exact anchors: `hunk 0 · lines 14-14`, file, overall), lesson badge on the marked comment, ask → single answer card. Suite 87 pass, typecheck clean.

## 2026-09-10 — T22 done: plan flow

`src/server/plan.ts`: `runPlan(state, client)` — one blocking structured prompt (`sideye: code review fix plan`) over the submission's requests (id, text, origin, plus the linked comment's body when a request carries commentId), zod `planOutputSchema` ({ perRequest: [{ requestId, approach, affectedFiles }] }, flat) with the analysis pattern: one repair retry with issues appended, then a LOUD failure — decided deliberately: the plan is load-bearing for the fix flow and the LLD designs no plan fallback surface (the plain-text fallback pane is an analysis concept). Idempotent: a stored plan is returned as-is. `storePlan` writes `state.submission.plan` and broadcasts `plan.ready` { plan }.

Route wiring: POST /api/submit now — with a linked client — awaits runPlan and responds { payload, plan }; plan-prompt failure → 500 with the payload still stored (documented consequence: re-submit stays blocked; no re-plan route exists in the LLD — if acceptance surfaces a need, that's a design question, not a silent patch). Without a client (T21 test fixtures, unlinked installs) → { payload, plan: null } — the flow is inert anyway without a session. POST /api/plan/approve (control tier): requires submission + plan, sets planApproved once, 400 otherwise (not submitted / no plan / already approved).

Tests: real-server round-trips with stub OpenCode — plan prompt content (request texts, origins, finding claims), plan.ready SSE, retry-then-500 (payload kept, plan unset), approval guard table, plan-null submit. Suite 91 pass, typecheck clean.

## 2026-09-10 — T23 done: fix + status flow

`src/server/fix.ts`: the plan-approve route fires `startFixAndStatus` (fire-and-forget, errors contained → `submission.statusError` + `status.ready` { error } — never thrown into the void). `runFixAndStatus` sends the edit-authorizing prompt via **prompt_async** (LLD pins the result mechanism as session.idle watching, not a blocking HTTP wait — the run can take minutes): "you are now authorized to edit files", per-request planned approach + affected files + request text (+ linked comment bodies), and requires per-request statuses (`addressed|partial|blocked|declined` + reason) with checks from the project's AGENTS.md Commands (the repo agent reads AGENTS.md itself; the prompt requires reporting them as `{command, passed, summary}`). zod `fixOutputSchema` validates the report read from the latest assistant message after `session.idle`; one repair retry; then `submission.statusError`. Stall: no idle within 10 min (configurable for tests) → `submission.stalled` + `status.ready` { stalled: true } — review stays usable (§9). Data-model extensions documented in types.ts: `stalled?`, `statusError?`.

SDK mechanics learned the hard way: (1) `return` from inside `for await` closes the SSE generator — the repair pass must keep waiting on the same stream, so `waitForIdle` iterates with `.next()` and leaves the generator paused between waits; (2) stream-end without a matching idle resolves false, not true; (3) idles for other sessions are filtered by `properties.sessionID`.

Test-stub hardening (this was causing cross-file full-suite failures): the fix-stub's /event now supports multiple subscribers with guarded enqueues (a leaked SDK SSE client reconnecting to a recycled port must not break the current test), and stubs 404 unknown paths without reading bodies (leaked retries previously hit `req.json()` on GET /event → SyntaxError attributed to random files). Full suite green twice consecutively: 95 pass, typecheck clean. Honest boundary: statuses come from a stub OpenCode over real HTTP + real SSE; a live-model fix run (which edits a repo) belongs to T26's manual scenarios.

## 2026-09-10 — T6 done: round capture route

`POST /api/rounds` (control tier) via `captureConsentedRound` in state.ts: gated on the fix flow having reached a terminal state — `submission.statuses` present OR `submission.stalled` (§9's "state remains reviewable" — a stalled session doesn't trap the review) — and one round per status report via the data model's existing `roundPrompted` flag (second consent → 400). On success: `captureRound` → round N+1, SSE `round.prompt` { round: n }, and — with a linked client — `runAnalysis` fired in the background for the new round (failures contained to console.error; the UI shows "no analysis yet"). Prior-round viewability is inherent to the anchor design (comments keep `anchor.round`; nothing remaps) and asserted end-to-end: comment posted on round 1 survives round 2's capture with its anchor intact in the projection.

Multi-cycle note: the LLD designs one submit→fix→consent cycle per review (submission is single-shot per T21); the test simulates the second consent by resetting `roundPrompted`/`statuses` — a real second cycle would need a submission reset that isn't designed. Tests: gating (no report → 400), consent → capture + round.prompt SSE + one-per-report, stalled consent allowed, anchor persistence across rounds, background analysis prompt for the new round. Suite 100 pass, typecheck clean.

## 2026-09-10 — T5 done: handoff UI (full review loop closes)

Header gains a Submit button → Status tab. The tab renders the submission state machine from /api/state: no submission → submit card (one request per line textarea + accepted-findings count; accepted findings join server-side) → POST /api/submit with the reviewer token; plan present → FIX PLAN card (per-request origin tag, text, approach, affected files) + "Approve plan — authorize edits" → POST /api/plan/approve; approved → STATUS REPORT card (per-request status badge addressed/partial/blocked/declined, reason, ✓/✗ check rows) plus degradation notes for stalled (§9 message) and statusError, and the round-consent card → POST /api/rounds. All failures render as inline error notes; every action ends in refresh().

Browser e2e against a stub OpenCode over the real server exercised the WHOLE loop: submit → plan card renders from the stub plan → approve → (prompt_async + idle SSE behind the scenes) → status report card with check rows + consent card → capture → Round 2 appears in the selector. Debugging note: the e2e stub initially routed both the blocking plan prompt and the message-list read to one handler — they share the URL and differ by method (POST vs GET); the 500 surfaced in the UI as designed.

This was the last UI piece of the review loop. Suite 100 pass, typecheck clean.

## 2026-09-10 — T7 done: lesson capture plumbing

`src/lesson.ts`: `buildLessonCandidates(state)` maps lesson-marked comments to LessonCandidates — excerpt (body truncated at 200 chars + ellipsis) and full provenance (source "sideye", repo, target rendered "worktree"/"commit <sha>", round, file/hunkIndex/lineRange when present). `submitReview` now serializes them into the payload (replacing the T21 placeholder empty array) — only lesson-marked comments, never all comments.

Fix prompt gains a lesson block only when lessons exist: each candidate as a quoted excerpt with round/file/hunk provenance, the instruction to propose each via `swe_factory_propose_lesson` before finishing (title/body/rationale/scope/provenance per the tool's schema), and the degradation instruction — if the tool is unavailable, the agent says so explicitly in the affected request's status reason (which the Status tab renders; §7 forbids eager probing, §9 maps absence to a reported degradation). No lessons → no block, no mention.

Tests: provenance completeness, truncation, payload inclusion (lessons ≠ all comments), empty-lessons submit, prompt block present/absent. Suite 106 pass, typecheck clean.

## 2026-09-10 — T24 done: OpenCode plugin entry

`src/index.ts` (the T1 package `exports` "." target) now exports `SideyePlugin` using `@opencode-ai/plugin`'s `Plugin`/`tool` helpers: the `sideye_open_review` tool takes an optional `commit` zod arg (tool.schema = zod), executes with the tool context's `sessionID` + `worktree` (the originating session, per §5a), and calls `launchReview` — reuse included. Two notable mechanics: (1) the plugin context's handed-out `client` is the LEGACY SDK surface while every sideye session flow speaks v2 — the plugin instead builds its own v2 client from `PluginInput.serverUrl.origin`; (2) the tool runs the loud `createSessionClient` health check before anything else (§7 loud-and-early), so an unhealthy OpenCode fails before any review server or browser exists. The reviewer URL goes out as a TUI toast (best-effort try/catch) and returns as the tool result text, reused reviews labeled "(reused the existing review for this repo)".

Shipped `command/sideye.md` — the `/sideye [commit]` markdown command template (commands are markdown files, not program code — HLD platform contract) instructing the agent to call the tool; users copy it into their project's `.opencode/command/` (README covers install, T25).

Plugin tests drive the REAL tool path: plugin input → hooks → execute against a stub OpenCode (health + /tui/show-toast) with a real git repo — URL returned, toast fired, state bound to the tool context's sessionID, second call reuses via lockfile, unhealthy OpenCode → loud failure with no lockfile written. Suite 109 pass, typecheck clean.

## 2026-09-10 — T25 done: README

README covers: requirements (Bun + OpenCode + git), install (clone + bun install), both launch paths — CLI (`bun src/cli.ts review [sha] [--repo path]`, reviewer URL + process-lifetime note) and plugin (command template copy + npm registration when published / local symlink of src/index.ts into .opencode/plugins/, with the realpath-resolution note) — the review loop in four bullets, the experimental open agent API (state/events/comments/questions, attribution over auth, untrusted-attributed-data caveat), control-token note, and the stated limitations (process-local lifetime + lockfile trust model per §11.1, one submit/fix/consent cycle, honor-system author labels). Docs-only change; suite 109 pass, typecheck clean.

## 2026-09-10 — work loop session: T15–T25 done, stopping at T26 (manual)

Loop order this session: T15, T16, T17, T18, T19, T21, T16-adjacent frontend T3, T20, T22, T23, T6, T4, T5, T7, T24, T25 (frontier recomputed every round; T17/T18/T19/T21/T22/T24 became unblocked as dependencies landed). All agent tasks in TODO.md are now [x]; the only remaining task is T26 — the eight HLD manual acceptance scenarios (plus security spot-checks), which need a human with a real model and TUI and stay unchecked here. Final state: suite 109 pass across 16 files, typecheck clean, working tree clean except the user's own untracked .opencode/ command file (never committed).

## 2026-09-10 — local plugin wiring + T27 added (npm publish)

Wired the plugin into this repo's own `.opencode/` for manual testing: symlinked `.opencode/plugins/sideye.ts` → `src/index.ts` (auto-discovered by opencode; imports resolve through the symlink to the clone) and copied `command/sideye.md` into `.opencode/command/`. T26 local test procedure: restart opencode in this repo, run `/sideye`.

Added T27 — publish to npm for third-party install, depends-on T26. Key blocker recorded in the task: the npm name `sideye` is taken by an unrelated package (v0.5.1), so a rename is required (candidate: `sideye-opencode` / scoped). Task also covers the missing `#!/usr/bin/env bun` shebang on `src/cli.ts` (the `bin` entry), a tarball content check for the plugin entry + command template, and the README npm-install section with the real name (the README currently carries placeholder `<package-name>` snippets marked as not-yet-published). Also added a "How it works" section to the README (entry points / frontend / session, process-local state).

## 2026-09-10 — T26 manual-testing fixes: UI overflow, duplicate comment forms, round-1 analysis bug

Three issues from the user's first real manual run (T26):

1. **Overflow** — diff lines painted past the pane border (`.diff-line` had `white-space: pre`), side-panel cards leaked (long unbroken paths/request text/check output), and the 4 panel tabs overflowed the 300px panel by 3px. Fix per the user's preference for wrapping over scrolling: `white-space: pre-wrap` + `overflow-wrap: anywhere` on `.content` and `.hunk-header` (row background now follows wrapped text), `overflow-wrap: anywhere` on all cards + `min-width: 0` on flex children, `flex-wrap` on `#panel-tabs`, `flex-shrink: 0` on badges/status tags so long text can't squeeze them into slivers (the "status disappeared" report).
2. **Four comment boxes on one line click** — `renderHunkInto` appended the comment form after every line where the anchor check fell through (deleted-line clicks → one per line plus hunk end). Now a `formPlaced` flag places exactly one form directly after the clicked line; deleted lines still anchor to hunk end, with a truncation fallback.
3. **No analysis/findings ever (real bug)** — round 1 was captured at launch but `runAnalysis` only ran from `POST /api/rounds`, i.e. only consent-captured rounds after a fix were ever analyzed; the round a reviewer actually lands in was never analyzed. Fixed in `launchReview`: round-1 analysis starts in the background at launch (guarded on `options.client`), mirroring the `/api/rounds` pattern. Regression test added: launch with a stub-OpenCode client → poll `/api/state` until round 1 has analysis with files+findings.

Verification method worth repeating: throwaway Bun stub serving `frontend/` with synthetic worst-case state (300-char lines, unbreakable strings, long badges) + Playwright DOM assertions (form counts per click path, per-element right-edge overflow scan, scrollWidth deltas). Suite 110 pass, typecheck clean.

## 2026-09-10 — inline comment display under the diff line

Feature request: posted comments previously appeared only in the Comments tab; the user wanted them also visible under the line they were left on. Frontend-only change (server already serves every comment with its anchor in `/api/state`, and validates inline `lineRange` against the hunk at post time — rounds are frozen, so an anchored start line always renders). `renderHunkInto` now groups the selected round's inline comments by `lineRange[0]` and appends compact cards (author, lesson badge, body) right after the matching row, in `createdAt` order; deleted-line comments (no `lineRange`) land at hunk end next to the form fallback. File/overall comments deliberately do not render inline. Draft form ordering unchanged: a line's posted cards render before that line's draft form. Verified with the throwaway stub-server + Playwright method (2 cards on one line, lesson card, deleted-line card, 300-char unbroken body → zero right-edge overflows; form placement after existing cards; lazy hunk renders comments on scroll; Comments tab still lists all six). Suite 110 pass, typecheck clean.

## 2026-09-10 — comment deletion

Second feature request: delete comments. Server: `deleteComment` in state.ts (by id, not-found → error), `POST /api/comments/delete` handler, and the path added to CONTROL_ROUTE_PATHS — deletion is destructive to the shared review record, so it stays behind the human-control gate (posting remains open-tier per the multi-agent design). Already-submitted payloads are unaffected (lessons carry excerpts; request bodies resolve at plan/fix time). Frontend: Delete button on both inline cards and Comments-tab cards, native confirm() gate, error note on failure with button re-enable. Verified with the stub-server + Playwright method (cancel path, 401 path without token, success path removing the card from diff and tab, zero right-edge overflow). Suite 115 pass, typecheck clean.

## 2026-09-10 — comments reach the agent on submit; lesson-marking is the swe-factory signal

User corrected a core design assumption: they left comments, pressed Submit, and "nothing happened" — because the LLD (§10 test mapping) explicitly excluded non-lesson comments from the submit payload. Per the user's spec: (1) every comment now joins the payload as a `comment`-origin request (id = comment id, submit-time snapshot of author + anchor so later deletion can't alter the work order), (2) lesson-marked comments additionally serialize as LessonCandidates for the swe-factory proposal instruction (unchanged), (3) plan → approve → fix → statuses → round consent untouched. The orphaned `commentId` field and its plan/fix-time body lookups were replaced by the inline snapshot. Empty submits (no comments/findings/requests) now 400 with "nothing to submit" instead of silently serializing an empty payload. Prompts render comment requests as `(origin: comment, author: X, round N, file F, hunk H)`; fix prompt adds a "comments may be questions — respond in the status reason" requirement; plan prompt gets the "plan a change when needed, otherwise say how you'd respond" line. Frontend: submit-card hint counts auto-joining comments, plan card tags `comment by <author>`.

Bonus find while verifying in the browser: the Status tab crashed with `Cannot read properties of undefined (reading 'perRequest')` right after any submit where the plan hadn't arrived — `submission.plan`/`statuses` are `undefined` (not `null`) after JSON serialization and the guards compared `=== null`. This was almost certainly the user's original "status seemed to say something but nothing happened" symptom. Fixed with truthiness checks. Verified end-to-end with the throwaway stub-server + Playwright method: comments-only submit → clean "Planning…" state (no crash), plan card shows the comment origin tag, zero right-edge overflows. Suite 118 pass, typecheck clean.

Open gap recorded in LLD §11.6: comments added after submit (e.g. round 2) still have no channel to the agent — re-submit is blocked by the one-submission guard.

## 2026-09-10 — header Submit button performs the real submit

The header "Submit" button previously only jumped to the Status tab — misleading after comments became the primary submit input. Per the user's choice, it now performs the actual submit: typed requests are read from the Status-tab card's textarea when it's on screen (read before render() rebuilds the panel), comments and accepted findings always join server-side, and on success the panel lands on "Planning…". Both entry points (header + card) share one `postSubmit` helper. Header button lifecycle: "Submit" → "Submitting…" (disabled) → "Submitted" (disabled once a submission exists), synced in every render. Empty-review 400s surface as an error note in the card with the button re-enabled. Verified with the stub-server + Playwright method (success, empty-review error, already-submitted disabled state, typed-request path, zero right-edge overflows). Suite 118 pass, typecheck clean.

## 2026-09-10 — planning runs in the background; live planning/failure cards

Root cause of the "clicked submit and nothing seemed to happen" dead zone: POST /api/submit blocked on the plan prompt (which takes the agent's full generation time), so the only in-flight feedback was the header button label, and the "Planning…" state could never render (submission + plan landed atomically). The user's real run confirmed the mechanics worked — the payload had the comment and a plan arrived — but the experience was opaque, and the TUI prompt went to the session that launched the review (one of several running opencode windows).

Change, mirroring the fix flow's background pattern: `startPlanning` in plan.ts sets `submission.planning`, broadcasts `plan.pending`, dispatches runPlan, and clears planning on success or stores `planError` + broadcasts `plan.failed` on failure. The submit route returns immediately after serializing (`plan: null` always in the response now). New control route `POST /api/plan/retry` re-dispatches after a failure (previously a failed plan silently bricked the review — submission locked, no plan, no recovery). `projectState` gains `sessionLinked` so a client-less review renders an honest "no agent session is linked" note instead of eternal planning. Frontend: planning card (item count, sent items with origin/author tags, session id pointer, "can take a minute" note), plan-failed card with Retry button; SSE_EVENTS gains plan.pending/plan.failed.

On "should it show in the TUI": it already does — the sideye:-prefixed prompt lands in the session that opened the review; the planning card now names that session so the user knows which window to watch.

Tests reworked for the async flow (waitForSse/waitUntil helpers); new retry + guard tests; verified all four Status-tab states in the browser via the stub method (planning card, failure card + retry degradation without a client, no-session note, zero overflows). Suite 120 pass, typecheck clean.

## 2026-09-10 — validated plans now render in the originating TUI

Corrected the prior journal entry's assumption that structured plans were already visible in OpenCode's TUI. In OpenCode 1.18.30, `json_schema` mode stores the result on `AssistantMessage.structured` through the successful `StructuredOutput` tool; the TUI hides that tool by default and only renders ordinary assistant text parts, so the plan response appeared blank even though the browser received it.

After plan validation (including the repair-response path), `src/server/plan.ts` now formats the canonical plan plus each request's source/text and affected files as Markdown, then adds it to the same assistant message through `client.part.update`. This emits OpenCode's normal `message.part.updated` event, so the originating session renders the plan without a second model call or a markdown file. The mirror is deliberately best-effort: a missing/drifted part-update API logs a warning but leaves the browser plan and approval flow intact.

Tests assert the text part targets the validated assistant message, includes the browser plan content, uses the repair message after structured-output retry, and degrades without invalidating the plan on a part-update failure. Verification: focused plan suite 9 pass; full suite 122 pass; `bun run typecheck` clean.
