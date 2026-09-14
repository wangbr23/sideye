import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { $ } from "bun"
import { SideyePlugin } from "../src/index.ts"
import { stopReview } from "../src/launch.ts"

// Plugin entry e2e: SideyePlugin initialized with a plugin-like input whose
// serverUrl points at a stub OpenCode (health + TUI toast). Executing the
// registered tool launches a real review bound to the tool context's session
// and worktree, returns the reviewer URL, and fires the toast. runTool disables
// the OS browser opener so ephemeral test servers do not leave dead tabs.
const lockPathFor = (repoPath: string) =>
  join(tmpdir(), "sideye", `${createHash("sha256").update(repoPath).digest("hex")}.json`)

let repoDir: string
let stubs: { stop(): void }[] = []

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-plugin-"))
  await $`git init`.cwd(repoDir).quiet()
  await $`git config user.email t@t`.cwd(repoDir).quiet()
  await $`git config user.name t`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "one\n")
  await $`git add a.txt`.cwd(repoDir).quiet()
  await $`git commit -m base`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "changed\n")
})

afterEach(() => {
  for (const stub of stubs) stub.stop()
  stubs = []
  stopReview(repoDir)
  rmSync(lockPathFor(repoDir), { force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

type PluginHooks = Awaited<ReturnType<typeof SideyePlugin>>
type ExecuteFn = (args: { commit?: string }, context: { sessionID: string; worktree: string }) => Promise<unknown>

// The tool context type is generated with many fields; the tool under test
// reads only sessionID and worktree, so the test context narrows to those.
async function runTool(
  hooks: PluginHooks,
  args: { commit?: string },
  context: { sessionID: string; worktree: string },
): Promise<string> {
  const registered = hooks.tool?.sideye_open_review
  if (registered === undefined) throw new Error("sideye_open_review not registered")
  const execute = registered.execute as unknown as ExecuteFn
  const previous = process.env.SIDEYE_NO_OPEN_BROWSER
  process.env.SIDEYE_NO_OPEN_BROWSER = "1"
  try {
    return (await execute(args, context)) as string
  } finally {
    if (previous === undefined) delete process.env.SIDEYE_NO_OPEN_BROWSER
    else process.env.SIDEYE_NO_OPEN_BROWSER = previous
  }
}

function pluginInput(port: number): Parameters<typeof SideyePlugin>[0] {
  return { serverUrl: new URL(`http://127.0.0.1:${port}`) } as Parameters<typeof SideyePlugin>[0]
}

describe("SideyePlugin", () => {
  test("registers sideye_open_review; executing it launches a review and fires the toast", async () => {
    const toasts: unknown[] = []
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/tui/show-toast") {
          toasts.push(await req.json().catch(() => null))
          return Response.json(true)
        }
        return Response.json({ error: "unexpected path" }, { status: 404 })
      },
    })
    stubs.push({ stop: () => stub.stop(true) })

    const hooks = await SideyePlugin(pluginInput(stub.port!))
    expect(hooks.tool?.sideye_open_review).toBeDefined()

    const result = await runTool(hooks, { commit: undefined }, { sessionID: "ses_plugin", worktree: repoDir })
    expect(result).toMatch(/^Sideye review running: http:\/\/127\.0\.0\.1:\d+\/\?reviewer=/)
    // the launch toast plus (asynchronously) the analysis toasts — the launch
    // toast itself must be present
    const launchToast = toasts.find((t) => {
      const body = t as { message?: string }
      return body.message?.includes("Review running:") ?? false
    })
    expect(launchToast).toBeDefined()

    const origin = result.replace(/^Sideye review running: /, "").replace(/\?reviewer=.*/, "")
    const state = (await (await fetch(`${origin}/api/state`)).json()) as { sessionID: string; rounds: unknown[] }
    expect(state.sessionID).toBe("ses_plugin")
    expect(state.rounds).toHaveLength(1)
  })

  test("reuses an existing review instead of forking (second tool call)", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/tui/show-toast") return Response.json(true)
        return Response.json({ error: "unexpected path" }, { status: 404 })
      },
    })
    stubs.push({ stop: () => stub.stop(true) })

    const hooks = await SideyePlugin(pluginInput(stub.port!))
    const first = await runTool(hooks, { commit: undefined }, { sessionID: "ses_plugin", worktree: repoDir })
    const second = await runTool(hooks, { commit: undefined }, { sessionID: "ses_plugin", worktree: repoDir })
    expect(second).toContain("(reused the existing review for this repo)")
    const firstUrl = first.match(/http:\/\/\S+/)?.[0]
    expect(second.match(/http:\/\/\S+/)?.[0]).toBe(firstUrl)
  })

  test("unhealthy OpenCode fails loudly before any review exists", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    })
    stubs.push({ stop: () => stub.stop(true) })

    const hooks = await SideyePlugin(pluginInput(stub.port!))
    expect(runTool(hooks, { commit: undefined }, { sessionID: "ses_plugin", worktree: repoDir })).rejects.toThrow(
      /health check failed/,
    )
    expect(existsSync(lockPathFor(repoDir))).toBe(false)
  })
})
