import { describe, expect, test, afterEach } from "bun:test"
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

function planFromPrompt(body: { parts: { text: string }[] }) {
  const text = body.parts.map((part) => part.text).join("\n")
  return response({ structured: { perRequest: [...text.matchAll(/--- request ([^ ]+) /g)].map((match) => ({ requestId: match[1]!, approach: "Split the loop and add a test.", affectedFiles: ["a.txt"] })) } })
}

function response(overrides: { id?: string; parentID?: string; structured?: unknown; error?: { name: string }; text?: string } = {}) {
  const id = overrides.id ?? "msg_1"
  return {
    info: { id, parentID: overrides.parentID ?? `msg_user_${id}`, sessionID: "ses_1", role: "assistant", structured: overrides.structured, error: overrides.error },
    parts: [{ id: "p1", sessionID: "ses_1", messageID: id, type: "text", text: overrides.text ?? "raw" }],
  }
}

async function stubOpencode(responses: (unknown | ((body: { parts: { text: string }[] }) => unknown))[], options: { partUpdateStatus?: number; delayMs?: number } = {}) {
  const prompts: string[] = []
  const partUpdates: { path: string; body: Record<string, unknown> }[] = []
  const toasts: { message?: string }[] = []
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
      if (path === "/tui/show-toast") {
        toasts.push((await req.json()) as { message?: string })
        return Response.json(true)
      }
      if (!path.endsWith("/message") && !path.endsWith("/prompt_async")) {
        return Response.json({ error: "unexpected path" }, { status: 404 })
      }
      const body = (await req.json()) as { parts: { text: string }[] }
      prompts.push(body.parts.map((p) => p.text).join("\n"))
      const next = responses.shift()
      if (options.delayMs !== undefined) await Bun.sleep(options.delayMs)
      return Response.json(typeof next === "function" ? next(body) : next ?? { info: {}, parts: [] })
    },
  })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, prompts, partUpdates, toasts, stop: () => server.stop(true) }
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
    const stub = await stubOpencode([planFromPrompt], { delayMs: 100 })
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
    expect(body.payload).toEqual(state.submissions[0]?.plans[0]?.payload)

    // planning progress is declared for the live bar and cleared once ready
    await waitUntil(() => state.progress.agent?.kind === "planning")
    expect(state.progress.agent?.phase).toContain("drafting plan v1")
    expect(state.progress.agent?.sessionID).toBe("ses_1")

    const chunk = await waitForSse(reader, "plan.ready")
    expect(chunk).toContain("event: plan.pending")
    expect(chunk).toContain("event: plan.ready")
    reader.releaseLock()

    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")
    // the record clears after the TUI mirror completes, not at plan.ready
    await waitUntil(() => state.progress.agent === undefined)
    expect(state.progress.agent).toBeUndefined()
    expect(state.submissions[0]?.plans[0]?.plan?.perRequest).toHaveLength(3)
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toContain("sideye: code review fix plan")
    expect(stub.prompts[0]).toContain("split the loop")
    expect(stub.prompts[0]).toContain("origin: accepted-finding")
    expect(stub.prompts[0]).toContain("off-by-one in the loop")
    expect(stub.partUpdates).toHaveLength(1)
    expect(stub.partUpdates[0]?.path).toMatch(/^\/session\/ses_1\/message\/msg_user_msg_1\/part\/prt_sideye_plan_/)
    expect(stub.partUpdates[0]?.body).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_user_msg_1",
      type: "text",
      ignored: true,
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
    const stub = await stubOpencode([planFromPrompt], { partUpdateStatus: 500 })
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    const res = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })

    expect(res.status).toBe(200)
    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")
    await waitUntil(() => stub.toasts.some((toast) => toast.message?.includes("could not be displayed")))
    expect(state.submissions[0]?.plans[0]?.error).toBeUndefined()
    expect(stub.partUpdates).toHaveLength(1)
  })

  test("a repaired plan is mirrored onto the repair request's user message", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] }
    const stub = await stubOpencode([
      response({ id: "msg_bad", structured: bad }),
      planFromPrompt,
    ])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })

    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")
    expect(stub.prompts).toHaveLength(2)
    expect(stub.partUpdates).toHaveLength(1)
    expect(stub.partUpdates[0]?.path).toContain("/message/msg_user_msg_1/part/")
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
    expect(state.submissions[0]?.plans[0]?.plan).toBeUndefined()
    expect(state.submissions[0]?.plans[0]?.status).toBe("failed")
    expect(state.submissions[0]?.plans[0]?.error).toMatch(/invalid output twice/)
    expect(state.submissions[0]?.plans[0]?.payload.requests).toHaveLength(2) // payload kept
  })

  test("an error reply with valid JSON embedded in the text still stores the plan", async () => {
    // request ids must match the payload exactly, so derive them from the
    // prompt the way planFromPrompt does — but return them as prose JSON
    // wrapped in a marker, the shape a non-structured-output model produces
    const embeddedFromPrompt = (body: { parts: { text: string }[] }) => {
      const text = body.parts.map((part) => part.text).join("\n")
      const plan = {
        perRequest: [...text.matchAll(/--- request ([^ ]+) /g)].map((match) => ({
          requestId: match[1]!,
          approach: "Split the loop and add a test.",
          affectedFiles: ["a.txt"],
        })),
      }
      return response({ error: { name: "StructuredOutputError" }, text: `<structured_output>${JSON.stringify(plan)}` })
    }
    const stub = await stubOpencode([embeddedFromPrompt])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: ["split the loop"] }),
    })

    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")
    expect(stub.prompts).toHaveLength(1) // no repair retry needed
    expect(state.submissions[0]?.plans[0]?.error).toBeUndefined()
    expect(state.submissions[0]?.plans[0]?.plan?.perRequest).toHaveLength(1)
  })

  test("plan retry re-dispatches after a failure and stores the plan", async () => {
    const bad = { perRequest: [{ requestId: 42, approach: "x", affectedFiles: [] }] }
    const stub = await stubOpencode([
      response({ structured: bad }),
      response({ structured: bad }),
      planFromPrompt,
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
    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "failed")

    const retry = await fetch(`${base}/api/plan/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" }, body: JSON.stringify({ cycle: 1, version: 1 }),
    })
    expect(retry.status).toBe(200)
    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")
    expect(state.submissions[0]?.plans[0]?.error).toBeUndefined()
    expect(stub.prompts).toHaveLength(3)
  })

  test("plan retry is guarded: needs a submission and rejects when a plan exists", async () => {
    const stub = await stubOpencode([planFromPrompt])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`
    const retry = () =>
      fetch(`${base}/api/plan/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" }, body: JSON.stringify({ cycle: 1, version: 1 }),
      })

    const beforeSubmit = await retry()
    expect(beforeSubmit.status).toBe(400)
    expect(((await beforeSubmit.json()) as { error: string }).error).toMatch(/does not exist/)

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
    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready")

    const afterPlan = await retry()
    expect(afterPlan.status).toBe(400)
    expect(((await afterPlan.json()) as { error: string }).error).toMatch(/only a failed/)
  })

  test("plan approval route: requires submission and plan, sets the flag once", async () => {
    const stub = await stubOpencode([planFromPrompt])
    const state = stateForSubmit()
    const server = await startWithClient(state, stub.client)
    const approve = () =>
      fetch(`http://127.0.0.1:${server.port}/api/plan/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" }, body: JSON.stringify({ cycle: 1, version: 1 }),
      })

    const beforeSubmit = await approve()
    expect(beforeSubmit.status).toBe(400)
    expect(((await beforeSubmit.json()) as { error: string }).error).toMatch(/does not exist/)

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
    await waitUntil(() => state.submissions[0]?.plans[0]?.status === "ready") // approval requires the plan
    const first = await approve()
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ approved: true, cycle: 1, version: 1 })
    expect(state.submissions[0]?.approvedPlan).toBe(1)

    const again = await approve()
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toMatch(/stale/)
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
