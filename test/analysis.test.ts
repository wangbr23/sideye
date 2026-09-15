import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { runAnalysis, startAnalysis } from "../src/server/analysis.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { AppState, DiffFile, Round } from "../src/types.ts"
import type { OpenCodeClient } from "../src/session/client.ts"

interface StubServer {
  client: OpenCodeClient
  requests: { prompt: string; sessionID: string; tools?: Record<string, boolean> }[]
  toasts: unknown[]
  stop(): void
}

// Stub OpenCode: real /global/health for the client link, real /session create
// for the analysis child session, then a queue of prompt responses served over
// real HTTP.
async function stubOpencode(responses: unknown[]): Promise<StubServer> {
  const requests: { prompt: string; sessionID: string; tools?: Record<string, boolean> }[] = []
  const toasts: unknown[] = []
  let created = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") {
        return Response.json({ healthy: true, version: "stub-1.0" })
      }
      if (path === "/tui/show-toast") {
        toasts.push(await req.json().catch(() => null))
        return Response.json(true)
      }
      if (path === "/session") {
        return Response.json({ id: `ses_analysis_${++created}` })
      }
      const promptMatch = path.match(/^\/session\/([^/]+)\/(message|prompt_async)$/)
      if (promptMatch) {
        const body = (await req.json()) as { parts: { text: string }[]; tools?: Record<string, boolean> }
        requests.push({ prompt: body.parts.map((p) => p.text).join("\n"), sessionID: promptMatch[1]!, tools: body.tools })
        return Response.json(responses.shift() ?? { info: {}, parts: [] })
      }
      return Response.json({ error: "unexpected path" }, { status: 404 })
    },
  })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, requests, toasts, stop: () => server.stop(true) }
}

let stubs: StubServer[] = []
async function makeStub(responses: unknown[]): Promise<StubServer> {
  const stub = await stubOpencode(responses)
  stubs.push(stub)
  return stub
}
afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
})

const validOutput = {
  files: [
    { file: "a.txt", purpose: "changes the greeting", confidence: "evidence", citations: [{ source: "a.txt", quote: "hi" }] },
  ],
  hunks: [{ file: "a.txt", hunkIndex: 0, rationale: "reworded", confidence: "inference", citations: [] }],
  findings: [{ id: "f1", file: "a.txt", hunkIndex: 0, claim: "greeting lost its i18n", citations: [] }],
}

function response(overrides: {
  structured?: unknown
  text?: string
  error?: { name: string; data?: { message: string; retries: number } }
} = {}) {
  return {
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      structured: overrides.structured,
      error: overrides.error,
    },
    parts: [
      {
        id: "p1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: overrides.text ?? "raw model output",
      },
    ],
  }
}

function makeFile(path: string, lineCount = 1, binary = false): DiffFile {
  return {
    path,
    status: "modified",
    binary,
    hunks: binary
      ? []
      : [
          {
            index: 0,
            header: "@@ -1 +1,1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: lineCount,
            lines: Array.from({ length: lineCount }, (_, i) => ({ origin: "+" as const, content: `line ${i}` })),
          },
        ],
  }
}

function makeRound(files: DiffFile[]): { round: Round; state: AppState } {
  const state = createState({ token: "tok", sessionID: "ses_1", repoPath: "/repo", target: { kind: "worktree" } })
  const round: Round = { n: 1, target: { kind: "worktree" }, capturedAt: "2026-09-10T00:00:00.000Z", files }
  state.rounds.push(round)
  return { round, state }
}

describe("runAnalysis", () => {
  test("valid structured output merges into state and broadcasts analysis.update", async () => {
    const stub = await makeStub([response({ structured: validOutput })])
    const { round, state } = makeRound([makeFile("a.txt")])
    const server = startReviewServer({ repoPath: "/repo", token: "tok", staticDir: "/tmp", handlers: buildHandlers(state) })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`)
      const reader = res.body!.getReader()
      const connected = new TextDecoder().decode((await reader.read()).value)
      expect(connected).toContain(": connected")

      const result = await runAnalysis(state, round, stub.client)

      expect(result.files[0]?.purpose).toBe("changes the greeting")
      expect(result.hunks[0]?.rationale).toBe("reworded")
      expect(result.findings[0]?.claim).toBe("greeting lost its i18n")
      expect(result.unparsed).toBeUndefined()
      expect(state.analysis.get(1)).toEqual(result)
      expect(state.analysisStatus.has(1)).toBe(false)

      const { value } = await reader.read()
      const chunk = new TextDecoder().decode(value)
      expect(chunk).toContain("event: analysis.pending")
      const { value: updateValue } = await reader.read()
      const updateChunk = new TextDecoder().decode(updateValue)
      expect(updateChunk).toContain("event: analysis.update")
      expect(updateChunk).toContain('"round":1')
      reader.releaseLock()
    } finally {
      server.stop()
    }
  })

  test("prompts run in a dedicated child session with every tool denied", async () => {
    const stub = await makeStub([response({ structured: validOutput })])
    const { round, state } = makeRound([makeFile("a.txt")])

    await runAnalysis(state, round, stub.client)

    expect(stub.requests.length).toBeGreaterThan(0)
    for (const req of stub.requests) {
      expect(req.sessionID).toBe("ses_analysis_1")
      expect(req.sessionID).not.toBe(state.sessionID)
      expect(req.tools?.["*"]).toBe(false)
      expect(req.tools?.read).toBe(false)
      expect(req.tools?.bash).toBe(false)
      expect(req.tools?.glob).toBe(false)
      expect(req.tools?.sideye_review_commit).toBe(false)
    }
  })

  test("invalid structured output retries once with the validation issues appended", async () => {
    const bad = { files: [{ file: "a.txt", purpose: "x", confidence: "confident", citations: [] }] } // bad confidence
    const stub = await makeStub([response({ structured: bad }), response({ structured: validOutput })])
    const { round, state } = makeRound([makeFile("a.txt")])

    const result = await runAnalysis(state, round, stub.client)

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[1]?.prompt).toMatch(/failed validation/)
    expect(stub.requests[1]?.prompt).toMatch(/confidence/)
    expect(result.hunks[0]?.rationale).toBe("reworded")
    expect(result.unparsed).toBeUndefined()
  })

  test("invalid twice falls back to the raw text in the unparsed field", async () => {
    const stub = await makeStub([
      response({ structured: { nonsense: true }, text: "first bad output" }),
      response({ structured: { still: "bad" }, text: "second bad output" }),
    ])
    const { round, state } = makeRound([makeFile("a.txt")])

    const result = await runAnalysis(state, round, stub.client)

    expect(stub.requests).toHaveLength(2)
    expect(result.files).toEqual([])
    expect(result.unparsed).toBe("second bad output")
    expect(state.analysis.get(1)?.unparsed).toBe("second bad output")
  })

  test("invalid output without fallback text does not store whitespace-only unparsed analysis", async () => {
    const stub = await makeStub([
      response({ structured: { nonsense: true }, text: " " }),
      response({ structured: { still: "bad" }, text: "\n\n" }),
    ])
    const { round, state } = makeRound([makeFile("a.txt")])

    const result = await runAnalysis(state, round, stub.client)

    expect(result.unparsed).toBeUndefined()
    expect(state.analysis.get(1)?.unparsed).toBeUndefined()
  })

  test("info.error (StructuredOutputError) takes the same retry path", async () => {
    const stub = await makeStub([
      response({ error: { name: "StructuredOutputError", data: { message: "schema mismatch", retries: 2 } } }),
      response({ structured: validOutput }),
    ])
    const { round, state } = makeRound([makeFile("a.txt")])

    const result = await runAnalysis(state, round, stub.client)

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[1]?.prompt).toMatch(/schema mismatch/)
    expect(result.findings[0]?.claim).toBe("greeting lost its i18n")
  })

  test("batches cap at 5 files or 400 lines; binary files are excluded", async () => {
    const stub = await makeStub([
      response({ structured: validOutput }),
      response({ structured: validOutput }),
      response({ structured: validOutput }),
    ])
    const { round, state } = makeRound([
      makeFile("f1.txt", 10),
      makeFile("f2.txt", 10),
      makeFile("f3.txt", 10),
      makeFile("f4.txt", 10),
      makeFile("f5.txt", 10),
      makeFile("f6.txt", 10),
      makeFile("binary.png", 0, true),
    ])

    await runAnalysis(state, round, stub.client)

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[0]?.prompt).toContain("f5.txt")
    expect(stub.requests[0]?.prompt).not.toContain("f6.txt")
    expect(stub.requests[1]?.prompt).toContain("f6.txt")
    for (const req of stub.requests) expect(req.prompt).not.toContain("binary.png")
  })

  test("large files split by the 400-line cap", async () => {
    const stub = await makeStub([response({ structured: validOutput }), response({ structured: validOutput })])
    const { round, state } = makeRound([makeFile("big1.txt", 300), makeFile("big2.txt", 300)])

    await runAnalysis(state, round, stub.client)

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[0]?.prompt).toContain("big1.txt")
    expect(stub.requests[1]?.prompt).toContain("big2.txt")
  })

  test("transport-level failure propagates loudly", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/session") return Response.json({ id: "ses_analysis" })
        return new Response("boom", { status: 500 })
      },
    })
    stubs.push({ client: await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 }), requests: [], toasts: [], stop: () => server.stop(true) })
    const { round, state } = makeRound([makeFile("a.txt")])

    await expect(runAnalysis(state, round, stubs[0]!.client)).rejects.toThrow(/analysis prompt failed/)
    expect(state.analysisStatus.get(1)).toBe("failed")
  })

  test("background analysis contains failures after updating state", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/session") return Response.json({ id: "ses_analysis" })
        return new Response("boom", { status: 500 })
      },
    })
    const stub = {
      client: await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 }),
      requests: [],
      toasts: [],
      stop: () => server.stop(true),
    }
    stubs.push(stub)
    const { round, state } = makeRound([makeFile("a.txt")])

    startAnalysis(state, round, stub.client)
    for (let i = 0; i < 50 && state.analysisStatus.get(1) !== "failed"; i++) await Bun.sleep(10)

    expect(state.analysisStatus.get(1)).toBe("failed")
  })
})
