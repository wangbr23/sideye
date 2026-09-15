import type { AppState } from "../types.ts"
import type { RouteHandler } from "./http.ts"
import { sseResponse, broadcast } from "./sse.ts"
import { addComment, deleteComment, acceptFinding, askQuestion, captureConsentedRound } from "./state.ts"
import { approvePlanVersion, retryPlan, revisePlan, startCycle } from "./submissions.ts"
import { startFixAndStatus } from "./fix.ts"
import { startAnalysis } from "./analysis.ts"
import { startPlanning } from "./plan.ts"
import type { OpenCodeClient } from "../session/client.ts"

export interface RouteDependencies {
  // OpenCode session client — present in the real launch flow; the Q&A route
  // reports a loud 500 without it rather than pretending to work.
  client?: OpenCodeClient
}

// Open-tier state projection (LLD §4): everything the frontend and local agents
// may read. The reviewer token and the SSE client set are deliberately excluded
// — the token only ever travels in the reviewer URL.
export function projectState(state: AppState, options: { sessionLinked?: boolean } = {}): unknown {
  const cycle = state.submissions.at(-1)
  const plan = cycle?.plans.at(-1)
  return {
    sessionID: state.sessionID,
    // whether an OpenCode session client is linked — without it submit stores
    // the payload but no plan can ever be drafted; the UI says so instead of
    // showing an eternal "planning" state
    sessionLinked: options.sessionLinked ?? false,
    repoPath: state.repoPath,
    target: state.target,
    rounds: state.rounds,
    comments: state.comments,
    analysis: Object.fromEntries(state.analysis),
    analysisStatus: Object.fromEntries(state.analysisStatus),
    acceptedFindings: state.acceptedFindings,
    submissions: state.submissions,
    progress: state.progress,
    // Transitional convenience projection for the existing action bar. Canonical
    // history is `submissions`; this never owns mutable authorization state.
    submission: cycle === undefined ? null : {
      cycle: cycle.n, version: plan?.n, payload: plan?.payload, planning: plan?.status === "planning", plan: plan?.plan,
      planApproved: cycle.approvedPlan !== undefined, planError: plan?.error, statuses: cycle.statuses,
      roundPrompted: cycle.capturedRound !== undefined, stalled: cycle.stalled, statusError: cycle.statusError,
    },
  }
}

export function buildHandlers(state: AppState, deps: RouteDependencies = {}): Record<string, RouteHandler> {
  return {
    "GET /api/state": () => Response.json(projectState(state, { sessionLinked: deps.client !== undefined })),
    "GET /api/events": () => sseResponse(state),
    // Open-tier page liveness beacon: the launcher tears the review down when
    // no page has beaconed within the grace window (the browser was closed).
    "POST /api/beacon": () => {
      state.lastHeartbeat = Date.now()
      return Response.json({ ok: true })
    },
    "POST /api/comments": async (req) => {
      const result = addComment(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.comment)
    },
    "POST /api/comments/delete": async (req) => {
      const result = deleteComment(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json({ deleted: result.id })
    },
    "POST /api/findings/accept": async (req) => {
      const input = await parseJson(req)
      const result = acceptFinding(state, input)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.accepted)
    },
    "POST /api/submit": async (req) => {
      const input = await parseJson(req)
      const result = startCycle(state, input)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      // the plan prompt dispatches in the background (like the fix flow) — the
      // response returns immediately and plan.pending/plan.ready/plan.failed
      // events carry the progress
      if (deps.client) startPlanning(state, deps.client, result.value.n, 1)
      return Response.json({ cycle: result.value.n, version: 1, payload: result.value.plans[0]?.payload, plan: null })
    },
    "POST /api/plan/revise": async (req) => {
      if (!deps.client) return Response.json({ error: "OpenCode session is not linked" }, { status: 500 })
      const result = revisePlan(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      const cycle = state.submissions.at(-1)!
      startPlanning(state, deps.client, cycle.n, result.value.n)
      return Response.json({ cycle: cycle.n, version: result.value.n })
    },
    "POST /api/plan/retry": async (req) => {
      const result = retryPlan(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      if (!deps.client) return Response.json({ error: "OpenCode session is not linked" }, { status: 500 })
      const cycle = state.submissions.find((item) => item.plans.includes(result.value))!
      startPlanning(state, deps.client, cycle.n, result.value.n)
      return Response.json({ cycle: cycle.n, version: result.value.n })
    },
    "POST /api/plan/approve": async (req) => {
      const result = approvePlanVersion(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      // the fix run can take minutes — it proceeds in the background and the
      // status card fills via SSE status.ready (LLD §5c-4)
      if (deps.client) startFixAndStatus(state, deps.client, result.value.cycle.n, result.value.plan.n)
      return Response.json({ approved: true, cycle: result.value.cycle.n, version: result.value.plan.n })
    },
    "POST /api/rounds": async () => {
      const result = await captureConsentedRound(state)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      broadcast(state, "round.prompt", { round: result.round.n })
      // new round → new analysis, in the background like the fix flow
      if (deps.client) startAnalysis(state, result.round, deps.client)
      return Response.json({ round: result.round })
    },
    "POST /api/analysis/retry": async (req) => {
      const input = (await parseJson(req)) as { round?: unknown } | undefined
      const round = input?.round
      if (typeof round !== "number" || !Number.isInteger(round)) {
        return Response.json({ error: "round must be an integer" }, { status: 400 })
      }
      if (!state.rounds.some((item) => item.n === round)) {
        return Response.json({ error: `round ${round} does not exist` }, { status: 400 })
      }
      if (state.analysisStatus.get(round) === "pending") {
        return Response.json({ error: `analysis for round ${round} is already running` }, { status: 400 })
      }
      if (!deps.client) {
        return Response.json({ error: "OpenCode session is not linked" }, { status: 500 })
      }
      startAnalysis(state, state.rounds.find((item) => item.n === round)!, deps.client)
      return Response.json({ started: true, round })
    },
    "POST /api/questions": async (req) => {
      if (!deps.client) {
        return Response.json({ error: "OpenCode session is not linked" }, { status: 500 })
      }
      const input = await parseJson(req)
      const question = askQuestion(state, input)
      if (!question.ok) return Response.json({ error: question.error }, { status: 400 })
      const answer = await answerQuestion(deps.client, state, question.prompt)
      // The id lets the asking tab (HTTP response) and other tabs (SSE event)
      // dedupe the same answer.
      const answerId = crypto.randomUUID()
      broadcast(state, "answer", { id: answerId, question: question.question, answer })
      return Response.json({ id: answerId, answer })
    },
  }
}

async function answerQuestion(client: OpenCodeClient, state: AppState, prompt: string): Promise<string> {
  const result = await client.session.prompt({
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
  })
  if (result.error !== undefined) {
    throw new Error(`OpenCode question prompt failed: ${summarizeError(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error("OpenCode question prompt returned no data")
  }
  const text = result.data.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (text.trim() === "") {
    throw new Error("OpenCode question prompt returned no answer text")
  }
  return text
}

function summarizeError(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined // mutators reject non-objects with a 400 and a specific error
  }
}
