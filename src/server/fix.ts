import type { AppState, RequestStatus } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { fixJsonSchema, fixOutputSchema, type FixOutput } from "../session/schemas.ts"
import { fixPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"
import { activeApprovedCycle } from "./submissions.ts"
import { debugLog } from "./debuglog.ts"

export const FIX_STALL_TIMEOUT_MS = 10 * 60 * 1000

export interface FixOptions {
  // overrides the 10-minute stall budget (tests)
  stallTimeoutMs?: number
  statusPollIntervalMs?: number
  cycleN?: number
  versionN?: number
}

// Fix + status flow (LLD §5c-3/4, §9): the fix prompt authorizes editing and
// requires a per-request status report with checks from the project's
// AGENTS.md. The prompt goes out asynchronously (the run can take minutes);
// the result is awaited via the session.idle event, with a 10-minute stall
// timeout that marks the session unresponsive while the review stays usable.
// Called fire-and-forget by the approve route — failures are contained here
// and surfaced via state + status.ready, never thrown into the void.
export function startFixAndStatus(state: AppState, client: OpenCodeClient, cycleN: number, versionN: number): void {
  void runFixAndStatus(state, client, { cycleN, versionN }).catch((err) => {
    const cycle = state.submissions.find((item) => item.n === cycleN)
    if (cycle) cycle.statusError = err instanceof Error ? err.message : String(err)
    broadcast(state, "status.ready", { cycle: cycleN, version: versionN, error: cycle?.statusError })
  })
}

export async function runFixAndStatus(state: AppState, client: OpenCodeClient, options: FixOptions = {}): Promise<void> {
  debugLog("fix.start", { sessionID: state.sessionID, cycleN: options.cycleN, versionN: options.versionN })
  const approved = activeApprovedCycle(state)
  if (!approved || (options.cycleN !== undefined && (approved.cycle.n !== options.cycleN || approved.plan.n !== options.versionN))) {
    throw new Error("fix flow requires an approved plan")
  }
  const prompt = fixPrompt({
    requests: approved.plan.payload.requests.map((request) => ({
      id: request.id,
      text: request.text,
      origin: request.origin,
      comment: request.comment,
    })),
    plan: approved.plan.plan!,
    feedback: approved.plan.feedback,
    lessons: approved.plan.payload.lessons.map((lesson) => ({
      excerpt: lesson.excerpt,
      provenance: {
        round: lesson.provenance.round,
        ...(lesson.provenance.file !== undefined ? { file: lesson.provenance.file } : {}),
        ...(lesson.provenance.hunkIndex !== undefined ? { hunkIndex: lesson.provenance.hunkIndex } : {}),
      },
    })),
  })

  debugLog("fix.promptBuilt", { promptChars: prompt.length })
  const stallTimeoutMs = options.stallTimeoutMs ?? FIX_STALL_TIMEOUT_MS
  const statusPollIntervalMs = options.statusPollIntervalMs ?? 1000
  const events = await client.event.subscribe()
  try {
    await sendFixPrompt(client, state.sessionID, prompt)
    debugLog("fix.promptSent", {})
    const outcome = await waitForSessionOutcome(events, client, state.sessionID, stallTimeoutMs, statusPollIntervalMs)
    debugLog("fix.outcome", { phase: "initial", ...describeOutcome(outcome) })
    if (outcome.kind === "error") {
      storeFixError(state, `fix pass failed: ${messageError(outcome.error)}`)
      return
    }
    if (outcome.kind === "stalled") {
      approved.cycle.stalled = true
      broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, stalled: true })
      return
    }
    const report = outcome.report ?? await latestStructured(client, state.sessionID)
    if (report.error !== undefined) {
      storeFixError(state, `fix pass failed: ${messageError(report.error)}`)
      return
    }
    const parsed = parseFix(report)
    if ("data" in parsed) {
      storeStatuses(state, parsed.data)
      return
    }
    // one repair pass, same as every structured flow (LLD §7)
    debugLog("fix.repairSend", {})
    await sendFixPrompt(
      client,
      state.sessionID,
      `${prompt}\n\nYour previous report failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.`,
    )
    const repairOutcome = await waitForSessionOutcome(events, client, state.sessionID, stallTimeoutMs, statusPollIntervalMs)
    debugLog("fix.outcome", { phase: "repair", ...describeOutcome(repairOutcome) })
    if (repairOutcome.kind === "error") {
      storeFixError(state, `fix pass failed: ${messageError(repairOutcome.error)}`)
      return
    }
    if (repairOutcome.kind === "stalled") {
      approved.cycle.stalled = true
      broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, stalled: true })
      return
    }
    const repaired = repairOutcome.report ?? await latestStructured(client, state.sessionID)
    if (repaired.error !== undefined) {
      storeFixError(state, `fix pass failed: ${messageError(repaired.error)}`)
      return
    }
    const reparsed = parseFix(repaired)
    if (!("data" in reparsed)) {
      storeFixError(state, `status report failed validation twice: ${reparsed.issues}`)
      return
    }
    storeStatuses(state, reparsed.data)
  } finally {
    events.stream.return(undefined)
  }
}

async function sendFixPrompt(client: OpenCodeClient, sessionID: string, prompt: string): Promise<void> {
  const result = await client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: fixJsonSchema },
  })
  debugLog("fix.send", { sessionID, error: result.error !== undefined ? JSON.stringify(result.error).slice(0, 500) : null })
  if (result.error !== undefined) throw new Error(`sending fix prompt failed: ${JSON.stringify(result.error)}`)
}

function storeFixError(state: AppState, error: string): void {
  const approved = activeApprovedCycle(state)
  debugLog("fix.statusError", { error })
  if (!approved) return
  approved.cycle.statusError = error
  broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, error })
}

function storeStatuses(state: AppState, output: FixOutput): void {
  const statuses: RequestStatus[] = output.statuses
  const approved = activeApprovedCycle(state)
  debugLog("fix.statuses", { count: statuses.length })
  if (approved) {
    approved.cycle.statuses = statuses
    broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, statuses })
  }
}

function parseFix(info: { structured?: unknown }): { data: FixOutput } | { issues: string } {
  const result = fixOutputSchema.safeParse(info.structured)
  if (result.success) {
    debugLog("fix.parse", { ok: true })
    return { data: result.data }
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
  debugLog("fix.parse", { ok: false, issues, structuredType: typeof info.structured })
  return { issues }
}

// TEMPORARY (diagnostic): summarizes which race arm won and what it saw.
function describeOutcome(outcome: SessionOutcome): Record<string, unknown> {
  if (outcome.kind === "idle") {
    return {
      kind: outcome.kind,
      hasReport: "report" in outcome,
      structuredDefined: outcome.report?.structured !== undefined,
      reportError: outcome.report?.error ?? null,
    }
  }
  if (outcome.kind === "error") return { kind: "error", error: outcome.error ?? null }
  return { kind: "stalled" }
}

interface MessageError {
  name?: string
  data?: { message?: string }
}

function messageError(error: MessageError | undefined): string {
  return error?.data?.message ?? error?.name ?? "unknown model error"
}

type StructuredReport = { structured?: unknown; error?: MessageError }
type SessionOutcome = { kind: "idle"; report?: StructuredReport } | { kind: "error"; error?: MessageError } | { kind: "stalled" }

// Waits for this session to become idle or fail. Iterates with .next() rather
// than for-await so the generator survives the wait — the repair pass waits on
// the same stream. A provider error must surface immediately rather than fall
// through to the 10-minute stall state.
async function waitForSessionOutcome(
  events: Awaited<ReturnType<OpenCodeClient["event"]["subscribe"]>>,
  client: OpenCodeClient,
  sessionID: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<SessionOutcome> {
  let report: StructuredReport | undefined
  let seenBusy = false
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const terminal = (async (): Promise<SessionOutcome> => {
    while (true) {
      const { value, done } = await events.stream.next()
      if (done) {
        debugLog("wait.streamDone", { sessionID, elapsedMs: elapsed() })
        return await new Promise<SessionOutcome>(() => {})
      }
      // TEMPORARY (diagnostic): event-level evidence of what resolves the wait.
      const props = value.properties as
        | { sessionID?: string; info?: { id?: string; role?: string; finish?: string; structured?: unknown; error?: { name?: string } } }
        | undefined
      debugLog("wait.event", { type: value.type, eventSession: props?.sessionID, match: props?.sessionID === sessionID, elapsedMs: elapsed() })
      if (value.type === "message.updated" && value.properties.sessionID === sessionID && value.properties.info.role === "assistant") {
        const info = value.properties.info
        debugLog("wait.event.message", {
          messageID: info.id,
          finish: info.finish ?? null,
          structuredDefined: info.structured !== undefined,
          errorName: info.error?.name ?? null,
          elapsedMs: elapsed(),
        })
        report = {
          structured: info.structured,
          error: info.error === undefined
            ? undefined
            : { name: info.error.name, data: "data" in info.error ? info.error.data as { message?: string } : undefined },
        }
      }
      if (value.type === "session.error" && value.properties.sessionID === sessionID) {
        debugLog("wait.terminalError", { sessionID, elapsedMs: elapsed() })
        return { kind: "error", error: value.properties.error }
      }
      if (value.type === "session.idle" && value.properties.sessionID === sessionID) {
        debugLog("wait.terminalIdle", {
          sessionID,
          elapsedMs: elapsed(),
          seenBusy,
          reportSeen: report !== undefined,
          structuredDefined: report?.structured !== undefined,
          reportError: report?.error ?? null,
        })
        return { kind: "idle", report }
      }
    }
  })()
  const polledIdle = (async (): Promise<SessionOutcome> => {
    await Bun.sleep(pollIntervalMs)
    while (true) {
      try {
        const status = await client.session.status()
        const type = status.data?.[sessionID]?.type
        debugLog("wait.poll", {
          type: type ?? null,
          seenBusy,
          hasData: status.data !== undefined,
          statusError: status.error !== undefined,
          elapsedMs: elapsed(),
        })
        if (type === "busy" || type === "retry") seenBusy = true
        if (status.error === undefined && seenBusy && type !== "busy" && type !== "retry") {
          debugLog("wait.polledIdleReturn", { sessionID, elapsedMs: elapsed() })
          return { kind: "idle" }
        }
      } catch {
      }
      await Bun.sleep(pollIntervalMs)
    }
  })()
  const stall = (async (): Promise<SessionOutcome> => {
    await Bun.sleep(timeoutMs)
    while (true) {
      try {
        const status = await client.session.status()
        const type = status.data?.[sessionID]?.type
        if (type === "busy" || type === "retry") {
          await Bun.sleep(pollIntervalMs)
          continue
        }
        if (seenBusy) {
          // Session was active but is now idle — yield to polledIdle so a
          // normal completion isn't misreported as a stall.
          await Bun.sleep(5 * pollIntervalMs)
        }
        debugLog("wait.stallFired", { sessionID, elapsedMs: elapsed(), type: type ?? null, seenBusy })
        return { kind: "stalled" }
      } catch {
        debugLog("wait.stallFired", { sessionID, elapsedMs: elapsed(), statusFailure: true })
        return { kind: "stalled" }
      }
    }
  })()
  return Promise.race([terminal, polledIdle, stall])
}

// The fix report is the structured output of the latest assistant message.
async function latestStructured(client: OpenCodeClient, sessionID: string): Promise<StructuredReport> {
  const result = await client.session.messages({ sessionID, limit: 10 })
  debugLog("fix.latestStructured", {
    sessionID,
    error: result.error !== undefined ? JSON.stringify(result.error).slice(0, 500) : null,
    messages: result.data?.length ?? null,
  })
  if (result.error !== undefined) throw new Error(`reading session messages failed: ${JSON.stringify(result.error)}`)
  const messages = result.data ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.role === "assistant") {
      const error = info.error === undefined
        ? undefined
        : {
            name: info.error.name,
            data: "data" in info.error ? info.error.data as { message?: string } : undefined,
          }
      return { structured: info.structured, error }
    }
  }
  return { structured: undefined }
}
