import type { AppState, Plan } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { planJsonSchema, planOutputSchema, type PlanOutput } from "../session/schemas.ts"
import { planPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Plan flow (LLD §5c): after submit, one blocking structured prompt asking for
// a per-request approach. Validation follows the analysis pattern: one repair
// retry with the issues appended, then a loud failure — the plan is load-bearing
// for the fix flow and has no designed fallback surface. Transport failures
// propagate.
export async function runPlan(state: AppState, client: OpenCodeClient): Promise<Plan> {
  const submission = state.submission
  if (submission === undefined) throw new Error("plan prompt requires a submission")
  if (submission.plan !== undefined) return submission.plan

  const requests = submission.payload.requests.map((request) => ({
    id: request.id,
    text: request.text,
    origin: request.origin,
    comment: request.commentId !== undefined ? state.comments.find((c) => c.id === request.commentId)?.body : undefined,
  }))

  const prompt = planPrompt(requests)
  const first = await promptPlan(state, client, prompt)
  const parsed = parsePlan(first.info)
  if (!("data" in parsed)) {
    const retry = await promptPlan(
      state,
      client,
      `${prompt}\n\nYour previous reply failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.`,
    )
    const reparsed = parsePlan(retry.info)
    if (!("data" in reparsed)) {
      throw new Error(`plan prompt produced invalid output twice: ${reparsed.issues}`)
    }
    return storePlan(state, reparsed.data)
  }
  return storePlan(state, parsed.data)
}

function storePlan(state: AppState, output: PlanOutput): Plan {
  const plan: Plan = { perRequest: output.perRequest }
  if (state.submission !== undefined) state.submission.plan = plan
  broadcast(state, "plan.ready", { plan })
  return plan
}

function parsePlan(info: { structured?: unknown; error?: { name?: string } }): { data: PlanOutput } | { issues: string } {
  if (info.error !== undefined) return { issues: info.error.name ?? "error" }
  const result = planOutputSchema.safeParse(info.structured)
  if (result.success) return { data: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
}

async function promptPlan(state: AppState, client: OpenCodeClient, prompt: string) {
  const result = await client.session.prompt({
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: planJsonSchema },
  })
  if (result.error !== undefined) {
    throw new Error(`OpenCode plan prompt failed: ${JSON.stringify(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error("OpenCode plan prompt returned no data")
  }
  return result.data
}