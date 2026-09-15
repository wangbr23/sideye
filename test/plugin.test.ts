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
// registered tools launches a real review bound to the tool context's session
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
type WorktreeExecuteFn = (args: Record<string, never>, context: { sessionID: string; worktree: string }) => Promise<unknown>
type CommitExecuteFn = (args: { sha: string }, context: { sessionID: string; worktree: string }) => Promise<unknown>

async function runWorktreeTool(
  hooks: PluginHooks,
  context: { sessionID: string; worktree: string },
): Promise<string> {
  const registered = hooks.tool?.sideye_review_worktree
  if (registered === undefined) throw new Error("sideye_review_worktree not registered")
  const execute = registered.execute as unknown as WorktreeExecuteFn
  const previous = process.env.SIDEYE_NO_OPEN_BROWSER
  process.env.SIDEYE_NO_OPEN_BROWSER = "1"
  try {
    return (await execute({} as Record<string, never>, context)) as string
  } finally {
    if (previous === undefined) delete process.env.SIDEYE_NO_OPEN_BROWSER
    else process.env.SIDEYE_NO_OPEN_BROWSER = previous
  }
}

async function runCommitTool(
  hooks: PluginHooks,
  args: { sha: string },
  context: { sessionID: string; worktree: string },
): Promise<string> {
  const registered = hooks.tool?.sideye_review_commit
  if (registered === undefined) throw new Error("sideye_review_commit not registered")
  const execute = registered.execute as unknown as CommitExecuteFn
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
  test("registers both tools; worktree tool launches a review and fires the toast", async () => {
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
    expect(hooks.tool?.sideye_review_worktree).toBeDefined()
    expect(hooks.tool?.sideye_review_commit).toBeDefined()

    const result = await runWorktreeTool(hooks, { sessionID: "ses_plugin", worktree: repoDir })
    expect(result).toMatch(/^Sideye review running: http:\/\/127\.0\.0\.1:\d+\/\?reviewer=/)
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

  test("commit tool launches a review targeting a specific commit", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/tui/show-toast") return Response.json(true)
        return Response.json({ error: "unexpected path" }, { status: 404 })
      },
    })
    stubs.push({ stop: () => stub.stop(true) })

    // commit the worktree change so we have a non-base commit to review
    await $`git add a.txt`.cwd(repoDir).quiet()
    await $`git commit -m second`.cwd(repoDir).quiet()
    const sha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

    const hooks = await SideyePlugin(pluginInput(stub.port!))
    const result = await runCommitTool(hooks, { sha }, { sessionID: "ses_plugin", worktree: repoDir })
    expect(result).toMatch(/^Sideye review running:/)

    const origin = result.replace(/^Sideye review running: /, "").replace(/\?reviewer=.*/, "")
    const state = (await (await fetch(`${origin}/api/state`)).json()) as { target: { kind: string; sha?: string }; rounds: { files: unknown[] }[] }
    expect(state.target.kind).toBe("commit")
    expect(state.target.sha).toBe(sha)
    expect(state.rounds[0]!.files.length).toBeGreaterThan(0)
  })

  test("commit tool resolves HEAD to the actual SHA", async () => {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        if (path === "/global/health") return Response.json({ healthy: true, version: "stub" })
        if (path === "/tui/show-toast") return Response.json(true)
        return Response.json({ error: "unexpected path" }, { status: 404 })
      },
    })
    stubs.push({ stop: () => stub.stop(true) })

    await $`git add a.txt`.cwd(repoDir).quiet()
    await $`git commit -m second`.cwd(repoDir).quiet()
    const sha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

    const hooks = await SideyePlugin(pluginInput(stub.port!))
    const result = await runCommitTool(hooks, { sha: "HEAD" }, { sessionID: "ses_plugin", worktree: repoDir })
    expect(result).toMatch(/^Sideye review running:/)

    const origin = result.replace(/^Sideye review running: /, "").replace(/\?reviewer=.*/, "")
    const state = (await (await fetch(`${origin}/api/state`)).json()) as { target: { kind: string; sha?: string } }
    expect(state.target.kind).toBe("commit")
    expect(state.target.sha).toBe(sha)
  })

  test("commit tool returns an error for invalid SHA", async () => {
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
    const result = await runCommitTool(hooks, { sha: "not-a-sha" }, { sessionID: "ses_plugin", worktree: repoDir })
    expect(result).toContain("Could not find a valid commit SHA")
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
    const first = await runWorktreeTool(hooks, { sessionID: "ses_plugin", worktree: repoDir })
    const second = await runWorktreeTool(hooks, { sessionID: "ses_plugin", worktree: repoDir })
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
    expect(runWorktreeTool(hooks, { sessionID: "ses_plugin", worktree: repoDir })).rejects.toThrow(
      /health check failed/,
    )
    expect(existsSync(lockPathFor(repoDir))).toBe(false)
  })
})
