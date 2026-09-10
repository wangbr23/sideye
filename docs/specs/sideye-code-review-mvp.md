# Sideye Code Review MVP

**Date:** 2026-09-10
**One-line description:** An OpenCode plugin that opens a local browser review platform over any worktree diff or commit, explains the changes with cited project evidence, loops reviewer feedback back to the originating agent session, and feeds durable review lessons into opencode-swe-factory's long-term memory.

## Resolved decisions

### Product scope

- **Solo local developer.** The loop is one developer reviewing their own changes and handing feedback to their own OpenCode agent. No identity, sharing, or sync layer.
- **Milestone: usable local MVP** — an installable local workflow completing review → feedback → agent revision → re-review. Not a throwaway prototype, not a polished public release.

### Review targets

- **Worktree or single commit.** Default target is the current worktree's uncommitted changes (staged + unstaged + untracked, diffed against `HEAD`). Optionally one commit, diffed against its first parent. Arbitrary branches, ranges, and merge comparisons are out of scope for MVP.
- **Historical commits are reviewable read-only-with-fixes.** The agent may act on feedback from any commit, but fixes always adapt onto the *current* branch. When old-code assumptions conflict with current code, Sideye surfaces the conflict for human review instead of guessing (rejected alternatives: patch-forward via temporary worktrees; restricting reviews to HEAD).

### Surface and snapshot lifecycle

- **Local browser UI.** OpenCode documents command hooks but no custom full-screen TUI views, so the review experience is a localhost web app with room for rich diffs, explanations, and comments. Rejected: TUI-only (constrained, uncertain extension support), fork of OpenCode (kills distribution).
- **Launch paths.** `/sideye [commit]` slash command in OpenCode plus `sideye review [commit]` CLI for terminal use.
- **Versioned snapshot rounds.** Opening a review freezes the diff as round 1. Comments anchor to their round permanently. Each agent revision is captured as a new round only when the reviewer consents: when the agent finishes, the user is prompted whether they want a new round of review. Rejected: live-updating diff (comment anchors drift); close-after-submit (breaks the iterate loop).
- **Process-local state.** Review rounds and comments live in the running Sideye process only; closing the browser or restarting discards them. Deliberately accepted for MVP to avoid storage design work.
- **Local data boundary.** Source, context, comments, and history never leave the machine except model calls, which ride the user's configured OpenCode provider.

### AI analysis

- **Explain and flag, visibly separated.** Sideye explains what the diff does and flags possible issues; the two are visually distinct so inferred intent is never mistaken for a finding.
- **Evidence-grounded rationale with citations.** "Why this change" and "how it integrates with future work" draw on project evidence: relevant designs/specs, TODO.md, decisions log, AGENTS.md, OpenCode session context, and commit messages — each cited to its source. Roadmap speculation without evidence is out.
- **Missing evidence degrades gracefully.** When documentation is absent, stale, or unrelated, Sideye infers from code and Git evidence, labels it lower-confidence, and states which context was unavailable. It does not stop or nag.
- **Evidence vs. inference labeled.** Since arbitrary diffs carry no guaranteed intent, explanations state what is sourced and what is inferred.
- **Granularity: file + hunk.** Each file gets a purpose summary; each meaningful hunk gets a rationale; line-level detail on demand. Per-line explanations and overall-only summaries rejected as noise-starved extremes.

### Feedback and agent handoff

- **Three comment scopes:** inline (line/hunk), file, and overall.
- **Immediate Q&A, batched edits.** Explanation questions are answered in the UI in real time (routed through the session); change requests accumulate until Submit.
- **Submit sends explicit work only.** User-authored requests plus AI findings the user explicitly accepted. Never all comments, never auto-fix-everything.
- **Plan-then-approve.** Submit returns a plan; a second confirmation authorizes edits. Submit alone is not edit authorization.
- **Per-request resolution status.** After editing, each request is reported as addressed / partially addressed / blocked / declined with a brief reason — a bare diff is not enough.
- **Relevant checks before re-review.** Configured test/lint/typecheck/build commands affected by the changes run before the next round is offered; absence is stated plainly.
- **Human approval completes the review.** No automatic completion on agent reports or green checks.

### Lesson capture (opencode-swe-factory integration)

- **Reviewer-marked capture.** A "mark as lesson" control sits beside comment creation; only marked comments become lesson candidates. The agent judges global vs. project scope at proposal time. Rejected: agent-judging every comment (noisy), auto-capture of all findings (overrides human judgment).
- **Approval stays in the OpenCode session.** Proposals flow through `swe_factory_propose_lesson`; the human approves via the existing approval-card flow (`swe_factory_commit_lesson`). Sideye does not duplicate or bypass the approval UI.
- **Full provenance trace.** Proposals carry: source=sideye, repo, review target, round, file/hunk anchor, comment excerpt — so lessons trace back to the review that produced them.
- **Lessons flow back automatically.** swe-factory injects confirmed lessons into any session prompt it sees, so fix work and Q&A Sideye routes through the originating session pick up past review lessons with no extra plumbing.
- **Graceful degradation.** If swe-factory is absent, in private mode, or toggled off, Sideye skips capture and notes it in the UI rather than failing.

### Derived platform facts

- **Stack: TypeScript OpenCode plugin on Bun.** OpenCode plugins are JS/TS modules run by Bun with SDK access (`client.session.*`, `client.tui.*`, events); the CLI component shares the package. This is platform-dictated, not a free choice.
- **One active review per repo** at a time (process-local state makes this the simple case).
- **Analysis and Q&A run through the originating OpenCode session** (per the local-provider boundary), which is also what makes lesson injection work for free.

## Explicitly open / ungrillable

- **Review UI look and feel** — layout, density, visual polish. Needs a prototype to react to, not discussion.
- **Large-diff behavior** — rendering strategy and performance for very large diffs. Needs a prototype with real payloads.
- **Analysis prompt quality** — exact wording that yields good explanations. Tuned through use; pinned by examples later.

## Reasoning anchors

- Why browser over TUI: OpenCode's documented extension surface (commands, SDK, TUI event hooks) has no full-screen custom view; a browser app is feasible today and fits dense review content.
- Why snapshots: comment anchoring survives agent edits only if the reviewed diff is frozen; live diffs invalidate anchors mid-loop.
- Why originating session: it preserves intent context for fixes and gives swe-factory's retrieval injection a single place to act.
- Why approval-gated lessons: review comments mix one-off fixes ("fix this null deref") with durable conventions ("always use the repo's Result type"); the reviewer knows which is which, and swe-factory's human gate absorbs false positives cheaply.