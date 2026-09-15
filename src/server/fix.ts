import type { AppState, RequestStatus } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { fixJsonSchema, fixOutputSchema, type FixOutput } from "../session/schemas.ts"
import { fixPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"
import { activeApprovedCycle } from "./submissions.ts"

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

  const stallTimeoutMs = options.stallTimeoutMs ?? FIX_STALL_TIMEOUT_MS
  const statusPollIntervalMs = options.statusPollIntervalMs ?? 1000
  const promptMessageID = await sendFixPrompt(client, state.sessionID, prompt)
  const outcome = await waitForSessionOutcome(client, state.sessionID, promptMessageID, stallTimeoutMs, statusPollIntervalMs)
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
  const repairPromptMessageID = await sendFixPrompt(
    client,
    state.sessionID,
    `${prompt}\n\nYour previous report failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.`,
  )
  const repairOutcome = await waitForSessionOutcome(client, state.sessionID, repairPromptMessageID, stallTimeoutMs, statusPollIntervalMs)
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
}

// Mints a user-message ID in OpenCode's `msg_` shape so promptAsync can be
// told which message is ours (the server adopts a caller-supplied messageID
// verbatim) and the wait can identify the run that prompt actually started.
function newPromptMessageID(): string {
  const time = (Date.now() & 0xffffffffffff).toString(16).padStart(12, "0")
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let random = ""
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  for (const byte of bytes) random += chars[byte % 62]
  return `msg_${time}${random}`
}

// Sends the fix prompt tagged with a caller-visible messageID so the run it
// starts can be told apart from any other run on the session.
async function sendFixPrompt(client: OpenCodeClient, sessionID: string, prompt: string): Promise<string> {
  const messageID = newPromptMessageID()
  const result = await client.session.promptAsync({
    sessionID,
    messageID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: fixJsonSchema },
  })
  if (result.error !== undefined) throw new Error(`sending fix prompt failed: ${JSON.stringify(result.error)}`)
  return messageID
}

function storeFixError(state: AppState, error: string): void {
  const approved = activeApprovedCycle(state)
  if (!approved) return
  approved.cycle.statusError = error
  broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, error })
}

function storeStatuses(state: AppState, output: FixOutput): void {
  const statuses: RequestStatus[] = output.statuses
  const approved = activeApprovedCycle(state)
  if (approved) {
    approved.cycle.statuses = statuses
    broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, statuses })
  }
}

function parseFix(info: { structured?: unknown }): { data: FixOutput } | { issues: string } {
  const result = fixOutputSchema.safeParse(info.structured)
  if (result.success) return { data: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
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

// Waits for THIS prompt's run to finish. `promptMessageID` is the user message
// the prompt was sent under; the wait only "arms" once an assistant message
// parented on it appears — positive evidence the run started. Before arming,
// idle/error events and busy→idle status transitions are ignored: they belong
// to whatever ran before the prompt (or to a queued-prompt gap), and trusting
// them produced false "invalid report" failures while the real fix hadn't even
// begun. If the queued prompt never starts, the stall budget fires honestly.
// Subscribes its own event stream — a shared stream let a settled wait's
// still-iterating loop steal the next wait's events. Losers exit via `settled`
// so no consumer outlives the race. A provider error must surface immediately
// rather than fall through to the 10-minute stall state.
async function waitForSessionOutcome(
  client: OpenCodeClient,
  sessionID: string,
  promptMessageID: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<SessionOutcome> {
  // Each wait subscribes its own event stream: a shared stream let a settled
  // wait's still-iterating loop steal the next wait's events. The SDK offers
  // no way to unblock a pending stream.next() (an options signal is silently
  // ignored, and generator.return() deadlocks behind a pending read), so a
  // losing terminal loop stays parked on one open connection until the
  // process ends — inert, and cheaper than stolen events.
  const events = await client.event.subscribe()
  let report: StructuredReport | undefined
  let armed = false
  let seenBusy = false
  let settled = false
  const terminal = (async (): Promise<SessionOutcome> => {
    while (!settled) {
      let event: Awaited<ReturnType<typeof events.stream.next>>
      try {
        event = await events.stream.next()
      } catch {
        break // teardown abort or transport drop — poll/stall arms remain
      }
      const { value, done } = event
      if (done) return await new Promise<SessionOutcome>(() => {})
      if (value.type === "message.updated" && value.properties.sessionID === sessionID && value.properties.info.role === "assistant") {
        const info = value.properties.info
        if (info.parentID !== promptMessageID) continue // another run's message — not ours
        armed = true
        report = {
          structured: info.structured,
          error: info.error === undefined
            ? undefined
            : { name: info.error.name, data: "data" in info.error ? info.error.data as { message?: string } : undefined },
        }
      }
      if (value.type === "session.error" && value.properties.sessionID === sessionID && armed) {
        return { kind: "error", error: value.properties.error }
      }
      if (value.type === "session.idle" && value.properties.sessionID === sessionID && armed) return { kind: "idle", report }
    }
    return await new Promise<SessionOutcome>(() => {})
  })()
  const polledIdle = (async (): Promise<SessionOutcome> => {
    await Bun.sleep(pollIntervalMs)
    while (!settled) {
      try {
        const status = await client.session.status()
        const type = status.data?.[sessionID]?.type
        if (type === "busy" || type === "retry") seenBusy = true
        if (armed && status.error === undefined && seenBusy && type !== "busy" && type !== "retry") {
          // The run's last assistant message.updated precedes the status flip,
          // so `report` already holds the final report when this fires.
          return { kind: "idle", report }
        }
      } catch {
      }
      await Bun.sleep(pollIntervalMs)
    }
    return { kind: "stalled" }
  })()
  const stall = (async (): Promise<SessionOutcome> => {
    await Bun.sleep(timeoutMs)
    while (!settled) {
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
        return { kind: "stalled" }
      } catch {
        return { kind: "stalled" }
      }
    }
    return { kind: "stalled" }
  })()
  try {
    return await Promise.race([terminal, polledIdle, stall])
  } finally {
    settled = true
  }
}

// The fix report is the structured output of the latest assistant message.
async function latestStructured(client: OpenCodeClient, sessionID: string): Promise<StructuredReport> {
  const result = await client.session.messages({ sessionID, limit: 10 })
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
