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
