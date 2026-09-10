import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { OpenCodeClient } from "../src/session/client.ts"
import type { AppState, Plan } from "../src/types.ts"

// Plan flow e2e over real HTTP: stub OpenCode (health + queued prompt
// responses), real review server, submit → plan prompt → plan.ready → approve.
const validPlan = {
  perRequest: [{ requestId: "r1", approach: "Split the loop and add a test.", affectedFiles: ["a.txt"] }],
}

function response(overrides: { structured?: unknown; error?: { name: string } } = {}) {
  return {
    info: { id: "msg_1", sessionID: "ses_1", role: "assistant", structured: overrides.structured, error: overrides.error },
    parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "raw" }],
  }
}

async function stubOpencode(responses: unknown[]) {
  const prompts: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
      if (!path.endsWith("/message") && !path.endsWith("/prompt_async")) {
        return Response.json({ error: "unexpected path" }, { status: 404 })
      }
      const body = (await req.json()) as { parts: { text: string }[] }
      prompts.push(body.parts.map((p) => p.text).join("\n"))
      return Response.json(responses.shift() ?? { info: {}, parts: [] })
    },
  })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, prompts, stop: () => server.stop(true) }
}

let stubs: { stop(): void }[] = []
afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
})

function stateForSubmit() {
  const state = createState({ token: "tok", sessionID: "ses_1", repoPath: "/repo", target: { kind: "worktree" } })
  state.analysis.set(1, {
    files: [],
    hunks: [],
    findings: [{ id: "f1", file: "a.txt", claim: "off-by-one in the loop", citations: [] }],
  })
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

describe("plan flow", () => {
  test("submit with a linked client prompts a plan, stores it, broadcasts plan.ready", async () => {
    const stub = await stubOpencode([response({ structured: validPlan })])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    await reader.read() // : connected

    await fetch(`${base}/api/findings/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ round: 1, findingId: "f1" }),
    })

    const res = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { payload: unknown; plan: Plan }
    expect(body.plan.perRequest[0]).toEqual(validPlan.perRequest[0])
    expect(state.submission?.plan).toEqual(body.plan)
    expect(body.payload).toEqual(state.submission?.payload)

    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toContain("sideye: code review fix plan")
    expect(stub.prompts[0]).toContain("split the loop")
    expect(stub.prompts[0]).toContain("origin: accepted-finding")
    expect(stub.prompts[0]).toContain("off-by-one in the loop")

    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain("event: plan.ready")
    reader.releaseLock()
  })

  test("invalid plan output retries once, then fails loudly leaving the payload stored", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] } // wrong id type
    const stub = await stubOpencode([response({ structured: bad }), response({ structured: bad })])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)

    await fetch(`http://127.0.0.1:${server.port}/api/findings/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ round: 1, findingId: "f1" }),
    })
    const res = await fetch(`http://127.0.0.1:${server.port}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    expect(res.status).toBe(500)
    const errBody = (await res.json()) as { error: string }
    expect(errBody.error).toMatch(/invalid output twice/)
    expect(stub.prompts).toHaveLength(2)
    expect(stub.prompts[1]).toMatch(/failed validation/)
    expect(state.submission?.payload.requests).toHaveLength(2) // payload kept
    expect(state.submission?.plan).toBeUndefined()
  })

  test("plan approval route: requires submission and plan, sets the flag once", async () => {
    const stub = await stubOpencode([response({ structured: validPlan })])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/plan/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}` },
      })

    const beforeSubmit = await approve()
    expect(beforeSubmit.status).toBe(400)
    expect(((await beforeSubmit.json()) as { error: string }).error).toMatch(/nothing has been submitted/)

    await fetch(`http://127.0.0.1:${server.port}/api/findings/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ round: 1, findingId: "f1" }),
    })
    await fetch(`http://127.0.0.1:${server.port}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    const first = await approve()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ approved: true })
    expect(state.submission?.planApproved).toBe(true)

    const again = await approve()
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toMatch(/already approved/)
  })

  test("submit without a linked client serializes the payload with plan null", async () => {
    const state = stateForSubmit()
    const server = await startWithClient(state, undefined)
    const res = await fetch(`http://127.0.0.1:${server.port}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { payload: unknown; plan: unknown }
    expect(body.plan).toBeNull()
    expect(((body.payload as { requests: unknown[] }).requests).length).toBe(1)
  })
})