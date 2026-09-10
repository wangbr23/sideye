import type { AppState, Comment, DiffFile, ReviewTarget, Round, SubmitPayload } from "../types.ts"
import {
  captureCommitDiff,
  captureTrackedDiff,
  captureUntrackedFiles,
  type CapturedTrackedDiff,
} from "../git/capture.ts"
import { parseDiff } from "../git/parse.ts"
import { questionPrompt, renderAnchorContext } from "../session/prompts.ts"
import { buildLessonCandidates } from "../lesson.ts"

export interface AppStateInit {
  token: string
  sessionID: string
  repoPath: string
  target: ReviewTarget
}

export function createState(init: AppStateInit): AppState {
  return {
    token: init.token,
    sessionID: init.sessionID,
    repoPath: init.repoPath,
    target: init.target,
    rounds: [],
    comments: [],
    analysis: new Map(),
    acceptedFindings: [],
    sseClients: new Set(),
  }
}

export interface CapturedDiff extends CapturedTrackedDiff {
  untracked: DiffFile[]
}

export async function captureTarget(repoPath: string, target: ReviewTarget): Promise<CapturedDiff> {
  if (target.kind === "commit") {
    return { ...(await captureCommitDiff(repoPath, target.sha)), untracked: [] }
  }
  return {
    ...(await captureTrackedDiff(repoPath)),
    untracked: await captureUntrackedFiles(repoPath),
  }
}

export function parseRoundFiles(captured: CapturedDiff): DiffFile[] {
  return [...parseDiff(captured.diffText, captured.numstatText), ...captured.untracked]
}

// Capture + parse → frozen Round, appended as round N+1. A clean worktree is
// valid: the round has no files and overall comments/Q&A still work (LLD §6).
export async function captureRound(state: AppState): Promise<Round> {
  const captured = await captureTarget(state.repoPath, state.target)
  const round: Round = {
    n: state.rounds.length + 1,
    target: state.target,
    capturedAt: new Date().toISOString(),
    files: parseRoundFiles(captured),
  }
  state.rounds.push(round)
  return round
}

// Open-tier comment posting (LLD §4): author is required — attribution, not
// auth — and the anchor must reference real structure in a frozen round.
// lineRange is interpreted as new-side file line numbers within the hunk's
// newStart..newStart+newLines-1 span.
export type AddCommentResult = { ok: true; comment: Comment } | { ok: false; error: string }

export function addComment(state: AppState, input: unknown): AddCommentResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "request body must be a JSON object" }
  }
  const draft = input as Record<string, unknown>

  const author = draft.author
  if (typeof author !== "string" || author.trim() === "") {
    return { ok: false, error: "author is required and must be a non-empty string" }
  }

  const body = draft.body
  if (typeof body !== "string" || body.trim() === "") {
    return { ok: false, error: "body is required and must be a non-empty string" }
  }

  const scope = draft.scope
  if (scope !== "inline" && scope !== "file" && scope !== "overall") {
    return { ok: false, error: `scope must be "inline", "file", or "overall"` }
  }

  const isLesson = draft.isLesson ?? false
  if (typeof isLesson !== "boolean") {
    return { ok: false, error: "isLesson must be a boolean when present" }
  }

  const anchor = draft.anchor
  if (typeof anchor !== "object" || anchor === null) {
    return { ok: false, error: "anchor is required and must be an object" }
  }
  const anchorFields = anchor as Record<string, unknown>

  const roundNumber = anchorFields.round
  const round = state.rounds.find((r) => r.n === roundNumber)
  if (round === undefined) {
    return {
      ok: false,
      error: `anchor.round ${String(roundNumber)} does not exist — rounds are 1-based and captured rounds only`,
    }
  }

  const { file, hunkIndex, lineRange } = anchorFields
  let anchoredFile: string | undefined
  let anchoredHunkIndex: number | undefined
  let anchoredLineRange: [number, number] | undefined

  if (scope === "overall") {
    if (file !== undefined || hunkIndex !== undefined || lineRange !== undefined) {
      return { ok: false, error: "overall comments must not carry file, hunkIndex, or lineRange" }
    }
  } else {
    if (typeof file !== "string" || !round.files.some((f) => f.path === file)) {
      return { ok: false, error: `anchor.file ${describeValue(file)} does not exist in round ${round.n}` }
    }
    anchoredFile = file
    if (scope === "file") {
      if (hunkIndex !== undefined || lineRange !== undefined) {
        return { ok: false, error: "file-scope comments must not carry hunkIndex or lineRange" }
      }
    } else {
      if (typeof hunkIndex !== "number" || !Number.isInteger(hunkIndex) || hunkIndex < 0) {
        return { ok: false, error: "inline comments require an integer anchor.hunkIndex >= 0" }
      }
      const hunk = round.files.find((f) => f.path === file)?.hunks[hunkIndex]
      if (hunk === undefined) {
        return { ok: false, error: `anchor.hunkIndex ${hunkIndex} does not exist in ${file} of round ${round.n}` }
      }
      if (lineRange !== undefined) {
        if (
          !Array.isArray(lineRange) ||
          lineRange.length !== 2 ||
          !lineRange.every((n) => typeof n === "number" && Number.isInteger(n))
        ) {
          return { ok: false, error: "anchor.lineRange must be a [start, end] pair of integers" }
        }
        const [start, end] = lineRange
        const firstNewLine = hunk.newStart
        const lastNewLine = hunk.newStart + hunk.newLines - 1
        if (start === undefined || end === undefined || start > end) {
          return { ok: false, error: "anchor.lineRange must be [start, end] with start <= end" }
        }
        if (start < firstNewLine || end > lastNewLine) {
          return { ok: false, error: `anchor.lineRange must fall within the hunk's new-side lines ${firstNewLine}..${lastNewLine}` }
        }
        anchoredLineRange = [start, end]
      }
      anchoredHunkIndex = hunkIndex
    }
  }

  const comment: Comment = {
    id: crypto.randomUUID(),
    author,
    scope,
    anchor: {
      round: round.n,
      ...(anchoredFile !== undefined ? { file: anchoredFile } : {}),
      ...(anchoredHunkIndex !== undefined ? { hunkIndex: anchoredHunkIndex } : {}),
      ...(anchoredLineRange !== undefined ? { lineRange: anchoredLineRange } : {}),
    },
    body,
    isLesson,
    createdAt: new Date().toISOString(),
  }
  state.comments.push(comment)
  return { ok: true, comment }
}

// Control-tier finding acceptance (LLD §4): marks an analysis finding for the
// submit payload. The finding must exist in the round's analysis; duplicates
// are rejected so the submit payload never double-lists a claim.
export type AcceptFindingResult =
  | { ok: true; accepted: { round: number; findingId: string }[] }
  | { ok: false; error: string }

export function acceptFinding(state: AppState, input: unknown): AcceptFindingResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "request body must be a JSON object" }
  }
  const draft = input as Record<string, unknown>
  const round = draft.round
  const findingId = draft.findingId
  if (typeof round !== "number" || !Number.isInteger(round)) {
    return { ok: false, error: "round must be an integer" }
  }
  if (typeof findingId !== "string" || findingId.trim() === "") {
    return { ok: false, error: "findingId is required and must be a non-empty string" }
  }
  const analysis = state.analysis.get(round)
  if (analysis === undefined) {
    return { ok: false, error: `no analysis exists for round ${round}` }
  }
  if (!analysis.findings.some((f) => f.id === findingId)) {
    return { ok: false, error: `finding ${findingId} does not exist in round ${round} analysis` }
  }
  if (state.acceptedFindings.some((a) => a.round === round && a.findingId === findingId)) {
    return { ok: false, error: `finding ${findingId} is already accepted` }
  }
  state.acceptedFindings.push({ round, findingId })
  return { ok: true, accepted: [...state.acceptedFindings] }
}

// Control-tier submit (LLD §5c): explicit user requests + accepted findings +
// lesson-marked comments (as LessonCandidates, §7) serialize into the
// SubmitPayload stored on the state.
export type SubmitReviewResult = { ok: true; payload: SubmitPayload } | { ok: false; error: string }

export function submitReview(state: AppState, input: unknown): SubmitReviewResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "request body must be a JSON object" }
  }
  const requests = (input as Record<string, unknown>).requests
  if (requests !== undefined && !Array.isArray(requests)) {
    return { ok: false, error: "requests must be an array of strings" }
  }
  for (const text of requests ?? []) {
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, error: "each request must be a non-empty string" }
    }
  }
  if (state.submission !== undefined) {
    return { ok: false, error: "a submission already exists for this review" }
  }

  const payloadRequests: SubmitPayload["requests"] = (requests ?? []).map((text) => ({
    id: crypto.randomUUID(),
    text,
    origin: "user",
  }))
  for (const accepted of state.acceptedFindings) {
    const finding = state.analysis.get(accepted.round)?.findings.find((f) => f.id === accepted.findingId)
    if (finding === undefined) {
      return { ok: false, error: `accepted finding ${accepted.findingId} vanished from round ${accepted.round} analysis` }
    }
    payloadRequests.push({ id: crypto.randomUUID(), text: finding.claim, origin: "accepted-finding" })
  }
  const payload: SubmitPayload = { requests: payloadRequests, lessons: buildLessonCandidates(state) }
  state.submission = { payload }
  return { ok: true, payload }
}

// Control-tier plan approval (LLD §5c-3): the second human approval that
// authorizes the edit prompt (T23). Requires a submission and a plan.
export type ApprovePlanResult = { ok: true; planApproved: boolean } | { ok: false; error: string }

export function approvePlan(state: AppState): ApprovePlanResult {
  if (state.submission === undefined) {
    return { ok: false, error: "nothing has been submitted yet" }
  }
  if (state.submission.plan === undefined) {
    return { ok: false, error: "no plan exists yet" }
  }
  if (state.submission.planApproved) {
    return { ok: false, error: "the plan is already approved" }
  }
  state.submission.planApproved = true
  return { ok: true, planApproved: true }
}

// Control-tier round capture (LLD §4, §5c-5): consented capture of round N+1,
// gated on the fix flow having reported (statuses, or a stall — §9 keeps the
// review usable). One round per status report (`roundPrompted`).
export type CaptureConsentedResult = { ok: true; round: Round } | { ok: false; error: string }

export async function captureConsentedRound(state: AppState): Promise<CaptureConsentedResult> {
  const submission = state.submission
  if (submission === undefined || (submission.statuses === undefined && submission.stalled !== true)) {
    return { ok: false, error: "a new round is only offered after the fix flow reports statuses" }
  }
  if (submission.roundPrompted) {
    return { ok: false, error: "a round was already captured for this status report" }
  }
  const round = await captureRound(state)
  submission.roundPrompted = true
  return { ok: true, round }
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value)
}

// Open-tier Q&A (LLD §4, §5c-6): validates the question and optional anchor,
// resolves the anchor's diff context for the prompt. No state mutation —
// questions are transient; the answer travels via HTTP response + SSE only.
export type AskQuestionResult =
  | { ok: true; question: string; prompt: string }
  | { ok: false; error: string }

export function askQuestion(state: AppState, input: unknown): AskQuestionResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "request body must be a JSON object" }
  }
  const draft = input as Record<string, unknown>
  const author = draft.author
  if (typeof author !== "string" || author.trim() === "") {
    return { ok: false, error: "author is required and must be a non-empty string" }
  }
  const question = draft.question
  if (typeof question !== "string" || question.trim() === "") {
    return { ok: false, error: "question is required and must be a non-empty string" }
  }

  let anchorContext: string | undefined
  if (draft.anchor !== undefined) {
    const resolved = resolveAnchor(state, draft.anchor)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    anchorContext = renderAnchorContext(resolved.anchor, resolved.files)
  }
  return { ok: true, question, prompt: questionPrompt({ author, question, anchorContext }) }
}

function resolveAnchor(
  state: AppState,
  anchor: unknown,
): { ok: true; files: DiffFile[]; anchor: NonNullable<Comment["anchor"]> } | { ok: false; error: string } {
  if (typeof anchor !== "object" || anchor === null) {
    return { ok: false, error: "anchor must be an object" }
  }
  const fields = anchor as Record<string, unknown>
  const round = fields.round
  if (typeof round !== "number" || !Number.isInteger(round)) {
    return { ok: false, error: "anchor.round must be an integer" }
  }
  const roundData = state.rounds.find((r) => r.n === round)
  if (roundData === undefined) {
    return { ok: false, error: `anchor.round ${round} does not exist` }
  }
  const { file, hunkIndex, lineRange } = fields
  if (file === undefined && hunkIndex !== undefined) {
    return { ok: false, error: "anchor.hunkIndex requires anchor.file" }
  }
  let resolvedFile: string | undefined
  if (file !== undefined) {
    if (typeof file !== "string" || !roundData.files.some((f) => f.path === file)) {
      return { ok: false, error: `anchor.file ${describeValue(file)} does not exist in round ${round}` }
    }
    resolvedFile = file
  }
  if (hunkIndex !== undefined) {
    if (typeof hunkIndex !== "number" || !Number.isInteger(hunkIndex) || hunkIndex < 0) {
      return { ok: false, error: "anchor.hunkIndex must be a non-negative integer" }
    }
    const hunk = roundData.files.find((f) => f.path === resolvedFile)?.hunks[hunkIndex]
    if (hunk === undefined) {
      return { ok: false, error: `anchor.hunkIndex ${hunkIndex} does not exist in ${resolvedFile} of round ${round}` }
    }
  }
  if (lineRange !== undefined) {
    if (hunkIndex === undefined) {
      return { ok: false, error: "anchor.lineRange requires anchor.hunkIndex" }
    }
    const hunk = roundData.files.find((f) => f.path === resolvedFile)?.hunks[hunkIndex]
    if (
      !Array.isArray(lineRange) ||
      lineRange.length !== 2 ||
      !lineRange.every((n) => typeof n === "number" && Number.isInteger(n)) ||
      hunk === undefined
    ) {
      return { ok: false, error: "anchor.lineRange must be a [start, end] pair of integers" }
    }
    const [start, end] = lineRange
    const lastNewLine = hunk.newStart + hunk.newLines - 1
    if (start === undefined || end === undefined || start > end || start < hunk.newStart || end > lastNewLine) {
      return { ok: false, error: `anchor.lineRange must fall within the hunk's new-side lines ${hunk.newStart}..${lastNewLine}` }
    }
  }
  return {
    ok: true,
    files: roundData.files,
    anchor: {
      round,
      ...(resolvedFile !== undefined ? { file: resolvedFile } : {}),
      ...(hunkIndex !== undefined ? { hunkIndex } : {}),
      ...(lineRange !== undefined ? { lineRange: lineRange as [number, number] } : {}),
    },
  }
}