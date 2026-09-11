# Sideye Code Review MVP — Low-Level Design

**Date:** 2026-09-10
**HLD:** [2026-09-10-sideye-code-review-mvp.md](2026-09-10-sideye-code-review-mvp.md)
**Spec:** [../specs/sideye-code-review-mvp.md](../specs/sideye-code-review-mvp.md)

This document says *what will be implemented and how the pieces work together* — package layout, data model, API surface, flow sequences, and the mechanism choices the HLD left open (each pinned with its reasoning). It does not contain implementation code; type shapes and command lines only. It must be read together with the HLD, which holds the decisions and their rationale.

## 1. Overview

One Bun/TypeScript package ships three things that share one process shape: the OpenCode plugin entry, a `sideye` CLI, and an in-process HTTP review server with a static frontend. Opening a review captures a git snapshot (round 1), serves it in a browser on loopback — read/comment open to local agents, control actions gated by a per-launch reviewer token — and routes all model work (analysis, Q&A, plans, fixes) through the originating OpenCode session. Review state lives only in that server process; a review dies when its launcher dies.

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
│   │   ├── state.ts        # AppState store: rounds, comments, analysis, submission; SSE subscriber list
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

interface SubmitPayload {
  // every comment joins as a comment-origin request (id = comment id) with a
  // submit-time snapshot { author, anchor } — the payload is the immutable
  // work order; later comment deletion never changes what the agent sees
  requests: { id: string; text: string; origin: "user" | "accepted-finding" | "comment";
              comment?: { author: string; anchor: { round: number; file?: string; hunkIndex?: number; lineRange?: [number, number] } } }[]
  lessons: LessonCandidate[]
}

interface LessonCandidate {
  commentId: string
  excerpt: string              // comment body, truncated
  provenance: { source: "sideye"; repo: string; target: string; round: number;
                file?: string; hunkIndex?: number; lineRange?: [number, number] }
}

interface Plan { perRequest: { requestId: string; approach: string; affectedFiles: string[] }[] }

interface RequestStatus {
  requestId: string
  status: "addressed" | "partial" | "blocked" | "declined"
  reason: string
  checks?: { command: string; passed: boolean; summary: string }[]
}

interface AppState {
  token: string                // 32 random bytes, base64url
  sessionID: string            // originating OpenCode session
  repoPath: string
  target: ReviewTarget
  rounds: Round[]
  comments: Comment[]
  analysis: Map<number, AnalysisResult>          // by round
  submission?: { payload: SubmitPayload; plan?: Plan; planApproved?: boolean;
                 statuses?: RequestStatus[]; roundPrompted?: boolean }
  sseClients: Set<WritableStream>
}
```

**Anchor rule (the load-bearing invariant):** comments store `(round, file, hunkIndex, lineRange)` — indices into a frozen round's parsed structure, never raw line numbers that drift when the agent edits. Everything else (round N+1 mapping, "was this addressed") is derived and fuzzy by design; the agent's status report is the source of truth.

## 4. HTTP API

**API split — open read/comment, token-gated control.** The server binds `127.0.0.1` only, port assigned by the OS (`port: 0`). Routes divide into two tiers:

- **Open tier — no token.** What any local process or agent may do: read the review and its events, post attributed comments and questions. This is deliberate — it is what lets other agents (a second-opinion subagent, a lint bot) read a review and comment like a co-reviewer. Agents use the bare `http://127.0.0.1:<port>/…` URL.
- **Control tier — reviewer token.** The actions that move the review forward: submit, plan approval, new-round capture. A random per-launch token is embedded in the URL the human opens (`?reviewer=<token>`); the frontend sends it as `Authorization: Bearer` on these routes, which reject requests without it (`401`).

The control token is an honest-agent boundary, not a malware defense — see the lockfile note below and §11.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/` | open | Static frontend (index.html, app.js, style.css) |
| GET | `/api/health` | open | Liveness + repo path (used by lockfile reuse check) |
| GET | `/api/state` | open | Full AppState projection — initial load + SSE reconnect |
| GET | `/api/events` | open | SSE stream: `analysis.update`, `answer`, `plan.pending`, `plan.ready`, `plan.failed`, `status.ready`, `round.prompt` |
| POST | `/api/comments` | open | Add comment `{ scope, anchor, body, isLesson, author }` — `author` required, no default |
| POST | `/api/questions` | open | Immediate Q&A → routes through session → reply also pushed via SSE |
| POST | `/api/findings/accept` | control | Mark a finding as an accepted request |
| POST | `/api/submit` | control | Submit requests + accepted findings + every comment → returns immediately; the plan prompt dispatches in the background |
| POST | `/api/plan/retry` | control | Re-dispatch the background plan prompt after a `plan.failed` (requires a submission, no plan, not currently planning) |
| POST | `/api/plan/approve` | control | Second approval → authorizes edit prompt |
| POST | `/api/rounds` | control | Capture a new round (only offered after status report) |

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

**(c) Submit handoff.**
1. Reviewer hits Submit → `POST /api/submit` with explicit requests; accepted findings and **every comment** join automatically (comments as comment-origin requests with author + anchor snapshots; lesson-marked ones additionally serialize as LessonCandidates) → server serializes the `SubmitPayload`. An empty review (no comments, findings, requests) is rejected.
2. The plan prompt (structured output: per-request approach + affected files) dispatches **in the background** like the fix flow — the submit response returns immediately, the UI shows a live planning card (the sent items with origin/author tags, the linked session id, a "can take a minute" note), and `plan.pending` → `plan.ready` events update every tab. After validation, Sideye also formats the plan as Markdown and adds it as a text part on the same assistant message via `client.part.update`, because OpenCode's structured output is not itself visible in the TUI. This mirror is best-effort and never invalidates the canonical browser plan. Failure stores `planError` + SSE `plan.failed` → failure card with a Retry button (`POST /api/plan/retry`); the payload stays stored.
3. Reviewer approves → `POST /api/plan/approve` → fix prompt authorizes editing, requires a per-request `RequestStatus` report and that relevant checks (from AGENTS.md's Commands section) run before finishing; lesson candidates included with the instruction to propose each via `swe_factory_propose_lesson` before finishing.
4. Server subscribes to the OpenCode event bus and watches `session.idle` for the originating session (10-minute stall timeout → UI reports the session stopped responding; review stays usable).
5. Statuses arrive as structured output → SSE `status.ready` → UI status card → round-consent card ("capture round N?"). Consent → `POST /api/rounds` → new capture → round N+1; round-1 comments remain viewable under their round. Review completes only on explicit human approval — nothing auto-completes.
6. Q&A bypasses the batch: `POST /api/questions` → blocking prompt with the question + anchor context → answer returned in the HTTP response and pushed via SSE (for a second tab).

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
| Plan | blocking `session.prompt`, json_schema | `{ perRequest[] }` |
| Fix + status | blocking prompt that authorizes editing; result awaited via `session.idle` event subscription | `{ statuses[] }` with check results |

zod schemas validate every structured response. Parse failure → one retry with the validation error appended → plain-text fallback shown in an "unparsed analysis" pane. Schemas stay small and flat per the HLD's reliability risk note.

Lesson capture: `lesson.ts` builds `LessonCandidate`s from lesson-marked comments and injects them into the fix prompt. swe-factory presence is **not** probed eagerly — the fix prompt tells the agent to propose via `swe_factory_propose_lesson` and to say so in the status report if the tool is unavailable; the UI renders that as a degradation note. Sideye never touches swe-factory's store.

## 8. Frontend

Single page, no framework, no bundler. Layout: header (target, round selector, Submit — the real submit action; it picks up typed requests from the Status-tab card when visible) + split view — diff pane (files → hunks rendered from server JSON) and side panel (tabs: Analysis, Findings, Comments, Status). The button labels itself "Submitting…" in flight and "Submitted" (disabled) once a submission exists.

- **Commenting:** gutter click on a hunk line → inline comment box (scope inferred inline; file header button → file scope; header → overall). "Mark as lesson" checkbox on the form sets `isLesson`. Comments posted through the open API carry an `author`, shown beside the comment.
- **Findings** render as a visually distinct section, each with an "accept as request" control; accepted findings join the submit payload — never auto-submitted; the plan card labels each request's origin and author.
- **Updates:** SSE push; on disconnect the client retries and on reconnect does a full `GET /api/state` refetch (no incremental sync to keep the client dumb). A persistent banner appears after repeated reconnect failures — consistent with "review dies with its launcher".
- **Planning feedback (the submit → plan dead zone):** after submit the Status tab shows a live planning card until the plan lands — how many items are being planned, the sent items with origin/author tags, the linked session id, and a "can take a minute" note. The originating TUI shows the `sideye:` prompt immediately and the validated fix plan as a Markdown assistant text part when ready. A failed plan renders the error with a Retry button; a review with no linked session says so instead of planning forever.
- Large diffs: hunks render lazily (expand-on-scroll within a file); files render top-down.

## 9. Failure and degradation paths

| Failure | Behavior |
|---|---|
| swe-factory absent/toggled off | Reported by the agent in the status report → UI note; review loop unaffected |
| Structured output invalid | One repair retry → plain-text fallback pane |
| Plan prompt fails (validation twice / transport) | `planError` stored + SSE `plan.failed` → failure card with Retry (`POST /api/plan/retry`); payload stays stored |
| TUI plan mirror fails | Warning logged; canonical browser plan and approval flow remain available |
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
- `state.test.ts` — comment anchoring round-scoping; submit-payload serialization (explicit requests + accepted findings + every comment as comment-origin requests; lesson-marked ones also as LessonCandidates; empty review rejected).
- `auth.test.ts` — real `Bun.serve` on an ephemeral port: control routes (submit/approve/rounds) without the reviewer token → 401, with it → 200; open routes (state, comments, questions) work without a token; `POST /api/comments` without `author` → 400. Server never writes review data to disk (lockfile contents asserted as metadata-only).
- `schemas.test.ts` — sample structured outputs validate against zod schemas; malformed input routes to fallback.
- `plan.test.ts` — asynchronous submit/plan/retry lifecycle; validated plan Markdown is added to the correct assistant message; TUI mirror failure does not invalidate the browser plan.

Manual acceptance scenarios are the HLD's list, unchanged — this LLD adds no new acceptance scenarios.

## 11. Open questions

1. **Control-token honesty assumption** (§4) — the lockfile publishes the reviewer token to same-user processes, so the control tier assumes well-behaved agents, not hostile code (which could read process memory anyway). Revisit if Sideye is ever distributed beyond a single-user machine.
2. **Session contention** — blocking `sideye:`-prefixed prompts may interleave awkwardly with the reviewer typing in the TUI; accepted in the HLD. External agents commenting add more interleaving sources; accepted for MVP.
3. **Batch size (5 files / 400 lines)** — starting values, tuned through use like the analysis prompt wording (spec open item).
4. **UI look and feel** — prototype-first per the spec's explicitly-open item; §8 pins only structure, not visual design.
5. **Agent API surface** — external agents will depend on the open routes; keep the shape tiny and mark it experimental until a second real consumer exists. Author labels are honor-system — a local agent can claim `"human"`; accepted for MVP.
6. **Post-submit comments have no channel** — submit runs once per review, so comments left after it (e.g. on a round-2 diff) reach the agent only via Q&A; there is no re-submit or comment-injection mechanism yet. Deferred until the round-2 workflow proves whether one is needed.
