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
