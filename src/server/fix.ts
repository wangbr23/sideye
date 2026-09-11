import type { AppState, RequestStatus } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { fixJsonSchema, fixOutputSchema, type FixOutput } from "../session/schemas.ts"
import { fixPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

export const FIX_STALL_TIMEOUT_MS = 10 * 60 * 1000

export interface FixOptions {
  // overrides the 10-minute stall budget (tests)
  stallTimeoutMs?: number
}

// Fix + status flow (LLD §5c-3/4, §9): the fix prompt authorizes editing and
// requires a per-request status report with checks from the project's
// AGENTS.md. The prompt goes out asynchronously (the run can take minutes);
// the result is awaited via the session.idle event, with a 10-minute stall
// timeout that marks the session unresponsive while the review stays usable.
// Called fire-and-forget by the approve route — failures are contained here
// and surfaced via state + status.ready, never thrown into the void.
export function startFixAndStatus(state: AppState, client: OpenCodeClient): void {
  void runFixAndStatus(state, client).catch((err) => {
    if (state.submission !== undefined) {
      state.submission.statusError = err instanceof Error ? err.message : String(err)
    }
    broadcast(state, "status.ready", { error: state.submission?.statusError })
  })
}

export async function runFixAndStatus(state: AppState, client: OpenCodeClient, options: FixOptions = {}): Promise<void> {
  const submission = state.submission
  if (submission === undefined || submission.plan === undefined || !submission.planApproved) {
    throw new Error("fix flow requires an approved plan")
  }
  const prompt = fixPrompt({
    requests: submission.payload.requests.map((request) => ({
      id: request.id,
      text: request.text,
      origin: request.origin,
      comment: request.comment,
    })),
    plan: submission.plan,
    lessons: submission.payload.lessons.map((lesson) => ({
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
    await client.session.promptAsync({
      sessionID: state.sessionID,
      parts: [{ type: "text", text: prompt }],
      format: { type: "json_schema", schema: fixJsonSchema },
    })
    const wentIdle = await waitForIdle(events, state.sessionID, stallTimeoutMs)
    if (!wentIdle) {
      submission.stalled = true
      broadcast(state, "status.ready", { stalled: true })
      return
    }
    const report = await latestStructured(client, state.sessionID)
    const parsed = parseFix(report)
    if ("data" in parsed) {
      storeStatuses(state, parsed.data)
      return
    }
    // one repair pass, same as every structured flow (LLD §7)
    await client.session.promptAsync({
      sessionID: state.sessionID,
      parts: [{ type: "text", text: `${prompt}\n\nYour previous report failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.` }],
      format: { type: "json_schema", schema: fixJsonSchema },
    })
    const wentIdleAgain = await waitForIdle(events, state.sessionID, stallTimeoutMs)
    if (!wentIdleAgain) {
      submission.stalled = true
      broadcast(state, "status.ready", { stalled: true })
      return
    }
    const repaired = await latestStructured(client, state.sessionID)
    const reparsed = parseFix(repaired)
    if (!("data" in reparsed)) {
      submission.statusError = `status report failed validation twice: ${reparsed.issues}`
      broadcast(state, "status.ready", { error: submission.statusError })
      return
    }
    storeStatuses(state, reparsed.data)
  } finally {
    events.stream.return(undefined)
  }
}

function storeStatuses(state: AppState, output: FixOutput): void {
  const statuses: RequestStatus[] = output.statuses
  if (state.submission !== undefined) state.submission.statuses = statuses
  broadcast(state, "status.ready", { statuses })
}

function parseFix(info: { structured?: unknown; error?: { name?: string } }): { data: FixOutput } | { issues: string } {
  if (info.error !== undefined) return { issues: info.error.name ?? "error" }
  const result = fixOutputSchema.safeParse(info.structured)
  if (result.success) return { data: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
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
async function latestStructured(client: OpenCodeClient, sessionID: string): Promise<{ structured?: unknown; error?: { name?: string } }> {
  const result = await client.session.messages({ sessionID, limit: 10 })
  if (result.error !== undefined) throw new Error(`reading session messages failed: ${JSON.stringify(result.error)}`)
  const messages = result.data ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.role === "assistant") return { structured: info.structured, error: info.error === undefined ? undefined : { name: info.error.name } }
  }
  return { structured: undefined }
}