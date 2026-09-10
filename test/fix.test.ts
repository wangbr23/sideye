import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { OpenCodeClient } from "../src/session/client.ts"
import type { AppState, Plan, SubmitPayload } from "../src/types.ts"

// Fix + status flow e2e over real HTTP: the stub OpenCode serves the health
// check, prompt_async, the message list, and a live /event SSE stream that
// delivers session.idle. Covers: statuses collected on idle, ignored idle for
// other sessions, stall timeout, and double-invalid reports.
const validStatuses = {
  statuses: [
    { requestId: "r1", status: "addressed" as const, reason: "done", checks: [{ command: "bun test", passed: true, summary: "87 pass" }] },
    { requestId: "r2", status: "partial" as const, reason: "needs another pass", checks: [] },
  ],
}

let stubs: { stop(): void }[] = []
afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
})

async function stubOpencode(options: { structured?: unknown; idleDelayMs?: number; idleFor?: string; neverIdle?: boolean }) {
  const prompts: string[] = []
  // multiple subscribers: leaked SDK SSE clients from prior tests can
  // reconnect to a recycled port — everyone gets the idle frame
  const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const notify = () => {
    for (const controller of subscribers) {
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: "e1", type: "session.idle", properties: { sessionID: options.idleFor ?? "ses_1" } })}\n\n`,
          ),
        )
      } catch {
        subscribers.delete(controller) // stream gone — stop notifying it
      }
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
      if (path === "/event") {
        const stream = new ReadableStream({
          start(controller) {
            subscribers.add(controller)
            controller.enqueue(encoder.encode(": connected\n\n"))
          },
          cancel(controller) {
            subscribers.delete(controller)
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      if (path.endsWith("/prompt_async")) {
        const body = (await req.json()) as { parts: { text: string }[] }
        prompts.push(body.parts.map((p) => p.text).join("\n"))
        if (!options.neverIdle) setTimeout(() => notify(), options.idleDelayMs ?? 200)
        return new Response(null, { status: 204 })
      }
      if (path.endsWith("/message")) {
        return Response.json([
          { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", structured: options.structured }, parts: [] },
        ])
      }
      return Response.json({ error: "unexpected path" }, { status: 404 })
    },
  })
  stubs.push({ stop: () => server.stop(true) })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, prompts }
}

function stateReadyToFix() {
  const state = createState({ token: "tok", sessionID: "ses_1", repoPath: "/repo", target: { kind: "worktree" } })
  const payload: SubmitPayload = {
    requests: [
      { id: "r1", text: "split the loop", origin: "user" },
      { id: "r2", text: "off-by-one", origin: "accepted-finding" },
    ],
    lessons: [],
  }
  const plan: Plan = { perRequest: [{ requestId: "r1", approach: "split it", affectedFiles: ["a.txt"] }] }
  state.submission = { payload, plan }
  return state
}

async function startWithClient(state: AppState, client: OpenCodeClient | undefined) {
  const server = startReviewServer({
    repoPath: "/repo",
    token: state.token,
    staticDir: "/tmp",
    handlers: buildHandlers(state, { client }),
  })
  stubs.push({ stop: () => server.stop() })
  return server
}

describe("fix + status flow", () => {
  test("approval triggers the fix prompt; statuses land on session.idle via SSE", async () => {
    const stub = await stubOpencode({ structured: validStatuses })
    const state = stateReadyToFix()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    await reader.read() // : connected

    const approve = await fetch(`${base}/api/plan/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
    })
    expect(approve.status).toBe(200)
    expect(state.submission?.planApproved).toBe(true)

    const chunk = await (async () => {
      const deadline = Date.now() + 5000
      let text = ""
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
        if (text.includes("status.ready")) return text
      }
      return text
    })()
    expect(chunk).toContain("event: status.ready")
    expect(chunk).toContain('"statuses"')
    reader.releaseLock()

    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toContain("you are now authorized to edit files")
    expect(stub.prompts[0]).toContain("split the loop")
    expect(stub.prompts[0]).toContain("planned approach: split it")
    expect(stub.prompts[0]).toContain("AGENTS.md")
    expect(state.submission?.statuses).toEqual(validStatuses.statuses)
    expect(state.submission?.stalled).toBeUndefined()
  })

  test("idle events for other sessions are ignored", async () => {
    const stub = await stubOpencode({ structured: validStatuses, idleFor: "ses_other", idleDelayMs: 100 })
    const state = stateReadyToFix()
    const { runFixAndStatus } = await import("../src/server/fix.ts")
    state.submission!.planApproved = true
    await runFixAndStatus(state, stub.client, { stallTimeoutMs: 500 })
    // the foreign idle must not resolve the wait — the short stall budget fires
    expect(state.submission?.statuses).toBeUndefined()
    expect(state.submission?.stalled).toBe(true)
  })

  test("stall timeout marks the session unresponsive and keeps the review usable", async () => {
    const stub = await stubOpencode({ structured: validStatuses, neverIdle: true })
    const state = stateReadyToFix()
    await startWithClient(state, stub.client)
    const { runFixAndStatus } = await import("../src/server/fix.ts")
    state.submission!.planApproved = true
    const started = Date.now()
    await runFixAndStatus(state, stub.client, { stallTimeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(state.submission?.statuses).toBeUndefined()
    expect(state.submission?.stalled).toBe(true)
  })

  test("report failing validation twice records a status error", async () => {
    const bad = { statuses: [{ requestId: "r1", status: "done-deal", reason: "x" }] } // invalid status enum
    const stub = await stubOpencode({ structured: bad })
    const state = stateReadyToFix()
    const { runFixAndStatus } = await import("../src/server/fix.ts")
    state.submission!.planApproved = true
    await runFixAndStatus(state, stub.client, { stallTimeoutMs: 1000 })
    expect(state.submission?.statuses).toBeUndefined()
    expect(state.submission?.statusError).toMatch(/failed validation twice/)
    expect(state.submission?.stalled).toBeUndefined()
  })
})