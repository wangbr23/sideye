# Sideye Code Review MVP — Low-Level Design

**Date:** 2026-09-10
**HLD:** [2026-09-10-sideye-code-review-mvp.md](2026-09-10-sideye-code-review-mvp.md)
**Spec:** [../specs/sideye-code-review-mvp.md](../specs/sideye-code-review-mvp.md)
**T28 amendment:** 2026-09-12 — repeatable submission cycles and revisionable plans

This document says *what will be implemented and how the pieces work together* — package layout, data model, API surface, flow sequences, and the mechanism choices the HLD left open (each pinned with its reasoning). It does not contain implementation code; type shapes and command lines only. It must be read together with the HLD, which holds the decisions and their rationale.

## 1. Overview

One Bun/TypeScript package ships three things that share one process shape: the OpenCode plugin entry, a `sideye` CLI, and an in-process HTTP review server with a static frontend. Opening a review captures a git snapshot (round 1), serves it in a browser on loopback — read/comment open to local agents, control actions gated by a per-launch reviewer token — and routes all model work (analysis, Q&A, plans, fixes) through the originating OpenCode session. Each frozen diff round owns one submission cycle whose plan may be revised repeatedly before approval; after an approved fix and consented capture, queued feedback starts the next round's cycle. Review state lives only in that server process; a review dies when its launcher dies.

## 2. Package layout

```
sideye/
├── package.json            # bin: { sideye: "./src/cli.ts" }, exports plugin entry, scripts (test: bun test)
├── tsconfig.json
├── src/
│   ├── index.ts            # plugin entry — registers sideye_open_review tool; no logic
│   ├── cli.ts              # `sideye review [commit]` — arg parse, connect/create OpenCode session, launch
│   ├── launch.ts           # shared launcher: lockfile check → start server → build URL → best-effort open
│   ├── server/
│   │   ├── http.ts         # Bun.serve on 127.0.0.1:0, open API + reviewer-token guard on control routes
│   │   ├── routes.ts       # one handler function per API route (thin, delegates to state/git/session)
│   │   ├── state.ts        # AppState store: rounds, comments, analysis; SSE subscriber list
│   │   ├── submissions.ts  # submission cycles, plan versions, work-item coverage, approval invariants
│   │   └── sse.ts          # server-sent events channel (analysis/answer/plan/status/round events)
│   ├── git/
│   │   ├── capture.ts      # snapshot commands for worktree/commit targets; merge rejection; untracked caps
│   │   └── parse.ts        # unified diff text → DiffFile[]/Hunk[]; binary + rename detection
│   ├── session/
│   │   ├── client.ts       # createOpencodeClient link to the running instance; startup health check
│   │   ├── prompts.ts      # the four prompt templates (analysis, Q&A, plan, fix+status)
│   │   └── schemas.ts      # zod schemas for structured outputs + plain-text fallback handling
│   ├── lesson.ts           # LessonCandidate builder (provenance) + degradation handling
│   └── types.ts            # shared data model below
├── frontend/
│   ├── index.html          # single page shell
│   ├── app.js              # state fetch, diff render, comment UI, SSE handling — no build step
│   └── style.css
└── test/
    ├── capture.test.ts     # snapshot behaviors (see §10)
    ├── parse.test.ts
    ├── state.test.ts
    ├── submissions.test.ts # cycle/version invariants and work-item coverage
    └── auth.test.ts
```

Single active review per process is trivially true: module-scope state, and `launch.ts` refuses a second in-process start (returns the existing URL).

## 3. Data model

Shape-level only; lives in `src/types.ts`.

```ts
type ReviewTarget =
  | { kind: "worktree" }                       // staged+unstaged+untracked vs HEAD
  | { kind: "commit"; sha: string }            // vs first parent; merges rejected

interface Round {
  n: number                    // 1-based
  target: ReviewTarget
  capturedAt: string
  files: DiffFile[]
}

interface DiffFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  binary: boolean
  truncated?: boolean          // untracked file over size cap
  hunks: Hunk[]                // [] for binary/deleted-overview cases
}

interface Hunk {
  index: number                // 0-based within file — part of the anchor key
  header: string               // @@ -a,b +c,d @@
  oldStart: number; oldLines: number; newStart: number; newLines: number
  lines: { origin: "+" | "-" | " "; content: string }[]
}

interface Comment {
  id: string
  author: string             // "human" or agent name/session — attribution, not auth
  scope: "inline" | "file" | "overall"
  anchor: {
    round: number              // permanent — never remapped
    file?: string
    hunkIndex?: number
    lineRange?: [number, number]   // within the hunk's new-side lines
  }
  body: string
  isLesson: boolean
  createdAt: string
}

interface Evidence { source: string; quote: string }   // source = file path / commit ref / "session context"

interface AnalysisResult {                          // one per round, possibly merged from batch prompts
  files:  { file: string; purpose: string; confidence: "evidence" | "inference"; citations: Evidence[] }[]
  hunks:  { file: string; hunkIndex: number; rationale: string; confidence: "evidence" | "inference"; citations: Evidence[] }[]
  findings: { id: string; file?: string; hunkIndex?: number; claim: string; citations: Evidence[] }[]
}

interface WorkRequest {
  id: string
  text: string
  origin: "user" | "accepted-finding" | "comment"
  comment?: { author: string; anchor: Comment["anchor"] }
  finding?: { round: number; findingId: string } // stable source identity across cycles
}

interface SubmitPayload {
  // each eligible comment joins as a comment-origin request (id = comment id)
  // with a candidate-time snapshot { author, anchor }; later comment deletion
  // never changes a plan version that already captured it
  requests: WorkRequest[]
  lessons: LessonCandidate[]
}

interface LessonCandidate {
  commentId: string
  excerpt: string              // comment body, truncated
  provenance: { source: "sideye"; repo: string; target: string; round: number;
                file?: string; hunkIndex?: number; lineRange?: [number, number] }
}

interface Plan { perRequest: { requestId: string; approach: string; affectedFiles: string[] }[] }

interface PlanVersion {
  n: number                       // 1-based within the submission cycle
  payload: SubmitPayload          // cumulative work snapshot covered by this candidate plan
  feedback: string[]              // cumulative reviewer responses through this version
  status: "planning" | "ready" | "failed"
  plan?: Plan
  error?: string
  createdAt: string
}

interface RequestStatus {
  requestId: string
  status: "addressed" | "partial" | "blocked" | "declined"
  reason: string
  checks?: { command: string; passed: boolean; summary: string }[]
}

interface SubmissionCycle {
  n: number                       // 1-based across the review
  round: number                   // frozen diff round this cycle reviews
  plans: PlanVersion[]
  approvedPlan?: number           // PlanVersion.n; absent until edits are authorized
  statuses?: RequestStatus[]
  capturedRound?: number          // resulting diff round after consent
  stalled?: boolean
  statusError?: string
}

interface AppState {
  token: string                // 32 random bytes, base64url
  sessionID: string            // originating OpenCode session
  repoPath: string
  target: ReviewTarget
  rounds: Round[]
  comments: Comment[]
  analysis: Map<number, AnalysisResult>          // by round
  analysisStatus: Map<number, "pending" | "failed">
  acceptedFindings: { round: number; findingId: string }[]
  submissions: SubmissionCycle[]
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>
}
```

**Anchor rule (the load-bearing invariant):** comments store `(round, file, hunkIndex, lineRange)` — indices into a frozen round's parsed structure, never raw line numbers that drift when the agent edits. Everything else (round N+1 mapping, "was this addressed") is derived and fuzzy by design; the agent's status report is the source of truth.

**Work-coverage rule:** every `PlanVersion` owns an immutable cumulative payload snapshot. A comment or finding counts as completed/submitted only when it appears in the approved version of a cycle. Feedback present only in a failed, superseded, or unapproved candidate remains eligible for a later version or cycle.

**Authorization rule:** only `approvedPlan` authorizes edits, and it identifies an exact plan version and payload. Plan feedback, plan retries, new comments, and plan revisions never authorize edits. Once approved, that version and its payload cannot change.

**Sequencing rule:** one submission cycle belongs to one diff round. A new cycle cannot start until the previous cycle has an approved fix result (or accepted stall) and its next diff round has been captured. Conversation before approval happens through plan versions, not duplicate diff rounds.

## 4. HTTP API

**API split — open read/comment, token-gated control.** The server binds `127.0.0.1` only, port assigned by the OS (`port: 0`). Routes divide into two tiers:

- **Open tier — no token.** What any local process or agent may do: read the review and its events, post attributed comments and questions. This is deliberate — it is what lets other agents (a second-opinion subagent, a lint bot) read a review and comment like a co-reviewer. Agents use the bare `http://127.0.0.1:<port>/…` URL.
- **Control tier — reviewer token.** The actions that mutate or move the review forward: comment deletion, submit, plan revision/retry/approval, and new-round capture. A random per-launch token is embedded in the URL the human opens (`?reviewer=<token>`); the frontend sends it as `Authorization: Bearer` on these routes, which reject requests without it (`401`).

The control token is an honest-agent boundary, not a malware defense — see the lockfile note below and §11.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/` | open | Static frontend (index.html, app.js, style.css) |
| GET | `/api/health` | open | Liveness + repo path (used by lockfile reuse check) |
| GET | `/api/state` | open | Full AppState projection — initial load + SSE reconnect |
| GET | `/api/events` | open | SSE stream: `analysis.update`, `answer`, versioned `plan.pending`/`plan.ready`/`plan.failed`, `status.ready`, `round.prompt` |
| POST | `/api/comments` | open | Add comment `{ scope, anchor, body, isLesson, author }` — `author` required, no default |
| POST | `/api/comments/delete` | control | Delete a comment by id; already-snapshotted plan payloads are unchanged |
| POST | `/api/questions` | open | Immediate Q&A → routes through session → reply also pushed via SSE |
| POST | `/api/findings/accept` | control | Mark a finding as an accepted request |
| POST | `/api/submit` | control | Start the latest diff round's cycle from typed requests plus not-yet-approved comments/findings; creates plan v1 and returns immediately |
| POST | `/api/plan/revise` | control | Create the next plan version from `{ feedback? }` plus comments added since the base version; requires feedback or at least one new comment |
| POST | `/api/plan/retry` | control | Retry a failed candidate `{ cycle, version }` without creating another semantic plan version |
| POST | `/api/plan/approve` | control | Approve exact `{ cycle, version }`; rejects stale, missing, pending, failed, or already-approved versions |
| POST | `/api/rounds` | control | Capture a new round (only offered after status report) |

All plan SSE payloads include `{ cycle, version }`. The frontend still refetches `/api/state` rather than applying event deltas, but version identity prevents a delayed response or stale browser action from approving a different plan than the one displayed.

Attribution replaces connection control on the open tier: every comment carries an `author` (the human's browser sends `"human"`; an agent sends its name/session). The UI displays it beside each comment, and prompts include it wherever a comment appears — trust judgment moves from "who could connect" to "who said this". The surface stays tiny and is experimental until a second real consumer exists (§11).

**Cross-process reuse.** "Second launch returns the existing URL" requires discovering the running server. Pin: `launch.ts` writes a lockfile `$TMPDIR/sideye/<hash-of-repo-path>.json` containing `{ repoPath, port, reviewerToken, pid, createdAt }`, mode `0600`. A second launch reads it; if `pid` is alive and `GET /api/health` answers, it reuses (plugin tool returns the reviewer URL, CLI prints it). Stale locks (dead pid / failed health check) are removed and taken over.

Honest limits of this scheme, stated rather than hidden: (a) the lockfile publishes the reviewer token to same-user processes, so the control tier assumes agents that respect the API contract — a malicious same-user process was never stoppable (it can read process memory); (b) no diff/comment data ever touches disk — the lockfile is connection metadata only. Cross-user protection holds (0600 + per-user TMPDIR). Open question §11.1.

## 5. Flow sequences

**(a) Launch.**
`/sideye [commit]` (markdown command template) instructs the agent to call the registered tool `sideye_open_review { commit? }`. The tool handler resolves repo path from the plugin input, optional sha, then `launch.ts`: check lockfile → start server (or reuse) → build the reviewer URL (`?reviewer=<token>`) → best-effort `open` the browser → return URL to the agent, which shows it via `tui.showToast`. CLI flow is the same except the session: `sideye review [commit]` connects to the running OpenCode instance (or boots one), creates a **dedicated session** via `session.create`, and uses that session ID for all prompts. Both flows pass `sessionID` + `repoPath` into the server state at construction.

**(b) Review open → analysis.**
1. Capture the target (§6) → parse → freeze as round 1.
2. Server splits files into batches (≤5 files or ≤400 changed lines, whichever trips first; binary/binary-ish files excluded) and sends one analysis prompt per batch through the originating session as a **blocking** `session.prompt` with `outputFormat: json_schema` (§7). Prompts are prefixed `sideye:` so the reviewer can tell Sideye traffic in the TUI.
3. Batch results merge into one `AnalysisResult`; SSE `analysis.update` after each batch so the UI fills progressively.
4. Frontend renders diff from server-parsed hunks (no client-side diffing) plus the analysis side panel.

**(c) Start a submission cycle and draft plan v1.**
1. Reviewer hits Submit → `POST /api/submit` with explicit requests. The server adds comments and accepted findings that do not appear in any previously approved plan payload. Comment requests snapshot author + anchor; finding requests snapshot round + finding id; lesson candidates are built only from lesson-marked comments in this candidate payload. An empty candidate is rejected.
2. The server creates a `SubmissionCycle` for the latest diff round and a planning `PlanVersion` v1. Browser selection of a historical round never changes the submission target. A cycle already exists for the latest round, or the preceding cycle has not captured its resulting round, so another `/api/submit` is rejected; pre-approval conversation uses revision instead.
3. The plan prompt dispatches in the background. It contains the candidate payload and cumulative reviewer feedback, and structured output remains per-request approach + affected files. Semantic validation requires exactly one entry for every request id and rejects missing, duplicate, or unknown ids before the normal one-repair retry.
4. The response returns immediately; versioned SSE updates all tabs. A validated plan becomes ready and is mirrored to the originating TUI as an `ignored` Markdown part on the plan request's **user** message: visible to the human, but excluded from later model-history replay. It must not be attached to the structured-output assistant message: OpenCode 1.18.30 replays ignored assistant text and produces an invalid provider part order. A failure stays on that version and is retryable without discarding earlier ready plans.

**(d) Revise or approve a plan.**
1. A ready plan exposes **Approve plan** and **Request changes**. Request changes accepts an optional written response and snapshots comments added since the candidate payload. At least one of those inputs is required.
2. `POST /api/plan/revise` creates version N+1 from the prior candidate's cumulative payload and feedback plus the new inputs. The prior plan remains immutable and visible. Only one plan request may run at a time; approval is disabled while a newer candidate is pending.
3. If N+1 succeeds, it becomes the newest approvable plan. If it fails, its error and retry action render while the newest earlier ready plan becomes approvable again. Feedback/items unique to the failed candidate are not considered authorized if the earlier plan is approved.
4. Comments added after a ready plan are visibly counted as not covered. Per the chosen product behavior, they do not invalidate that plan: the reviewer may revise to include them or explicitly approve the displayed plan and leave them queued.
5. `POST /api/plan/approve { cycle, version }` authorizes only that exact ready version. The server rejects approval if another plan request is pending or if the identifiers do not match an approvable version. The approved payload is frozen; all later comments are queued.

**(e) Fix, capture, and start the next cycle.**
1. Approval sends the edit-authorizing fix prompt with the approved version's payload, plan, cumulative reviewer feedback, and lesson candidates. It requires one `RequestStatus` per approved request plus relevant project checks.
2. Server subscribes to the OpenCode event bus and watches the originating session for `session.idle` or `session.error`. An error terminates the wait immediately and renders `Fix failed`; no terminal event within 10 minutes produces the stall state while the review stays usable.
3. Statuses arrive as structured output → SSE `status.ready` → UI status card → round-consent card. Consent → `POST /api/rounds` → new capture → round N+1; prior comments and all plan/cycle history remain viewable.
4. Once the new snapshot exists, Submit becomes available again. Its candidate contains typed requests plus comments/findings absent from every approved payload, including comments queued before approval or while the agent was editing. A queued comment keeps its original round anchor even when handled by a later cycle.
5. Q&A remains separate: `POST /api/questions` → blocking prompt with the question + anchor context → answer returned in the HTTP response and pushed via SSE. Q&A does not create work items or plan revisions.

## 6. Git capture pipeline

All commands run with `cwd` = repo path, via Bun `$` shell.

| Case | Command | Notes |
|---|---|---|
| Worktree, tracked | `git diff HEAD` | Covers staged + unstaged vs HEAD in one output |
| Worktree, untracked | `git status --porcelain=v1 -z` → `??` entries | Respects `.gitignore`; each file read and embedded as a synthetic added-file hunk. Caps: 100 KB/file (over → `truncated`, content clipped), 50 files total (over → listed by path only) |
| Commit vs first parent | `git diff <sha>^ <sha>` | |
| Root commit | `git diff-tree --root -r -p --format= <sha>` | `<sha>^` doesn't exist for root commits |
| Merge rejection | `git show -s --format=%P <sha>` → 2+ parents → fail at launch with a clear message | Matches spec (no merge comparisons) |
| Binary detection | `git diff --numstat` | `-` marker → `binary: true`, hunks excluded from analysis prompts |

Empty diff (clean worktree) is allowed: round 1 has no files; overall comments and Q&A still work. Renames rely on git's default rename detection; status maps to `renamed`.

## 7. Session integration

`createOpencodeClient` (plugin flow: client handed to the plugin; CLI flow: created after connecting). A health check at startup fails loudly — per the HLD, platform drift should surface early, not degrade silently.

Four prompt templates in `session/prompts.ts`, each carrying the framing that diff content *and reviewer comments* are quoted data, never instructions — comments arrive from any local agent, so they are always included with their author label and round anchor:

| Template | Mode | Structured schema |
|---|---|---|
| Analysis (per batch) | blocking `session.prompt`, json_schema | `{ files[], hunks[], findings[] }` per §3 |
| Q&A | blocking `session.prompt`, plain text | — |
| Plan / plan revision | blocking `session.prompt`, json_schema | `{ perRequest[] }`; revision includes prior plan + cumulative reviewer feedback |
| Fix + status | asynchronous prompt that authorizes editing; result awaited via `session.idle` / `session.error` event subscription | `{ statuses[] }` with check results |

zod schemas validate every structured response. Parse failure → one retry with the validation error appended → plain-text fallback shown in an "unparsed analysis" pane. Schemas stay small and flat per the HLD's reliability risk note.

Lesson capture: `lesson.ts` builds `LessonCandidate`s from lesson-marked comments in each candidate plan payload. Only candidates attached to the approved plan version enter the fix prompt. A lesson-marked comment queued behind an older approved plan is proposed in the later cycle that approves it, never early and never twice. swe-factory presence is **not** probed eagerly — the fix prompt tells the agent to propose via `swe_factory_propose_lesson` and to say so in the status report if the tool is unavailable; the UI renders that as a degradation note. Sideye never touches swe-factory's store.

## 8. Frontend

Single page, no framework, no bundler. Layout: header (target, round selector, Submit — the real submit action; it picks up typed requests from the Status-tab card when visible) + split view — diff pane (files → hunks rendered from server JSON) and side panel (tabs: Analysis, Findings, Comments, Status). Submit is disabled only while the current round already has a cycle or the preceding cycle has not captured a new snapshot; after capture it re-enables for queued work.

- **Commenting:** gutter click on a hunk line → inline comment box (scope inferred inline; file header button → file scope; header → overall). "Mark as lesson" checkbox on the form sets `isLesson`. Comments posted through the open API carry an `author`, shown beside the comment.
- **Findings** render as a visually distinct section, each with an "accept as request" control; accepted findings join the submit payload — never auto-submitted; the plan card labels each request's origin and author.
- **Updates:** SSE push; on disconnect the client retries and on reconnect does a full `GET /api/state` refetch (no incremental sync to keep the client dumb). A persistent banner appears after repeated reconnect failures — consistent with "review dies with its launcher".
- **Planning feedback (the submit → plan dead zone):** after submit the Status tab shows a live planning card until the plan lands — how many items are being planned, the sent items with origin/author tags, the linked session id, and a "can take a minute" note. The originating TUI shows the `sideye:` prompt immediately and the validated fix plan as an `ignored` Markdown part on that user message when ready; presentation-only text must not be attached to an assistant message or enter later model history. A failed plan renders the error with a Retry button; a review with no linked session says so instead of planning forever.
- **Plan revisions:** a ready plan shows its version, covered item count, prior versions in read-only history, a response field, and **Request revised plan**. Comments newer than that version render as queued/not covered. Approval remains available by product decision, but its label explicitly states how many comments will remain queued. While a revision is pending, approval is disabled; if it fails, the earlier ready plan becomes approvable again.
- **Cycle history:** after a new diff round is captured, prior plans and statuses remain read-only in the Status surface. The active action bar reflects only the latest round's cycle or the count of feedback ready to start one.
- Large diffs: hunks render lazily (expand-on-scroll within a file); files render top-down.

## 9. Failure and degradation paths

| Failure | Behavior |
|---|---|
| swe-factory absent/toggled off | Reported by the agent in the status report → UI note; review loop unaffected |
| Structured output invalid | One repair retry → plain-text fallback pane |
| Plan prompt fails (validation twice / transport) | Error stored on that `PlanVersion` + versioned SSE `plan.failed` → failure card with Retry (`POST /api/plan/retry`); its candidate payload stays stored |
| Revised plan fails | Failed version and candidate payload stay visible/retryable; newest earlier ready plan is still approvable, and candidate-only comments remain queued if that earlier plan is approved |
| Plan omits, duplicates, or invents request ids | Semantic validation failure → one repair retry → failed plan version |
| Stale browser approves the wrong version | Approval carries cycle + version; mismatch or pending newer candidate → `400`, no edit prompt |
| Revision requested with no response and no new comments | `400`; current plan remains unchanged |
| Comment arrives while planning | It is outside the immutable candidate payload and renders queued for the next revision/cycle |
| Comment arrives after approval | It is never injected into the running fix; queued until the next captured diff round starts a cycle |
| TUI plan mirror fails | Warning logged; canonical browser plan and approval flow remain available |
| Fix model call emits `session.error` | Exact model error stored and shown immediately as `Fix failed`; do not wait for `session.idle` or retry a provider/history failure as malformed structured output |
| No linked session at submit | `sessionLinked: false` in the projection → Status tab states no plan can be drafted instead of an eternal planning state |
| Merge commit as target | Rejected at launch with message |
| `session.idle` never fires | 10-min stall timeout → UI states the session stopped responding; state remains reviewable |
| Launcher process dies | Review ends (process-local by design); browser shows reconnect banner |
| OpenCode unreachable at launch | Hard fail with message (loud-and-early rule) |
| Second launch, same repo | Reuse via lockfile (§4) |
| Unattributed comment/question | Rejected `400` — `author` required (attribution over auth) |

## 10. Test mapping (Bun test runner)

- `capture.test.ts` — worktree snapshot (staged + unstaged + untracked vs HEAD), `.gitignore` exclusion, size caps, untracked synthetic hunks, merge rejection, root commit, commit-vs-parent.
- `parse.test.ts` — unified diff → files/hunks: new file, deleted file, rename, hunk without trailing context, CRLF.
- `state.test.ts` — comment anchoring and round-scoping.
- `submissions.test.ts` — initial and follow-up candidate selection; source identities prevent approved comments/findings from being resubmitted; candidate-only items remain eligible; lesson candidates match the candidate payload; approval/sequencing invariants.
- `auth.test.ts` — real `Bun.serve` on an ephemeral port: control routes (submit/approve/rounds) without the reviewer token → 401, with it → 200; open routes (state, comments, questions) work without a token; `POST /api/comments` without `author` → 400. Server never writes review data to disk (lockfile contents asserted as metadata-only).
- `schemas.test.ts` — sample structured outputs validate against zod schemas; malformed input routes to fallback.
- `plan.test.ts` — asynchronous submit/plan/revise/retry lifecycle; cumulative feedback and payload snapshots; exact request-id validation; prior ready plan survives revised-plan failure; validated plan Markdown identifies the cycle/version and is added as ignored text to the successful response's parent user message, never the assistant message.
- `routes.test.ts` — control auth plus stale cycle/version rejection, one in-flight plan guard, explicit approval with queued comments, and revision-with-no-input rejection.
- `rounds.test.ts` — approved cycle captures the next diff round; queued round-1 comments start the round-2 cycle; prior cycle/plan/status history remains projected.

The HLD's manual acceptance list remains. T28 adds these focused scenarios:

1. Submit round-1 feedback → receive plan v1 → respond without approval → receive cumulative plan v2 → approve v2 → only v2's payload reaches the fix prompt.
2. Add comments while v1 is ready → approve v1 despite the visible queued warning → complete fix/capture → submit those comments in the round-2 cycle.
3. Fail a revised-plan request → v1 remains visible and approvable; retrying the failed version does not create v3.
4. Mark a queued comment as a lesson → no proposal during the older approved fix; exactly one candidate reaches the later cycle that approves it.
5. At desktop and 320px widths, long plan feedback, queued-comment text, version history, and action labels cause no right-edge overflow.

## 11. Open questions

1. **Control-token honesty assumption** (§4) — the lockfile publishes the reviewer token to same-user processes, so the control tier assumes well-behaved agents, not hostile code (which could read process memory anyway). Revisit if Sideye is ever distributed beyond a single-user machine.
2. **Session contention** — blocking `sideye:`-prefixed prompts may interleave awkwardly with the reviewer typing in the TUI; accepted in the HLD. External agents commenting add more interleaving sources; accepted for MVP.
3. **Batch size (5 files / 400 lines)** — starting values, tuned through use like the analysis prompt wording (spec open item).
4. **UI look and feel** — prototype-first per the spec's explicitly-open item; §8 pins only structure, not visual design.
5. **Agent API surface** — external agents will depend on the open routes; keep the shape tiny and mark it experimental until a second real consumer exists. Author labels are honor-system — a local agent can claim `"human"`; accepted for MVP.

The former post-submit-comment question is resolved by the 2026-09-12 T28 amendment: comments are never injected into in-flight work; pre-approval comments may join a revised plan, and comments outside the approved payload remain queued for the next consent-captured diff round's submission cycle.
