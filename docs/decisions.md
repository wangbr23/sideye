# Decisions

Append-only log of architecture decisions. One entry per decision, newest at the bottom. Do not edit past entries; a reversed decision gets a new entry that supersedes the old one.

## 2026-09-10 — Record architecture decisions

**Status:** Accepted

**Context:** We need a lightweight way to record why significant technical decisions were made, so future work by any contributor, model, or tool does not rediscover or accidentally reverse them.

**Decision:** Keep architecture decisions in `docs/decisions.md`, one entry per decision, appended chronologically. A changed decision gets a new entry that supersedes the old one.

**Consequences:** Decisions and their reasoning survive context resets, model changes, tool switches, and contributor turnover.

## 2026-09-10 — Review surface is a local browser UI launched via slash command and CLI

**Status:** Accepted

**Context:** Sideye needs a review experience with rich diffs, explanations, and comments. OpenCode documents command hooks and an SDK but no custom full-screen TUI views, so a native TUI surface is not currently feasible for a plugin.

**Decision:** The review platform is a localhost browser app, launched by a `/sideye [commit]` slash command in OpenCode and by `sideye review [commit]` from a terminal.

**Consequences:** Diff/explanation/comment UI is unconstrained by TUI rendering limits; Sideye is distributable as a normal OpenCode plugin. Full reasoning in [docs/specs/sideye-code-review-mvp.md](specs/sideye-code-review-mvp.md).

## 2026-09-10 — Reviews use consent-gated versioned snapshot rounds

**Status:** Accepted

**Context:** Comments must stay anchored while the agent edits the worktree in response to feedback; a live diff would silently invalidate anchors mid-loop.

**Decision:** Opening a review freezes the diff as round 1. Each agent revision becomes a new round only when the reviewer accepts the prompt for a new round; comments anchor permanently to their round. Review state is process-local (no persistence) for MVP.

**Consequences:** Stable comment anchors and a durable iterate loop at the cost of no cross-restart review state. Full reasoning in [docs/specs/sideye-code-review-mvp.md](specs/sideye-code-review-mvp.md).

## 2026-09-10 — Agent handoff runs through the originating session with plan-then-approve

**Status:** Accepted

**Context:** Feedback must reach an agent that can edit, while preserving intent context and keeping the human in control of what becomes work.

**Decision:** Submitted change requests return to the originating OpenCode session (CLI-only launches create a dedicated session). Submit sends only explicit requests and accepted findings; the agent first returns a plan, a second confirmation authorizes edits, each request gets a resolution status, relevant project checks run before the next round, and only explicit human approval completes the review. Historical-commit feedback always adapts onto the current branch with conflicts surfaced for human review.

**Consequences:** Fixes inherit session intent; the local data boundary holds (model calls only via the configured provider); review completion stays a human decision. Full reasoning in [docs/specs/sideye-code-review-mvp.md](specs/sideye-code-review-mvp.md).

## 2026-09-10 — Review lessons integrate through swe-factory's approval-gated proposal flow

**Status:** Accepted

**Context:** Review comments are a rich source of durable lessons ("always use the repo's Result type"), but opencode-swe-factory's design deliberately routes all lesson persistence through a human-approved, secret-scanned proposal flow and forbids direct SQLite writes as the integration surface.

**Decision:** A "mark as lesson" control on review comments triggers proposals via `swe_factory_propose_lesson` in the originating session; the agent judges scope; approval happens through swe-factory's existing approval card (`swe_factory_commit_lesson`); proposals carry full provenance (source, repo, target, round, file/hunk, excerpt). Sideye never writes to swe-factory's SQLite store directly. Lesson pickup on later work comes free from swe-factory's per-message session injection.

**Consequences:** Lessons stay human-gated and secret-scanned; Sideye depends on swe-factory being installed but degrades gracefully (skip capture, note in UI). Full reasoning in [docs/specs/sideye-code-review-mvp.md](specs/sideye-code-review-mvp.md).
