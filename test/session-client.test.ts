import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createSessionClient, promptWithTimeout } from "../src/session/client.ts"

let hitPaths: string[] = []

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      hitPaths.push(new URL(req.url).pathname)
      return handler(req)
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

let current: ReturnType<typeof serve>

afterEach(() => {
  current?.stop()
})

describe("createSessionClient", () => {
  test("links to a healthy server and returns a working client", async () => {
    current = serve(
      () => Response.json({ healthy: true, version: "test-1.0.0" }),
    )
    const client = await createSessionClient({ baseUrl: current.baseUrl })
    const again = await client.global.health()
    expect(again.data?.healthy).toBe(true)
    expect(again.data?.version).toBe("test-1.0.0")
    expect(hitPaths).toEqual(["/global/health", "/global/health"])
  })

  test("fails loudly when the server reports unhealthy", async () => {
    current = serve(() => Response.json({ healthy: false, version: "test-1.0.0" }))
    expect(createSessionClient({ baseUrl: current.baseUrl })).rejects.toThrow(
      /did not report healthy/,
    )
  })

  test("HTTP error from the health endpoint fails loudly", async () => {
    current = serve(() => new Response("boom", { status: 500 }))
    expect(createSessionClient({ baseUrl: current.baseUrl })).rejects.toThrow(
      new RegExp(`health check failed at ${current.baseUrl}`),
    )
  })

  test("unreachable server fails loudly and quickly", async () => {
    current = serve(async () => {
      await Bun.sleep(5000)
      return Response.json({ healthy: true })
    })
    const start = Date.now()
    expect(
      createSessionClient({ baseUrl: current.baseUrl, healthTimeoutMs: 200 }),
    ).rejects.toThrow(/health check failed/)
    // bounded: the timeout must fire long before the stub's 5s sleep ends
    await Bun.sleep(1000)
    expect(Date.now() - start).toBeLessThan(4000)
  })
})

describe("promptWithTimeout", () => {
  test("returns the prompt data on success", async () => {
    current = serve(async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" })
      return Response.json({ info: { id: "msg_1", role: "assistant" }, parts: [] })
    })
    const client = await createSessionClient({ baseUrl: current.baseUrl, healthTimeoutMs: 1000 })
    const data = await promptWithTimeout(client, {
      sessionID: "ses_1",
      parts: [{ type: "text", text: "think" }],
      timeoutMs: 5000,
    })
    expect((data as { info: { id: string } }).info.id).toBe("msg_1")
  })

  test("hitting the thinking limit stops the agent and throws a loud error", async () => {
    const aborts: string[] = []
    current = serve(async (req) => {
      const path = new URL(req.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true, version: "test" })
      if (path.endsWith("/abort")) {
        aborts.push(path)
        return Response.json({})
      }
      // the prompt never answers — only the thinking limit can unblock it
      await Bun.sleep(2000)
      return Response.json({ info: { id: "msg_1", role: "assistant" }, parts: [] })
    })
    const client = await createSessionClient({ baseUrl: current.baseUrl, healthTimeoutMs: 1000 })
    await expect(
      promptWithTimeout(client, {
        sessionID: "ses_1",
        parts: [{ type: "text", text: "think" }],
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/thinking limit reached: no response within 1s — the agent was stopped/)
    await Bun.sleep(300)
    expect(aborts.length).toBeGreaterThan(0)
  })
})