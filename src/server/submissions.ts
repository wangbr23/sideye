import type { AppState, Plan, PlanVersion, SubmissionCycle, SubmitPayload, WorkRequest } from "../types.ts"
import { buildLessonCandidates } from "../lesson.ts"

export type SubmissionResult<T> = { ok: true; value: T } | { ok: false; error: string }

const copyPayload = (payload: SubmitPayload): SubmitPayload => structuredClone(payload)

function approvedRequests(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const cycle of state.submissions) {
    const approved = cycle.approvedPlan === undefined ? undefined : cycle.plans.find((plan) => plan.n === cycle.approvedPlan)
    for (const request of approved?.payload.requests ?? []) {
      if (request.origin === "comment") ids.add(`comment:${request.id}`)
      if (request.finding) ids.add(`finding:${request.finding.round}:${request.finding.findingId}`)
    }
  }
  return ids
}

function candidatePayload(state: AppState, typed: string[], base?: SubmitPayload): SubmitPayload {
  const requests: WorkRequest[] = base ? copyPayload(base).requests : typed.map((text) => ({ id: crypto.randomUUID(), text, origin: "user" }))
  const covered = new Set(requests.filter((request) => request.origin === "comment").map((request) => `comment:${request.id}`))
  const approved = approvedRequests(state)
  for (const comment of state.comments) {
    const identity = `comment:${comment.id}`
    if (!approved.has(identity) && !covered.has(identity)) {
      requests.push({ id: comment.id, text: comment.body, origin: "comment", comment: { author: comment.author, anchor: structuredClone(comment.anchor) } })
    }
  }
  for (const accepted of state.acceptedFindings) {
    const identity = `finding:${accepted.round}:${accepted.findingId}`
    if (approved.has(identity) || requests.some((request) => request.finding?.round === accepted.round && request.finding.findingId === accepted.findingId)) continue
    const finding = state.analysis.get(accepted.round)?.findings.find((item) => item.id === accepted.findingId)
    if (finding) requests.push({ id: crypto.randomUUID(), text: finding.claim, origin: "accepted-finding", finding: { ...accepted } })
  }
  const commentIds = new Set(requests.filter((request) => request.origin === "comment").map((request) => request.id))
  return { requests, lessons: buildLessonCandidates(state).filter((lesson) => commentIds.has(lesson.commentId)) }
}

export function startCycle(state: AppState, input: unknown): SubmissionResult<SubmissionCycle> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "request body must be a JSON object" }
  const raw = (input as Record<string, unknown>).requests
  if (raw !== undefined && !Array.isArray(raw)) return { ok: false, error: "requests must be an array of strings" }
  const typed = raw ?? []
  if (!typed.every((text) => typeof text === "string" && text.trim() !== "")) return { ok: false, error: "each request must be a non-empty string" }
  const round = state.rounds.at(-1)?.n ?? 1
  if (state.submissions.some((cycle) => cycle.round === round)) return { ok: false, error: "a submission cycle already exists for the latest round" }
  const previous = state.submissions.at(-1)
  if (previous && previous.capturedRound !== round) return { ok: false, error: "capture the next diff round before starting another cycle" }
  const payload = candidatePayload(state, typed as string[])
  if (payload.requests.length === 0) return { ok: false, error: "nothing to submit — leave comments, accept findings, or type requests in the submit card first" }
  const cycle: SubmissionCycle = { n: state.submissions.length + 1, round, plans: [{ n: 1, payload, feedback: [], status: "planning", createdAt: new Date().toISOString() }] }
  state.submissions.push(cycle)
  return { ok: true, value: cycle }
}

export function revisePlan(state: AppState, input: unknown): SubmissionResult<PlanVersion> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "request body must be a JSON object" }
  const feedback = (input as Record<string, unknown>).feedback
  if (feedback !== undefined && (typeof feedback !== "string" || feedback.trim() === "")) return { ok: false, error: "feedback must be a non-empty string when present" }
  const cycle = state.submissions.at(-1)
  if (!cycle || cycle.approvedPlan !== undefined) return { ok: false, error: "no unapproved submission cycle exists" }
  if (cycle.plans.some((plan) => plan.status === "planning")) return { ok: false, error: "a plan is already being drafted" }
  const base = [...cycle.plans].reverse().find((plan) => plan.status === "ready")
  if (!base) return { ok: false, error: "no ready plan exists to revise" }
  const payload = candidatePayload(state, [], base.payload)
  const hasNewComments = payload.requests.some((request) => request.origin === "comment" && !base.payload.requests.some((old) => old.id === request.id))
  if (feedback === undefined && !hasNewComments) return { ok: false, error: "feedback or a new comment is required to revise a plan" }
  const version: PlanVersion = { n: cycle.plans.length + 1, payload, feedback: [...base.feedback, ...(feedback === undefined ? [] : [feedback])], status: "planning", createdAt: new Date().toISOString() }
  cycle.plans.push(version)
  return { ok: true, value: version }
}

export function retryPlan(state: AppState, input: unknown): SubmissionResult<PlanVersion> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "request body must be a JSON object" }
  const { cycle: cycleN, version: versionN } = input as Record<string, unknown>
  const plan = planByIdentity(state, cycleN, versionN)
  if (!plan.ok) return plan
  if (plan.value.status !== "failed") return { ok: false, error: "only a failed plan version can be retried" }
  const cycle = plan.valueCycle
  if (!cycle || cycle.approvedPlan !== undefined || cycle.plans.some((item) => item.status === "planning")) return { ok: false, error: "plan retry is no longer valid" }
  plan.value.status = "planning"; plan.value.error = undefined
  return { ok: true, value: plan.value }
}

function planByIdentity(state: AppState, cycleN: unknown, versionN: unknown): SubmissionResult<PlanVersion> & { valueCycle?: SubmissionCycle } {
  if (!Number.isInteger(cycleN) || !Number.isInteger(versionN)) return { ok: false, error: "cycle and version must be integers" }
  const cycle = state.submissions.find((item) => item.n === cycleN)
  const plan = cycle?.plans.find((item) => item.n === versionN)
  return cycle && plan ? { ok: true, value: plan, valueCycle: cycle } : { ok: false, error: "plan cycle/version does not exist" }
}

export function approvePlanVersion(state: AppState, input: unknown): SubmissionResult<{ cycle: SubmissionCycle; plan: PlanVersion }> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "request body must be a JSON object" }
  const ids = input as Record<string, unknown>; const found = planByIdentity(state, ids.cycle, ids.version)
  if (!found.ok || !found.valueCycle) return found as SubmissionResult<{ cycle: SubmissionCycle; plan: PlanVersion }>
  const { value: plan, valueCycle: cycle } = found
  if (cycle !== state.submissions.at(-1) || cycle.approvedPlan !== undefined || plan.status !== "ready" || plan.plan === undefined) return { ok: false, error: "plan is stale, pending, failed, or already approved" }
  if (cycle.plans.some((item) => item.status === "planning")) return { ok: false, error: "a newer plan is still being drafted" }
  cycle.approvedPlan = plan.n
  return { ok: true, value: { cycle, plan } }
}

export function activeApprovedCycle(state: AppState): { cycle: SubmissionCycle; plan: PlanVersion; planValue: Plan } | undefined {
  const cycle = state.submissions.at(-1)
  const plan = cycle?.approvedPlan === undefined ? undefined : cycle.plans.find((item) => item.n === cycle.approvedPlan)
  return cycle && plan?.plan ? { cycle, plan, planValue: plan.plan } : undefined
}
