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

## 2026-09-10 — Implementation architecture: one package, in-process review server, token-authed loopback

**Status:** Accepted

**Context:** The MVP design (docs/designs/2026-09-10-sideye-code-review-mvp.md) needed a process shape. A detached review-server child process would have introduced orphan lifecycle management for no benefit given the already-accepted process-local state decision.

**Decision:** Ship one TypeScript/Bun package containing the OpenCode plugin entry, the `sideye` CLI, and a review server with a plain static frontend (no bundler). The server runs in-process inside whichever launcher started it (plugin process or CLI process) on an ephemeral loopback port, enforces one active review per repo, and requires a random per-launch bearer token on every API call so other local processes cannot read diffs or drive the review. Diff content is treated as untrusted data in all prompts, with plan-then-approve as the injection backstop.

**Consequences:** No child-process or shutdown management; a review ends when its launcher's process ends (consistent with the process-local decision); local-process access to review data is token-gated. Full context in [docs/designs/2026-09-10-sideye-code-review-mvp.md](designs/2026-09-10-sideye-code-review-mvp.md).

## 2026-09-10 — Open read/comment API for local agents; control routes stay reviewer-token-gated

**Status:** Accepted (supersedes the token-auth portion of the implementation-architecture decision above)

**Context:** The per-launch token on every API call blocked a capability the reviewer wants: other local agents (a second-opinion subagent, a lint bot) reading a review and commenting like co-reviewers. The token was also discoverable via the launch lockfile, so its privacy guarantee was already limited to honest-agent and cross-user boundaries.

**Decision:** The review API splits into two tiers. Read routes (state, events, static assets) and comment/question routes are open to any local process; comments require an author label and are treated as untrusted, attributed data in all prompts. A random per-launch reviewer token — held only by the URL the human opens — gates the control routes: submit, plan approval, and new-round capture. No local agent can move the review forward or authorize edits.

**Consequences:** Multi-agent review works with no extra plumbing; attribution replaces connection control on the open tier (honor-system — a local agent could claim "human"); the open API becomes a de-facto contract, kept tiny and marked experimental. The lockfile publishes the reviewer token to same-user processes, so the control tier protects against well-behaved agents and cross-user access, not malicious same-user code. Full context in the LLD §4 ([docs/designs/2026-09-10-sideye-code-review-mvp-lld.md](designs/2026-09-10-sideye-code-review-mvp-lld.md)).

## 2026-09-10 — Every review comment reaches the agent on submit; "mark as lesson" only controls swe-factory proposals

**Status:** Accepted (supersedes the comments-as-annotations-only behavior recorded in the LLD §10 test mapping, "never all comments")

**Context:** The original design treated comments as reviewer-facing annotations: only lesson-marked comments entered the submit payload (as LessonCandidates), and the agent never saw plain comments. The first real manual run surfaced the mismatch — the reviewer expected Submit to hand their comments to the agent, and a comments-only submit produced a silent no-op. The product owner corrected the intent: comments are work items for the agent, not just annotations.

**Decision:** On submit, every comment joins the SubmitPayload as a `comment`-origin request (request id = comment id) with a submit-time snapshot of `{ author, anchor }`, so the payload stays the immutable work order even if comments are deleted later. Lesson-marked comments additionally serialize as LessonCandidates; the lesson flag's only meaning is "propose this as a durable lesson via swe_factory_propose_lesson" in the fix prompt. Comment requests flow through the existing machinery unchanged: plan (per-request approach), approval gate, fix (per-request status — comment "requests" that are questions get answered in the status reason), round consent. An empty review (zero comments, findings, and typed requests) is rejected at submit instead of silently serializing an empty payload.

**Consequences:** The agent's plan and status report cover every comment, giving per-comment visibility ("was my comment addressed?"); question-style comments are answered via the status reason. Prompts include comment author and round/file/hunk location, keeping attribution intact for multi-agent review. The now-dead `commentId` linkage field and plan/fix-time body lookups were removed. Comments posted after submit (round 2+) still have no channel to the agent — recorded as LLD open question §11.6.
