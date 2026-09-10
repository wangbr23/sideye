import { describe, expect, test, afterEach } from "bun:test"
import { createState } from "../src/server/state.ts"
import { buildHandlers } from "../src/server/routes.ts"
import { startReviewServer } from "../src/server/http.ts"
import { runAnalysis } from "../src/server/analysis.ts"
import { createSessionClient } from "../src/session/client.ts"
import type { AppState, DiffFile, Round } from "../src/types.ts"
import type { OpenCodeClient } from "../src/session/client.ts"

interface StubServer {
  client: OpenCodeClient
  requests: { prompt: string }[]
  stop(): void
}

// Stub OpenCode: real /global/health for the client link, then a queue of
// prompt responses served over real HTTP.
async function stubOpencode(responses: unknown[]): Promise<StubServer> {
  const requests: { prompt: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname === "/global/health") {
        return Response.json({ healthy: true, version: "stub-1.0" })
      }
      const body = (await req.json()) as { parts: { text: string }[] }
      requests.push({ prompt: body.parts.map((p) => p.text).join("\n") })
      return Response.json(responses.shift() ?? { info: {}, parts: [] })
    },
  })
  const client = await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 })
  return { client, requests, stop: () => server.stop(true) }
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

      const { value } = await reader.read()
      const chunk = new TextDecoder().decode(value)
      expect(chunk).toContain("event: analysis.update")
      expect(chunk).toContain('"round":1')
      reader.releaseLock()
    } finally {
      server.stop()
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
        if (new URL(req.url).pathname === "/global/health") return Response.json({ healthy: true, version: "stub" })
        return new Response("boom", { status: 500 })
      },
    })
    stubs.push({ client: await createSessionClient({ baseUrl: `http://127.0.0.1:${server.port}`, healthTimeoutMs: 1000 }), requests: [], stop: () => server.stop(true) })
    const { round, state } = makeRound([makeFile("a.txt")])

    expect(runAnalysis(state, round, stubs[0]!.client)).rejects.toThrow(/analysis prompt failed/)
  })
})