import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { createState, captureRound } from "../src/server/state.ts"
import { buildHandlers, projectState } from "../src/server/routes.ts"
import { broadcast } from "../src/server/sse.ts"
import { generateReviewerToken, startReviewServer } from "../src/server/http.ts"

let repoDir: string

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-routes-"))
  await $`git init`.cwd(repoDir).quiet()
  await $`git config user.email test@sideye.local`.cwd(repoDir).quiet()
  await $`git config user.name Sideye Test`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "one\n")
  await $`git add a.txt`.cwd(repoDir).quiet()
  await $`git commit -m base`.cwd(repoDir).quiet()
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

function startServer(state: ReturnType<typeof createState>) {
  return startReviewServer({
    repoPath: repoDir,
    token: state.token,
    staticDir: mkdtempSync(join(tmpdir(), "sideye-routes-static-")),
    handlers: buildHandlers(state),
  })
}

const base = (server: { port: number }) => `http://127.0.0.1:${server.port}`

async function readChunk(res: Response): Promise<string> {
  const body = res.body
  if (!body) throw new Error("no response body")
  const reader = body.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder().decode(value)
}

describe("GET /api/state", () => {
  test("projects rounds/comments/analysis without leaking the token", async () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    writeFileSync(join(repoDir, "a.txt"), "changed\n")
    await captureRound(state)

    const server = startServer(state)
    try {
      const res = await fetch(`${base(server)}/api/state`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(JSON.stringify(body)).not.toContain(state.token)
      expect(body.sessionID).toBe("ses_1")
      expect(body.repoPath).toBe(repoDir)
      expect(Array.isArray(body.rounds)).toBe(true)
      const rounds = body.rounds as { n: number; files: { path: string }[] }[]
      expect(rounds[0]?.n).toBe(1)
      expect(rounds[0]?.files[0]?.path).toBe("a.txt")
      expect(body.analysis).toEqual({})
      expect(body.submission).toBeNull()
    } finally {
      server.stop()
    }
  })

  test("direct projection excludes token and sseClients", () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    const projected = JSON.stringify(projectState(state))
    expect(projected).not.toContain(state.token)
    expect(projected).not.toContain("sseClients")
  })
})

describe("control-tier routes (findings/accept, submit)", () => {
  function stateWithAnalysis() {
    const state = createState({
      token: generateReviewerToken(),
      sessionID: "ses_1",
      repoPath: repoDir,
      target: { kind: "worktree" },
    })
    state.analysis.set(1, {
      files: [],
      hunks: [],
      findings: [{ id: "f1", file: "a.txt", claim: "off-by-one in the loop", citations: [] }],
    })
    return state
  }

  test("token-guarded: accept and submit serialize into the payload and state", async () => {
    const state = stateWithAnalysis()
    const server = startServer(state)
    const token = state.token
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    try {
      const accept = await fetch(`${base(server)}/api/findings/accept`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ round: 1, findingId: "f1" }),
      })
      expect(accept.status).toBe(200)
      expect(await accept.json()).toEqual([{ round: 1, findingId: "f1" }])

      const submit = await fetch(`${base(server)}/api/submit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ requests: ["split the loop"] }),
      })
      expect(submit.status).toBe(200)
      const submitBody = (await submit.json()) as {
        payload: { requests: { id: string; text: string; origin: string }[]; lessons: unknown[] }
        plan: unknown
      }
      const payload = submitBody.payload
      expect(payload.requests).toHaveLength(2)
      expect(payload.requests[1]).toEqual({
        id: expect.any(String),
        text: "off-by-one in the loop",
        origin: "accepted-finding",
      })
      expect(submitBody.plan).toBeNull() // no linked client in this fixture

      const projected = (await (await fetch(`${base(server)}/api/state`)).json()) as {
        acceptedFindings: unknown[]
        submission: { payload: unknown } | null
      }
      expect(projected.acceptedFindings).toEqual([{ round: 1, findingId: "f1" }])
      expect(projected.submission?.payload).toEqual(payload)
    } finally {
      server.stop()
    }
  })

  test("control-tier validation errors return 400 through the real server", async () => {
    const state = stateWithAnalysis()
    const server = startServer(state)
    const auth = { authorization: `Bearer ${state.token}`, "content-type": "application/json" }
    try {
      const accept = await fetch(`${base(server)}/api/findings/accept`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ round: 1, findingId: "ghost" }),
      })
      expect(accept.status).toBe(400)
      expect(((await accept.json()) as { error: string }).error).toMatch(/does not exist/)

      const submit = await fetch(`${base(server)}/api/submit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ requests: [42] }),
      })
      expect(submit.status).toBe(400)
    } finally {
      server.stop()
    }
  })
})

describe("POST /api/comments/delete", () => {
  test("token-guarded: deletes a comment and it disappears from the projection", async () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    await captureRound(state)
    const server = startServer(state)
    try {
      const post = await fetch(`${base(server)}/api/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ author: "human", scope: "overall", anchor: { round: 1 }, body: "note" }),
      })
      expect(post.status).toBe(200)
      const comment = (await post.json()) as { id: string }

      const del = await fetch(`${base(server)}/api/comments/delete`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: comment.id }),
      })
      expect(del.status).toBe(200)
      expect(await del.json()).toEqual({ deleted: comment.id })

      const projected = (await (await fetch(`${base(server)}/api/state`)).json()) as { comments: unknown[] }
      expect(projected.comments).toHaveLength(0)
    } finally {
      server.stop()
    }
  })

  test("unknown id and malformed input return 400", async () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    const server = startServer(state)
    const auth = { authorization: `Bearer ${state.token}`, "content-type": "application/json" }
    try {
      const ghost = await fetch(`${base(server)}/api/comments/delete`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ id: "ghost" }),
      })
      expect(ghost.status).toBe(400)
      expect(((await ghost.json()) as { error: string }).error).toMatch(/does not exist/)

      const badType = await fetch(`${base(server)}/api/comments/delete`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ id: 42 }),
      })
      expect(badType.status).toBe(400)

      const notJson = await fetch(`${base(server)}/api/comments/delete`, {
        method: "POST",
        headers: auth,
        body: "not json",
      })
      expect(notJson.status).toBe(400)
    } finally {
      server.stop()
    }
  })
})

describe("GET /api/events", () => {
  test("streams broadcast events to connected clients", async () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    const server = startServer(state)
    try {
      const res = await fetch(`${base(server)}/api/events`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")

      const first = await readChunk(res)
      expect(first).toContain(": connected")

      broadcast(state, "analysis.update", { round: 1 })
      const chunk = await readChunk(res)
      expect(chunk).toContain("event: analysis.update")
      expect(chunk).toContain(`data: ${JSON.stringify({ round: 1 })}`)
    } finally {
      server.stop()
    }
  })

  test("fans out to multiple clients and drops cancelled ones", async () => {
    const state = createState({ token: generateReviewerToken(), sessionID: "ses_1", repoPath: repoDir, target: { kind: "worktree" } })
    const server = startServer(state)
    try {
      const resA = await fetch(`${base(server)}/api/events`)
      const resB = await fetch(`${base(server)}/api/events`)
      await readChunk(resA)
      await readChunk(resB)
      expect(state.sseClients.size).toBe(2)

      broadcast(state, "answer", { text: "hello" })
      const aText = await readChunk(resA)
      const bText = await readChunk(resB)
      expect(aText).toContain("hello")
      expect(bText).toContain("hello")

      await resA.body?.cancel()
      broadcast(state, "answer", { text: "second" }) // must not throw on the cancelled client
      const bText2 = await readChunk(resB)
      expect(bText2).toContain("second")
      expect(state.sseClients.size).toBeLessThan(2)
    } finally {
      server.stop()
    }
  })
})