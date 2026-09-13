// Shared data model per LLD §3. Shape-level only — no runtime logic.
// Anchor rule (load-bearing invariant): comments anchor to (round, file, hunkIndex,
// lineRange) — indices into a frozen round's parsed structure, never raw line numbers
// that drift when the agent edits. Everything else is derived; the agent's status
// report is the source of truth for "was this addressed".

export type ReviewTarget =
  | { kind: "worktree" } // staged+unstaged+untracked vs HEAD
  | { kind: "commit"; sha: string } // vs first parent; merges rejected

export interface Round {
  n: number // 1-based
  target: ReviewTarget
  capturedAt: string
  files: DiffFile[]
}

export interface DiffFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
  binary: boolean
  truncated?: boolean // untracked file over size cap
  hunks: Hunk[] // [] for binary/deleted-overview cases
}

export interface Hunk {
  index: number // 0-based within file — part of the anchor key
  header: string // @@ -a,b +c,d @@
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: { origin: "+" | "-" | " "; content: string }[]
}

export interface Comment {
  id: string
  author: string // "human" or agent name/session — attribution, not auth
  scope: "inline" | "file" | "overall"
  anchor: {
    round: number // permanent — never remapped
    file?: string
    hunkIndex?: number
    lineRange?: [number, number] // within the hunk's new-side lines
  }
  body: string
  isLesson: boolean
  createdAt: string
}

export interface Evidence {
  source: string // file path / commit ref / "session context"
  quote: string
}

// One per round, possibly merged from batch prompts
export interface AnalysisResult {
  files: {
    file: string
    purpose: string
    confidence: "evidence" | "inference"
    citations: Evidence[]
  }[]
  hunks: {
    file: string
    hunkIndex: number
    rationale: string
    confidence: "evidence" | "inference"
    citations: Evidence[]
  }[]
  findings: {
    id: string
    file?: string
    hunkIndex?: number
    claim: string
    citations: Evidence[]
  }[]
  // plain-text fallback: batches whose structured output failed validation even
  // after one repair retry land here verbatim (LLD §7 "unparsed analysis" pane)
  unparsed?: string
}

export interface SubmitPayload {
  requests: WorkRequest[]
  lessons: LessonCandidate[]
}

export interface WorkRequest {
    id: string
    text: string
    origin: "user" | "accepted-finding" | "comment"
    // comment-origin requests snapshot their source comment at submit time —
    // the payload is the immutable work order, so deleting the comment later
    // never changes what the agent sees. id === comment.id for traceability.
    comment?: { author: string; anchor: Comment["anchor"] }
    finding?: { round: number; findingId: string }
}
export interface LessonCandidate {
  commentId: string
  excerpt: string // comment body, truncated
  provenance: {
    source: "sideye"
    repo: string
    target: string
    round: number
    file?: string
    hunkIndex?: number
    lineRange?: [number, number]
  }
}

export interface Plan {
  perRequest: { requestId: string; approach: string; affectedFiles: string[] }[]
}

export interface PlanVersion {
  n: number
  payload: SubmitPayload
  feedback: string[]
  status: "planning" | "ready" | "failed"
  plan?: Plan
  error?: string
  createdAt: string
}

export interface SubmissionCycle {
  n: number
  round: number
  plans: PlanVersion[]
  approvedPlan?: number
  statuses?: RequestStatus[]
  capturedRound?: number
  stalled?: boolean
  statusError?: string
}

export interface RequestStatus {
  requestId: string
  status: "addressed" | "partial" | "blocked" | "declined"
  reason: string
  checks?: { command: string; passed: boolean; summary: string }[]
}

export interface AppState {
  token: string // 32 random bytes, base64url
  sessionID: string // originating OpenCode session
  repoPath: string
  target: ReviewTarget
  rounds: Round[]
  comments: Comment[]
  analysis: Map<number, AnalysisResult> // by round
  analysisStatus: Map<number, "pending" | "failed"> // absent once analysis completes
  acceptedFindings: { round: number; findingId: string }[] // marked pre-submit, serialized on submit
  submissions: SubmissionCycle[] // immutable plan candidates, grouped by frozen round
  // connected SSE client stream controllers (server pushes events into these)
  sseClients: Set<ReadableStreamDefaultController<Uint8Array>>
}
