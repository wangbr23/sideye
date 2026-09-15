import type { Event } from "@opencode-ai/sdk/v2"
import type { AppState, FlowProgress } from "../types.ts"
import type { OpenCodeClient } from "../session/client.ts"
import { broadcast } from "./sse.ts"

// Live progress (§5): OpenCode's event stream is the only source of what the
// agent is doing right now, so a single "tap" subscription runs for the whole
// review lifetime and folds message events into the two progress records.
// Unlike the per-wait event streams (fix.ts), this consumer is meant to block
// forever — no teardown, and it owns no shared stream so it cannot steal
// anyone's events. Broadcasts are throttled: part events arrive many times a
// second, and the browser patches its progress spots instead of re-rendering.
const BROADCAST_MIN_MS = 700
const DETAIL_MAX_CHARS = 160

export type ProgressSlot = "analysis" | "agent"

// Flow-code entry points: declare a phase (broadcasts immediately — phase
// transitions are the meaningful beats) or clear the record when done.
export function setProgress(state: AppState, slot: ProgressSlot, progress: FlowProgress): void {
  state.progress[slot] = progress
  broadcast(state, "progress.update", state.progress)
}

export function clearProgress(state: AppState, slot: ProgressSlot): void {
  if (state.progress[slot] === undefined) return
  delete state.progress[slot]
  broadcast(state, "progress.update", state.progress)
}

export function startProgressTap(state: AppState, client: OpenCodeClient, signal?: AbortSignal): void {
  void runTap(state, client, signal).catch(() => {})
}

async function runTap(state: AppState, client: OpenCodeClient, signal?: AbortSignal): Promise<void> {
  const stopped = (): boolean => signal?.aborted === true
  let lastBroadcast = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    lastBroadcast = Date.now()
    broadcast(state, "progress.update", state.progress)
  }
  // Coalesce bursts: the first update schedules a flush within the window,
  // later ones join the pending flush instead of pushing their own chunk.
  const schedule = (): void => {
    if (flushTimer !== undefined || stopped()) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flush()
    }, Math.max(0, BROADCAST_MIN_MS - (Date.now() - lastBroadcast)))
  }
  // A tool part fires part.updated for pending → running → completed; count a
  // call's step once. callIDs never repeat, so the set only grows by one entry
  // per tool call made during the review.
  const countedCalls = new Set<string>()

  // Resilient loop: a transport drop or a dead OpenCode retries the
  // subscription after a pause instead of silently ending live progress.
  while (!stopped()) {
    let events: Awaited<ReturnType<typeof client.event.subscribe>>
    try {
      events = await client.event.subscribe()
    } catch {
      if (stopped()) return
      await Bun.sleep(2000)
      continue
    }
    while (!stopped()) {
      let next: IteratorResult<Event, void>
      try {
        next = await events.stream.next()
      } catch {
        break
      }
      if (next.done) break
      if (applyEvent(state, next.value, countedCalls)) schedule()
    }
    if (stopped()) {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      return
    }
    await Bun.sleep(2000)
  }
  if (flushTimer !== undefined) clearTimeout(flushTimer)
}

// Returns true when the event changed a progress record and may need a flush.
function applyEvent(state: AppState, event: Event, countedCalls: Set<string>): boolean {
  if (event.type !== "message.part.updated") return false
  const part = event.properties.part
  let record: FlowProgress | undefined
  if (part.sessionID === state.progress.agent?.sessionID) record = state.progress.agent
  else if (part.sessionID === state.progress.analysis?.sessionID) record = state.progress.analysis
  if (record === undefined) return false

  if (part.type === "tool") {
    if (part.state.status === "completed" || part.state.status === "error") {
      const key = `${part.sessionID}:${part.callID}`
      if (!countedCalls.has(key)) {
        countedCalls.add(key)
        record.steps = (record.steps ?? 0) + 1
      }
    }
    if (part.state.status === "running" || part.state.status === "completed") {
      const title = part.state.title ?? ""
      if (title.trim() !== "") record.detail = oneLine(`${part.tool}: ${title}`)
    }
    return true
  }
  if (part.type === "reasoning" && part.text.trim() !== "") {
    // Reasoning streams as one growing text part — show the freshest tail.
    record.detail = oneLine(part.text, true)
    return true
  }
  return false
}

function oneLine(text: string, tail = false): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (line.length <= DETAIL_MAX_CHARS) return line
  return tail ? "…" + line.slice(-(DETAIL_MAX_CHARS - 1)) : line.slice(0, DETAIL_MAX_CHARS - 1) + "…"
}
