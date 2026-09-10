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
