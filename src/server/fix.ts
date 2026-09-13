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
  const events = await client.event.subscribe()
  try {
    await sendFixPrompt(client, state.sessionID, prompt)
    const wentIdle = await waitForIdle(events, state.sessionID, stallTimeoutMs)
    if (!wentIdle) {
      approved.cycle.stalled = true
      broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, stalled: true })
      return
    }
    const report = await latestStructured(client, state.sessionID)
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
    await sendFixPrompt(
      client,
      state.sessionID,
      `${prompt}\n\nYour previous report failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.`,
    )
    const wentIdleAgain = await waitForIdle(events, state.sessionID, stallTimeoutMs)
    if (!wentIdleAgain) {
      approved.cycle.stalled = true
      broadcast(state, "status.ready", { cycle: approved.cycle.n, version: approved.plan.n, stalled: true })
      return
    }
    const repaired = await latestStructured(client, state.sessionID)
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
  if (result.error !== undefined) throw new Error(`sending fix prompt failed: ${JSON.stringify(result.error)}`)
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

function messageError(error: MessageError): string {
  return error.data?.message ?? error.name ?? "unknown model error"
}

// Resolves true when a session.idle event for this session arrives; false when
// the stream ends without one or the stall timeout fires (LLD §9: the session
// stopped responding). Iterates with .next() rather than for-await so the
// generator survives the wait — the repair pass waits on the same stream.
async function waitForIdle(
  events: Awaited<ReturnType<OpenCodeClient["event"]["subscribe"]>>,
  sessionID: string,
  timeoutMs: number,
): Promise<boolean> {
  const idle = (async () => {
    while (true) {
      const { value, done } = await events.stream.next()
      if (done) return false
      if (value.type === "session.idle" && value.properties.sessionID === sessionID) return true
    }
  })()
  return Promise.race([idle, Bun.sleep(timeoutMs).then(() => false)])
}

// The fix report is the structured output of the latest assistant message.
async function latestStructured(client: OpenCodeClient, sessionID: string): Promise<{ structured?: unknown; error?: MessageError }> {
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
