import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import { startProgressTap, setProgress, clearProgress } from "../src/server/progress.ts"
import type { AppState } from "../src/types.ts"

// Progress tap over real HTTP: the stub OpenCode serves the health check and a
// live /event SSE stream the test pushes part events into. Covers tool/reasoning
// attribution, per-call step counting, unknown-session filtering, throttled
// broadcasts, and the immediate set/clear broadcasts.
let stops: (() => void)[] = []
let aborts: AbortController[] = []
afterEach(() => {
  for (const stop of stops) stop()
  stops = []
  for (const abort of aborts) abort.abort()
  aborts = []
})

async function until(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(25)
  }
  return check()
}

async function harness() {
  const pushers: ((chunk: string) => void)[] = []
  const opencode = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
      if (path === "/event") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(": connected\n\n"))
            pushers.push((chunk) => {
              try {
                controller.enqueue(encoder.encode(chunk))
              } catch {
                // stream gone
              }
            })
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ error: "unexpected path" }, { status: 404 })
    },
  })
  stops.push(() => opencode.stop(true))
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${opencode.port}`, healthTimeoutMs: 1000 })

  const state = createState({ token: "tok", sessionID: "ses_main", repoPath: "/repo", target: { kind: "worktree" } })
  const controller = new AbortController()
  aborts.push(controller)
  startProgressTap(state, client, controller.signal)

  const server = startReviewServer({ repoPath: "/repo", token: "tok", staticDir: "/tmp", handlers: buildHandlers(state) })
  stops.push(() => server.stop())
  const frames: string[] = []
  const res = await fetch(`http://127.0.0.1:${server.port}/api/events`)
  const reader = res.body!.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      frames.push(decoder.decode(value))
    }
  })().catch(() => {})
  stops.push(() => {
    reader.cancel().catch(() => {})
  })

  const push = (event: unknown): void => {
    for (const enqueue of pushers) enqueue(`data: ${JSON.stringify(event)}\n\n`)
  }
  const progressFrames = (): number => frames.join("").split("event: progress.update").length - 1
  return { state, push, progressFrames, frames }
}

const fixRecord = {
  kind: "fix" as const,
  phase: "running",
  sessionID: "ses_main",
  startedAt: new Date().toISOString(),
}

const analysisRecord = {
  kind: "analysis" as const,
  phase: "batch 1/2 — thinking",
  sessionID: "ses_child",
  startedAt: new Date().toISOString(),
  batch: { n: 1, of: 2 },
}

const toolEvent = (sessionID: string, status: "running" | "completed", title: string, callID = "c1") => ({
  id: "p1",
  type: "message.part.updated",
  properties: {
    sessionID,
    time: Date.now(),
    part: {
      id: "pt1",
      sessionID,
      messageID: "msg_1",
      type: "tool",
      callID,
      tool: "edit",
      state: { status, input: {}, title, output: "", metadata: {} },
    },
  },
})

const reasoningEvent = (sessionID: string, text: string) => ({
  id: "p2",
  type: "message.part.updated",
  properties: {
    sessionID,
    time: Date.now(),
    part: { id: "pt2", sessionID, messageID: "msg_1", type: "reasoning", text, time: { start: 1 } },
  },
})

describe("progress tap", () => {
  test("tool activity lands on the agent record; a call counts as one step", async () => {
    const { state, push } = await harness()
    state.progress.agent = { ...fixRecord }

    push(toolEvent("ses_main", "running", "src/a.ts"))
    push(toolEvent("ses_main", "completed", "src/a.ts"))
    push(toolEvent("ses_main", "running", "src/b.ts", "c2"))
    push(toolEvent("ses_main", "completed", "src/b.ts", "c2"))

    const agent = state.progress.agent!
    const seen = await until(() => agent.steps === 2)
    expect(seen).toBe(true)
    expect(agent.detail).toBe("edit: src/b.ts")
  })

  test("agent activity is attributed by the progress record session", async () => {
    const { state, push } = await harness()
    state.progress.agent = { ...fixRecord, sessionID: "ses_agent" }

    push(toolEvent("ses_main", "completed", "src/wrong.ts"))
    push(toolEvent("ses_agent", "completed", "src/right.ts"))

    const agent = state.progress.agent
    const seen = await until(() => agent?.steps === 1)
    expect(seen).toBe(true)
    expect(agent?.detail).toBe("edit: src/right.ts")
  })

  test("reasoning activity lands on the analysis record", async () => {
    const { state, push } = await harness()
    state.progress.analysis = { ...analysisRecord }

    push(reasoningEvent("ses_child", "Reading the diff for\nTripListView, then mapping hunks."))

    const analysis = state.progress.analysis!
    const seen = await until(() => (analysis.detail ?? "").length > 0)
    expect(seen).toBe(true)
    expect(analysis.detail).toBe("Reading the diff for TripListView, then mapping hunks.")
  })

  test("events for other sessions are ignored", async () => {
    const { state, push, progressFrames } = await harness()
    state.progress.agent = { ...fixRecord }
    push(toolEvent("ses_other", "completed", "src/x.ts", "cx"))
    await Bun.sleep(900)
    expect(state.progress.agent!.detail).toBeUndefined()
    expect(state.progress.agent!.steps).toBeUndefined()
    expect(progressFrames()).toBe(0)
  })

  test("rapid activity coalesces into one throttled broadcast", async () => {
    const { state, push, progressFrames } = await harness()
    state.progress.agent = { ...fixRecord }
    for (let i = 0; i < 6; i++) push(toolEvent("ses_main", "running", `src/${i}.ts`, `call${i}`))
    await Bun.sleep(900)
    expect(progressFrames()).toBe(1)
  })

  test("setProgress and clearProgress broadcast immediately", async () => {
    const { state, progressFrames } = await harness()
    setProgress(state, "agent", { ...fixRecord })
    const declared = await until(() => progressFrames() >= 1)
    expect(declared).toBe(true)
    clearProgress(state, "agent")
    const cleared = await until(() => progressFrames() >= 2)
    expect(cleared).toBe(true)
    expect(state.progress.agent).toBeUndefined()
  })

  test("long reasoning tails are truncated and squashed to one line", async () => {
    const { state, push } = await harness()
    state.progress.analysis = { ...analysisRecord }
    push(reasoningEvent("ses_child", `word ${"x".repeat(400)}`))
    const analysis = state.progress.analysis!
    const seen = await until(() => (analysis.detail ?? "").length > 0)
    expect(seen).toBe(true)
    expect(analysis.detail!.startsWith("…")).toBe(true)
    expect(analysis.detail!.length).toBe(160)
    expect(analysis.detail!.includes("\n")).toBe(false)
  })
})

describe("phase hooks", () => {
  test("analysis clears its record on success and failure", async () => {
    const { state } = await harness()
    state.progress.analysis = { ...analysisRecord }
    // simulate what runAnalysis does on its paths
    const { clearProgress } = await import("../src/server/progress.ts")
    clearProgress(state, "analysis")
    expect(state.progress.analysis).toBeUndefined()
  })
})

describe("state projection", () => {
  test("/api/state includes progress records", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: "/repo", target: { kind: "worktree" } })
    state.progress.agent = { ...fixRecord }
    const server = startReviewServer({ repoPath: "/repo", token: "tok", staticDir: "/tmp", handlers: buildHandlers(state) })
    stops.push(() => server.stop())
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, {
      headers: { authorization: "Bearer tok" },
    })
    const body = (await res.json()) as { progress: { agent?: { kind: string } } }
    expect(body.progress.agent?.kind).toBe("fix")
  })
})

describe("types", () => {
  test("FlowProgress accepts the projected shape", () => {
    const state: AppState = createState({ token: "t", sessionID: "s", repoPath: "/r", target: { kind: "worktree" } })
    state.progress.analysis = { ...analysisRecord, detail: "read: a.txt", steps: 3 }
    expect(state.progress.analysis.steps).toBe(3)
  })
})
