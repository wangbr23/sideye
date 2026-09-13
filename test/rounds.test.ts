import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { OpenCodeClient } from "../src/session/client.ts"
import type { AppState, Round, SubmitPayload } from "../src/types.ts"

// Round capture e2e: consent gating after the status report, round.prompt SSE,
// prior-round comments staying viewable at anchors, and background analysis of
// the new round when a session client is linked.
let repoDir: string
let stubs: { stop(): void }[] = []

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-rounds-"))
  await $`git init`.cwd(repoDir).quiet()
  await $`git config user.email t@t`.cwd(repoDir).quiet()
  await $`git config user.name t`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "one\n")
  await $`git add a.txt`.cwd(repoDir).quiet()
  await $`git commit -m base`.cwd(repoDir).quiet()
})

afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
  rmSync(repoDir, { recursive: true, force: true })
})

function stateWithReport(statuses?: [{ requestId: string; status: "addressed"; reason: string }]) {
  const state = createState({
    token: "tok",
    sessionID: "ses_1",
    repoPath: repoDir,
    target: { kind: "worktree" },
  })
  const payload: SubmitPayload = {
    requests: [{ id: "r1", text: "fix the loop", origin: "user" }],
    lessons: [],
  }
  state.submissions.push({ n: 1, round: 1, plans: [{ n: 1, payload, feedback: [], status: "ready", plan: { perRequest: [] }, createdAt: "now" }], approvedPlan: 1, ...(statuses !== undefined ? { statuses } : {}) })
  return state
}

async function startWithClient(state: AppState, client?: OpenCodeClient) {
  const server = startReviewServer({
    repoPath: repoDir,
    token: state.token,
    staticDir: "/tmp",
    handlers: buildHandlers(state, { client }),
  })
  stubs.push({ stop: () => server.stop() })
  return server
}

const consent = (server: { port: number }, state: AppState) =>
  fetch(`http://127.0.0.1:${server.port}/api/rounds`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}` },
  })

describe("POST /api/rounds", () => {
  test("gated: nothing captured before the status report", async () => {
    const state = stateWithReport(undefined)
    const server = await startWithClient(state)
    const res = await consent(server, state)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/after the fix flow/)
    expect(state.rounds).toHaveLength(0)
  })

  test("consent after statuses captures round N+1, broadcasts round.prompt, one per report", async () => {
    const state = stateWithReport([{ requestId: "r1", status: "addressed", reason: "done" }])
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n") // changed since round 1... (no round 1 yet — first consent captures round 1)
    const server = await startWithClient(state)
    const base = `http://127.0.0.1:${server.port}`

    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    await reader.read() // : connected

    const res = await consent(server, state)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { round: Round }
    expect(body.round.n).toBe(1)
    expect(state.submissions[0]?.capturedRound).toBe(1)

    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain("event: round.prompt")
    expect(chunk).toContain('"round":1')
    reader.releaseLock()

    const again = await consent(server, state)
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toMatch(/already captured/)
    expect(state.rounds).toHaveLength(1)
  })

  test("a stalled fix flow still allows consent (review stays usable, §9)", async () => {
    const state = stateWithReport(undefined)
    state.submissions[0]!.stalled = true
    const server = await startWithClient(state)
    const res = await consent(server, state)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { round: Round }).round.n).toBe(1)
  })

  test("prior-round comments stay viewable at their anchors after a new round", async () => {
    const state = stateWithReport([{ requestId: "r1", status: "addressed", reason: "done" }])
    const server = await startWithClient(state)
    const base = `http://127.0.0.1:${server.port}`

    const first = await consent(server, state)
    expect(((await first.json()) as { round: Round }).round.n).toBe(1)
    state.comments.push({
      id: "c1",
      author: "human",
      scope: "inline",
      anchor: { round: 1, file: "a.txt", hunkIndex: 0 },
      body: "round-1 anchored note",
      isLesson: false,
      createdAt: new Date().toISOString(),
    })

    // Simulate the next approved cycle's consent.
    state.submissions.push({ n: 2, round: 1, plans: [{ n: 1, payload: { requests: [{ id: "r2", text: "again", origin: "user" }], lessons: [] }, feedback: [], status: "ready", plan: { perRequest: [] }, createdAt: "now" }], approvedPlan: 1, statuses: [{ requestId: "r1", status: "addressed", reason: "done again" }] })
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n")
    const second = await consent(server, state)
    const secondBody = (await second.json()) as { round: Round }
    expect(secondBody.round.n).toBe(2)

    const projected = (await (await fetch(`${base}/api/state`)).json()) as {
      rounds: { n: number }[]
      comments: { id: string; anchor: Record<string, unknown> }[]
    }
    expect(projected.rounds.map((r) => r.n)).toEqual([1, 2])
    expect(projected.comments.map((c) => ({ id: c.id, anchor: c.anchor }))).toEqual([
      { id: "c1", anchor: { round: 1, file: "a.txt", hunkIndex: 0 } },
    ])
  })

  test("with a linked client the new round's analysis runs in the background", async () => {
    const analysisPrompts: string[] = []
    let releaseAnalysis: (() => void) | undefined
    const opencode = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path.endsWith("/prompt_async") || path.endsWith("/message")) {
          const body = await req.json().catch(() => ({ parts: [] }))
          analysisPrompts.push(((body as { parts: { text: string }[] }).parts ?? []).map((p) => p.text).join("\n"))
          releaseAnalysis?.()
          return Response.json({ info: {}, parts: [] })
        }
        return Response.json({ error: "unexpected" }, { status: 404 })
      },
    })
    stubs.push({ stop: () => opencode.stop(true) })
    const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${opencode.port}`, healthTimeoutMs: 1000 })

    const state = stateWithReport([{ requestId: "r1", status: "addressed", reason: "done" }])
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n")
    const server = await startWithClient(state, client)

    const res = await consent(server, state)
    expect(res.status).toBe(200)
    await Bun.sleep(400)
    expect(analysisPrompts.length).toBeGreaterThan(0)
    expect(analysisPrompts[0]).toContain("a.txt")
  })
})
