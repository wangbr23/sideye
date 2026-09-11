import { describe, expect, test, afterEach, spyOn } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { OpenCodeClient } from "../src/session/client.ts"
import type { AppState, Plan } from "../src/types.ts"
import { planPrompt } from "../src/session/prompts.ts"

// Plan flow e2e over real HTTP: stub OpenCode (health + queued prompt
// responses), real review server, submit → plan prompt → plan.ready → approve.
const validPlan = {
  perRequest: [{ requestId: "r1", approach: "Split the loop and add a test.", affectedFiles: ["a.txt"] }],
}

function response(overrides: { id?: string; structured?: unknown; error?: { name: string } } = {}) {
  const id = overrides.id ?? "msg_1"
  return {
    info: { id, sessionID: "ses_1", role: "assistant", structured: overrides.structured, error: overrides.error },
    parts: [{ id: "p1", sessionID: "ses_1", messageID: id, type: "text", text: "raw" }],
  }
}

async function stubOpencode(responses: unknown[], options: { partUpdateStatus?: number } = {}) {
  const prompts: string[] = []
  const partUpdates: { path: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
      if (req.method === "PATCH" && path.includes("/part/")) {
        const body = (await req.json()) as Record<string, unknown>
        partUpdates.push({ path, body })
        const status = options.partUpdateStatus ?? 200
        return status === 200 ? Response.json(body) : Response.json({ error: "part update failed" }, { status })
      }
      if (!path.endsWith("/message") && !path.endsWith("/prompt_async")) {
        return Response.json({ error: "unexpected path" }, { status: 404 })
      }
      const body = (await req.json()) as { parts: { text: string }[] }
      prompts.push(body.parts.map((p) => p.text).join("\n"))
      return Response.json(responses.shift() ?? { info: {}, parts: [] })
    },
  })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, prompts, partUpdates, stop: () => server.stop(true) }
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

// Waits until an SSE stream has delivered a chunk containing `needle`
// (plan.pending arrives before plan.ready/plan.failed — accumulate until the
// target event shows up).
async function waitForSse(
  reader: { read(): Promise<{ value: Uint8Array | undefined; done: boolean | undefined }> },
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let text = ""
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
    if (text.includes(needle)) return text
  }
  return text
}

// Polls the in-memory state until `check` passes (background flows land
// asynchronously).
async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error("condition not met before timeout")
}

describe("plan flow", () => {
  test("plan prompt renders comment-origin requests with author and anchor", () => {
    const prompt = planPrompt([
      {
        id: "c1",
        text: "why is this a loop?",
        origin: "comment",
        comment: { author: "lint-bot", anchor: { round: 1, file: "a.txt", hunkIndex: 2 } },
      },
    ])
    expect(prompt).toContain("request c1 (origin: comment, author: lint-bot, round 1, file a.txt, hunk 2)")
    expect(prompt).toContain("why is this a loop?")
  })

  test("submit returns immediately and dispatches the plan in the background", async () => {
    const stub = await stubOpencode([response({ structured: validPlan })])
    const state = stateForSubmit()
    state.comments.push({
      id: "r1",
      author: "human",
      scope: "overall",
      anchor: { round: 1 },
      body: "split the loop",
      isLesson: false,
      createdAt: new Date().toISOString(),
    })
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    const stateRes = await fetch(`${base}/api/state`)
    expect(((await stateRes.json()) as { sessionLinked: boolean }).sessionLinked).toBe(true)

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
    const body = (await res.json()) as { payload: unknown; plan: Plan | null }
    expect(body.plan).toBeNull() // plan arrives via SSE, not in the response
    expect(body.payload).toEqual(state.submission?.payload)

    const chunk = await waitForSse(reader, "plan.ready")
    expect(chunk).toContain("event: plan.pending")
    expect(chunk).toContain("event: plan.ready")
    reader.releaseLock()

    await waitUntil(() => state.submission?.planning === false)
    expect(state.submission?.plan).toEqual(validPlan)
    expect(state.submission?.planning).toBe(false)
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toContain("sideye: code review fix plan")
    expect(stub.prompts[0]).toContain("split the loop")
    expect(stub.prompts[0]).toContain("origin: accepted-finding")
    expect(stub.prompts[0]).toContain("off-by-one in the loop")
    expect(stub.partUpdates).toHaveLength(1)
    expect(stub.partUpdates[0]?.path).toMatch(/^\/session\/ses_1\/message\/msg_1\/part\/prt_sideye_plan_/)
    expect(stub.partUpdates[0]?.body).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      metadata: { source: "sideye", kind: "plan" },
    })
    const tuiPlan = stub.partUpdates[0]?.body.text
    expect(tuiPlan).toContain("# Sideye fix plan")
    expect(tuiPlan).toContain("**Source:** comment by human")
    expect(tuiPlan).toContain("> split the loop")
    expect(tuiPlan).toContain("Split the loop and add a test.")
    expect(tuiPlan).toContain("- `a.txt`")
  })

  test("a TUI mirror failure does not invalidate the browser plan", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const stub = await stubOpencode([response({ structured: validPlan })], { partUpdateStatus: 500 })
      const state = stateForSubmit()
      const server = await startWithClient(state, stub.client)
      const base = `http://127.0.0.1:${server.port}`

      const res = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: JSON.stringify({ requests: ["split the loop"] }),
      })

      expect(res.status).toBe(200)
      await waitUntil(() => state.submission?.planning === false)
      expect(state.submission?.plan).toEqual(validPlan)
      expect(state.submission?.planError).toBeUndefined()
      expect(stub.partUpdates).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test("a repaired plan is mirrored onto the repair response", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] }
    const stub = await stubOpencode([
      response({ id: "msg_bad", structured: bad }),
      response({ id: "msg_repaired", structured: validPlan }),
    ])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })

    await waitUntil(() => state.submission?.planning === false)
    expect(state.submission?.plan).toEqual(validPlan)
    expect(stub.prompts).toHaveLength(2)
    expect(stub.partUpdates).toHaveLength(1)
    expect(stub.partUpdates[0]?.path).toContain("/message/msg_repaired/part/")
  })

  test("invalid plan output retries once, then fails loudly with a stored planError", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] } // wrong id type
    const stub = await stubOpencode([response({ structured: bad }), response({ structured: bad })])
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
    expect(res.status).toBe(200) // background now — the failure surfaces via state
    const chunk = await waitForSse(reader, "plan.failed")
    expect(chunk).toContain("event: plan.pending")
    expect(chunk).toContain("event: plan.failed")
    reader.releaseLock()
    expect(stub.prompts).toHaveLength(2)
    expect(stub.prompts[1]).toMatch(/failed validation/)
    expect(state.submission?.plan).toBeUndefined()
    expect(state.submission?.planning).toBe(false)
    expect(state.submission?.planError).toMatch(/invalid output twice/)
    expect(state.submission?.payload.requests).toHaveLength(2) // payload kept
  })

  test("plan retry re-dispatches after a failure and stores the plan", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] }
    const stub = await stubOpencode([
      response({ structured: bad }),
      response({ structured: bad }),
      response({ structured: validPlan }),
    ])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    await fetch(`${base}/api/findings/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ round: 1, findingId: "f1" }),
    })
    await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    await waitUntil(() => state.submission?.planError !== undefined)

    const retry = await fetch(`${base}/api/plan/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}` },
    })
    expect(retry.status).toBe(200)
    await waitUntil(() => state.submission?.plan !== undefined)
    expect(state.submission?.plan).toEqual(validPlan)
    expect(state.submission?.planError).toBeUndefined()
    expect(stub.prompts).toHaveLength(3)
  })

  test("plan retry is guarded: needs a submission and rejects when a plan exists", async () => {
    const stub = await stubOpencode([response({ structured: validPlan })])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`
    const retry = () =>
      fetch(`${base}/api/plan/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}` },
      })

    const beforeSubmit = await retry()
    expect(beforeSubmit.status).toBe(400)
    expect(((await beforeSubmit.json()) as { error: string }).error).toMatch(/nothing has been submitted/)

    await fetch(`${base}/api/findings/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ round: 1, findingId: "f1" }),
    })
    await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })
    await waitUntil(() => state.submission?.plan !== undefined)

    const afterPlan = await retry()
    expect(afterPlan.status).toBe(400)
    expect(((await afterPlan.json()) as { error: string }).error).toMatch(/already exists/)
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
    await waitUntil(() => state.submission?.plan !== undefined) // approval requires the plan
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
