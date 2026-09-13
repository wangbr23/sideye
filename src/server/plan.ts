import type { AppState, Plan, PlanVersion } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { promptWithTimeout, showToast } from "../session/client.ts"
import { planJsonSchema, planOutputSchema, type PlanOutput } from "../session/schemas.ts"
import { planPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Thinking limit per plan attempt: an over-limit draft fails the plan version
// loudly (browser retry) and stops the agent (LLD §5c).
export const PLAN_TIMEOUT_MS = Number(process.env.SIDEYE_PLAN_TIMEOUT_MS ?? 10 * 60_000)

// Plan flow (LLD §5c): after submit, one structured prompt asking for a
// per-request approach. Dispatched in the background (like the fix flow) so
// the submit response returns immediately and the UI shows a live planning
// state; plan.pending / plan.ready / plan.failed events keep every tab
// current. A validated plan is also mirrored as presentation-only Markdown
// onto its assistant message so the originating TUI can render it. Validation
// follows the
// analysis pattern: one repair retry with the issues appended, then a loud
// failure stored on the submission (retryable via POST /api/plan/retry) — the
// plan is load-bearing for the fix flow and has no designed fallback surface.
export function startPlanning(state: AppState, client: OpenCodeClient, cycleN: number, versionN: number): void {
  const version = getVersion(state, cycleN, versionN)
  if (!version || version.status !== "planning") return
  broadcast(state, "plan.pending", { cycle: cycleN, version: versionN })
  void showToast(client, `Drafting a fix plan (${version.payload.requests.length} items) — approve it in the review browser.`, "info")
  void runPlan(state, client, cycleN, versionN)
    .catch((err) => {
      if (version.status === "planning") { version.status = "failed"; version.error = err instanceof Error ? err.message : String(err) }
      broadcast(state, "plan.failed", { cycle: cycleN, version: versionN, error: version.error })
      void showToast(client, `Fix plan failed (v${versionN}) — retry from the review browser.`, "error")
    })
}

export async function runPlan(state: AppState, client: OpenCodeClient, cycleN: number, versionN: number): Promise<Plan> {
  const version = getVersion(state, cycleN, versionN)
  if (!version) throw new Error("plan version does not exist")
  if (version.plan !== undefined) return version.plan

  const requests = version.payload.requests.map((request) => ({
    id: request.id,
    text: request.text,
    origin: request.origin,
    comment: request.comment,
  }))

  const previous = state.submissions.find((cycle) => cycle.n === cycleN)?.plans.filter((item) => item.n < versionN && item.status === "ready").at(-1)?.plan
  const prompt = planPrompt(requests, previous, version.feedback)
  const first = await promptPlan(state, client, prompt)
  const parsed = parsePlan(first.info)
  const firstIssues = "data" in parsed ? coverageIssues(version, parsed.data) : parsed.issues
  if (firstIssues !== undefined) {
    const retry = await promptPlan(
      state,
      client,
      `${prompt}\n\nYour previous reply failed validation (${firstIssues}). Reply again with corrected JSON matching the schema.`,
    )
    const reparsed = parsePlan(retry.info)
    const retryIssues = "data" in reparsed ? coverageIssues(version, reparsed.data) : reparsed.issues
    if (retryIssues !== undefined) {
      throw new Error(`plan prompt produced invalid output twice: ${retryIssues}`)
    }
    if (!("data" in reparsed)) throw new Error("unreachable invalid repaired plan")
    const plan = storePlan(state, version, reparsed.data, cycleN)
    await mirrorPlanToTui(state, client, retry.info.id, plan, version)
    return plan
  }
  if (!("data" in parsed)) throw new Error("unreachable invalid plan")
  const plan = storePlan(state, version, parsed.data, cycleN)
  await mirrorPlanToTui(state, client, first.info.id, plan, version)
  return plan
}

function storePlan(state: AppState, version: PlanVersion, output: PlanOutput, cycle: number): Plan {
  const plan: Plan = { perRequest: output.perRequest }
  version.plan = plan; version.status = "ready"
  broadcast(state, "plan.ready", { cycle, version: version.n, plan })
  return plan
}

function coverageIssues(version: PlanVersion, output: PlanOutput): string | undefined {
  const expected = new Set(version.payload.requests.map((request) => request.id))
  const actual = output.perRequest.map((entry) => entry.requestId)
  return actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some((id) => !expected.has(id))
    ? "plan must contain exactly one item for every request id"
    : undefined
}

async function mirrorPlanToTui(state: AppState, client: OpenCodeClient, messageID: string, plan: Plan, version: PlanVersion): Promise<void> {
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
        text: renderPlanMarkdown(version, plan),
        // OpenCode replays non-ignored assistant parts into later model calls.
        // This text follows StructuredOutput and is only for TUI presentation;
        // replaying it makes the provider reject the message-part ordering.
        ignored: true,
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

function renderPlanMarkdown(version: PlanVersion, plan: Plan): string {
  const requests = new Map(version.payload.requests.map((request) => [request.id, request]))
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
  return [`# Sideye fix plan v${version.n}`, "", ...sections].join("\n").trim()
}

function getVersion(state: AppState, cycleN: number, versionN: number): PlanVersion | undefined {
  return state.submissions.find((cycle) => cycle.n === cycleN)?.plans.find((version) => version.n === versionN)
}

function parsePlan(info: { structured?: unknown; error?: { name?: string } }): { data: PlanOutput } | { issues: string } {
  if (info.error !== undefined) return { issues: info.error.name ?? "error" }
  const result = planOutputSchema.safeParse(info.structured)
  if (result.success) return { data: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
}

async function promptPlan(state: AppState, client: OpenCodeClient, prompt: string) {
  return promptWithTimeout(client, {
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: planJsonSchema },
    timeoutMs: PLAN_TIMEOUT_MS,
    what: "plan prompt",
  })
}
