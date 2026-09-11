import type { AppState, Plan } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { planJsonSchema, planOutputSchema, type PlanOutput } from "../session/schemas.ts"
import { planPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Plan flow (LLD §5c): after submit, one structured prompt asking for a
// per-request approach. Dispatched in the background (like the fix flow) so
// the submit response returns immediately and the UI shows a live planning
// state; plan.pending / plan.ready / plan.failed events keep every tab
// current. A validated plan is also mirrored as Markdown onto its assistant
// message so the originating TUI can render it. Validation follows the
// analysis pattern: one repair retry with the issues appended, then a loud
// failure stored on the submission (retryable via POST /api/plan/retry) — the
// plan is load-bearing for the fix flow and has no designed fallback surface.
export function startPlanning(state: AppState, client: OpenCodeClient): void {
  const submission = state.submission
  if (submission === undefined || submission.plan !== undefined || submission.planning) return
  submission.planning = true
  broadcast(state, "plan.pending", {})
  void runPlan(state, client)
    .then(() => {
      if (state.submission !== undefined) state.submission.planning = false
    })
    .catch((err) => {
      if (state.submission !== undefined) {
        state.submission.planning = false
        state.submission.planError = err instanceof Error ? err.message : String(err)
      }
      broadcast(state, "plan.failed", { error: state.submission?.planError })
    })
}

export async function runPlan(state: AppState, client: OpenCodeClient): Promise<Plan> {
  const submission = state.submission
  if (submission === undefined) throw new Error("plan prompt requires a submission")
  if (submission.plan !== undefined) return submission.plan

  const requests = submission.payload.requests.map((request) => ({
    id: request.id,
    text: request.text,
    origin: request.origin,
    comment: request.comment,
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
    const plan = storePlan(state, reparsed.data)
    await mirrorPlanToTui(state, client, retry.info.id, plan)
    return plan
  }
  const plan = storePlan(state, parsed.data)
  await mirrorPlanToTui(state, client, first.info.id, plan)
  return plan
}

function storePlan(state: AppState, output: PlanOutput): Plan {
  const plan: Plan = { perRequest: output.perRequest }
  if (state.submission !== undefined) state.submission.plan = plan
  broadcast(state, "plan.ready", { plan })
  return plan
}

async function mirrorPlanToTui(state: AppState, client: OpenCodeClient, messageID: string, plan: Plan): Promise<void> {
  const partID = `prt_sideye_plan_${crypto.randomUUID().replaceAll("-", "")}`
  const now = Date.now()
  try {
    const result = await client.part.update({
      sessionID: state.sessionID,
      messageID,
      partID,
      part: {
        id: partID,
        sessionID: state.sessionID,
        messageID,
        type: "text",
        text: renderPlanMarkdown(state, plan),
        time: { start: now, end: now },
        metadata: { source: "sideye", kind: "plan" },
      },
    })
    if (result.error !== undefined) throw result.error
  } catch (err) {
    // The browser plan remains usable if this secondary presentation surface
    // is unavailable or changes in a future OpenCode release.
    console.warn("Sideye could not render the plan in the OpenCode TUI:", err)
  }
}

function renderPlanMarkdown(state: AppState, plan: Plan): string {
  const requests = new Map(state.submission?.payload.requests.map((request) => [request.id, request]) ?? [])
  const sections = plan.perRequest.flatMap((entry, index) => {
    const request = requests.get(entry.requestId)
    let source = "user request"
    if (request?.origin === "accepted-finding") source = "accepted finding"
    if (request?.origin === "comment") source = `comment by ${request.comment?.author ?? "unknown"}`
    const requestText = (request?.text ?? entry.requestId)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    const affectedFiles =
      entry.affectedFiles.length > 0
        ? entry.affectedFiles.map((file) => `- \`${file.replaceAll("`", "\\`")}\``)
        : ["- None listed"]

    return [
      `## Request ${index + 1}`,
      "",
      `**Source:** ${source}`,
      "",
      "**Request:**",
      requestText,
      "",
      "**Approach:**",
      entry.approach,
      "",
      "**Affected files:**",
      ...affectedFiles,
      "",
    ]
  })
  return ["# Sideye fix plan", "", ...sections].join("\n").trim()
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
