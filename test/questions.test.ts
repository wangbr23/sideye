import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { AppState, DiffFile, Round } from "../src/types.ts"
import type { OpenCodeClient } from "../src/session/client.ts"

const file: DiffFile = {
  path: "a.txt",
  status: "modified",
  binary: false,
  hunks: [
    {
      index: 0,
      header: "@@ -1 +1,3 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 3,
      lines: [
        { origin: " ", content: "one" },
        { origin: "+", content: "two" },
        { origin: "+", content: "three" },
      ],
    },
  ],
}

let stubs: { stop(): void }[] = []
afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
})

async function stubOpencode(answerText: string) {
  const prompts: string[] = []
  const opencode = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "stub-1.0" })
      const body = (await req.json()) as { parts: { text: string }[] }
      prompts.push(body.parts.map((p) => p.text).join("\n"))
      return Response.json({
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
        parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: answerText }],
      })
    },
  })
  stubs.push({ stop: () => opencode.stop(true) })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${opencode.port}`, healthTimeoutMs: 1000 })
  return { client, prompts }
}

function stateWithRound(): AppState {
  const state = createState({ token: "tok", sessionID: "ses_1", repoPath: "/repo", target: { kind: "worktree" } })
  const round: Round = { n: 1, target: { kind: "worktree" }, capturedAt: "2026-09-10T00:00:00.000Z", files: [file] }
  state.rounds.push(round)
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

describe("POST /api/questions", () => {
  test("answers via HTTP and SSE, quoting the question and anchor context in the prompt", async () => {
    const stub = await stubOpencode("Add a guard clause for empty input.")
    const state = stateWithRound()
    const server = await startWithClient(state, stub.client)
    const base = `http://127.0.0.1:${server.port}`

    const events = await fetch(`${base}/api/events`)
    const reader = events.body!.getReader()
    const connected = new TextDecoder().decode((await reader.read()).value)
    expect(connected).toContain(": connected")

    const res = await fetch(`${base}/api/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "human",
        question: "What happens when the file is empty?",
        anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [2, 3] },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { answer: string }
    expect(body.answer).toBe("Add a guard clause for empty input.")
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]).toContain("sideye: code review question")
    expect(stub.prompts[0]).toContain("human")
    expect(stub.prompts[0]).toContain("What happens when the file is empty?")
    expect(stub.prompts[0]).toContain("round 1")
    expect(stub.prompts[0]).toContain("+2 two")

    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain("event: answer")
    expect(chunk).toContain("guard clause")
    reader.releaseLock()
  })

  test("anchor is optional; question still reaches the session", async () => {
    const stub = await stubOpencode("yes")
    const state = stateWithRound()
    const server = await startWithClient(state, stub.client)

    const res = await fetch(`http://127.0.0.1:${server.port}/api/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "second-opinion-agent", question: "Is the approach sound?" }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { answer: string }).answer).toBe("yes")
    expect(stub.prompts[0]).toContain("Is the approach sound?")
    expect(stub.prompts[0]).not.toContain("Referenced:")
  })

  test("validation: author required, question required, bad anchors rejected", async () => {
    const stub = await stubOpencode("unused")
    const state = stateWithRound()
    const server = await startWithClient(state, stub.client)
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}/api/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })

    const noAuthor = await post({ question: "hi" })
    expect(noAuthor.status).toBe(400)
    expect(((await noAuthor.json()) as { error: string }).error).toMatch(/author/)

    const noQuestion = await post({ author: "human" })
    expect(noQuestion.status).toBe(400)

    const badHunk = await post({ author: "human", question: "hi", anchor: { round: 1, file: "a.txt", hunkIndex: 9 } })
    expect(badHunk.status).toBe(400)
    const badRound = await post({ author: "human", question: "hi", anchor: { round: 7 } })
    expect(badRound.status).toBe(400)
    const badRange = await post({
      author: "human",
      question: "hi",
      anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [9, 10] },
    })
    expect(badRange.status).toBe(400)
    expect(stub.prompts).toHaveLength(0)
  })

  test("without a linked client the route fails loudly", async () => {
    const state = stateWithRound()
    const server = await startWithClient(state, undefined)
    const res = await fetch(`http://127.0.0.1:${server.port}/api/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "human", question: "hi" }),
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/not linked/)
  })
})