# TODO

Current and near-term work. Mutable — edit freely, unlike the journal or decisions log.

Task format: `- [ ] \`T<n>\` <description> — <manual|agent>[, complexity: simple|complex][, depends-on: T<a>, T<b>]`. A task is safe to hand to a parallel agent once every id in its `depends-on` is checked off. See the `plan-tasks` skill.

## Foundation

- [x] `T1` Scaffold the sideye Bun package (package.json with bin/exports, tsconfig, Bun test setup) and define the shared data model types per LLD §3 — agent, complexity: simple, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T2` Capture commit targets: diff vs first parent, root-commit handling, merge rejection at launch — agent, complexity: simple, depends-on: T10, T11, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T3` Analysis panel UI: per-file purpose, per-hunk rationale, evidence citations, evidence-vs-inference labels, distinct findings section — agent, complexity: complex, depends-on: T16, T19, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T4` Comments UI (three scopes, round-anchored, author display, mark-as-lesson checkbox) + Q&A UI — agent, complexity: complex, depends-on: T3, T15, T20, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T5` Handoff UI: submit card, plan approval card, per-request status report, round-consent card — agent, complexity: complex, depends-on: T4, T21, T22, T23, T6, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T6` Round capture route (control tier): consent gating after status report, round.prompt event, prior-round comments stay viewable at anchors — agent, complexity: complex, depends-on: T13, T14, T23, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T7` Lesson capture plumbing: lesson candidates with provenance from lesson-marked comments, inclusion in submit payload, fix-prompt instruction to propose via swe_factory_propose_lesson, degradation note when the tool is absent — agent, complexity: simple, depends-on: T21, T23, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T8` `sideye review [commit]` CLI launcher: bin wiring, arg parse, connect/create OpenCode, dedicated session, launch — agent, complexity: complex, depends-on: T17, T18, T2, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md

## Capture and parsing

- [x] `T9` Worktree tracked-diff capture via `git diff HEAD` (staged + unstaged vs HEAD) — agent, complexity: simple, depends-on: T1, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T10` Untracked-file capture via `git status --porcelain -z` with size/count caps, truncation flags, synthetic added-file hunks — agent, complexity: simple, depends-on: T9, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T11` Unified-diff parser → DiffFile[]/Hunk[] with binary detection and rename mapping — agent, complexity: complex, depends-on: T1, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T12` Review server skeleton: Bun.serve loopback on port 0, static frontend serving, open vs reviewer-token control tiers (401 without token on control routes) — agent, complexity: complex, depends-on: T1, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md

## Server state and routes

- [x] `T13` AppState store plus round assembly (capture + parse → frozen Round) with empty-diff handling — agent, complexity: complex, depends-on: T10, T11, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T14` State projection route (`/api/state`) + SSE events channel (`/api/events`) — agent, complexity: simple, depends-on: T12, T13, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T15` Comments route (open tier): required author attribution, scope/anchor validation, 400 on missing author — agent, complexity: simple, depends-on: T14, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T16` Read-only diff frontend: page shell, hunk rendering from server JSON, round selector, SSE subscribe with reconnect refetch — agent, complexity: complex, depends-on: T14, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T17` Launch orchestration: lockfile single-review-per-repo reuse (pid + health check), server start, reviewer URL build, best-effort browser open — agent, complexity: complex, depends-on: T12, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md

## Session integration

- [x] `T18` OpenCode session client link with loud startup health check — agent, complexity: simple, depends-on: T1, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T19` Analysis pipeline: batched prompts through the originating session, zod schemas for structured output, retry + plain-text fallback, merge to AnalysisResult, analysis.update SSE — agent, complexity: complex, depends-on: T14, T18, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T20` Q&A route + prompt: blocking session prompt with anchor context, answer in HTTP response and via SSE — agent, complexity: simple, depends-on: T15, T19, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T21` Findings-accept and submit routes (control tier): accepted findings plus explicit requests serialize into SubmitPayload — agent, complexity: simple, depends-on: T15, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T22` Plan flow: plan prompt (structured per-request approach), plan.ready event, plan approval route (control tier) — agent, complexity: simple, depends-on: T20, T21, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T23` Fix + status flow: edit-authorizing prompt, per-request RequestStatus report, checks from AGENTS.md, session.idle wait with 10-minute stall timeout — agent, complexity: complex, depends-on: T22, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md

## Surfaces and packaging

- [x] `T24` OpenCode plugin entry: register `sideye_open_review` tool + `/sideye` command template + TUI toast with reviewer URL — agent, complexity: complex, depends-on: T17, T18, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [x] `T25` README with install and usage for both launch paths — agent, complexity: simple, depends-on: T8, T24, design: docs/designs/2026-09-10-sideye-code-review-mvp-lld.md
- [ ] `T26` Run the eight manual acceptance scenarios from the HLD verification list — manual, depends-on: T3, T5, T7, T25, design: docs/designs/2026-09-10-sideye-code-review-mvp.md
- [x] `T28` Give post-submit comments a channel to the agent (round 2+): either allow re-submitting newly added comments as a follow-up payload or inject them into an in-flight/next fix prompt; re-submit is currently blocked by the one-submission guard (LLD §11.6) — agent, complexity: complex
- [ ] `T27` Publish to npm so third parties can install without the repo: pick a package name (npm `sideye` is taken by an unrelated package v0.5.1), add a `#!/usr/bin/env bun` shebang to `src/cli.ts` so the `bin` entry runs, verify the plugin entry and `command/sideye.md` ship in the tarball, publish, then update the README install section with the real name — manual, depends-on: T26
- [x] `T29` Mirror each validated fix plan as Markdown in the originating OpenCode TUI session without a second model call — agent, complexity: simple
- [x] `T30` Remove empty duplicated unparsed-analysis panels and show explicit initial/analysis loading states — agent, complexity: simple
- [x] `T31` Stop CLI e2e cleanup from leaking orphaned OpenCode servers by terminating launcher processes gracefully before a bounded hard-kill fallback — agent, complexity: simple
