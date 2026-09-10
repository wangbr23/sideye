import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { $ } from "bun"
import { launchReview, stopReview, type LaunchResult } from "../src/launch.ts"

let repoDir: string
let scratchDir: string

const lockPathFor = (repoPath: string) =>
  join(tmpdir(), "sideye", `${createHash("sha256").update(repoPath).digest("hex")}.json`)

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-launch-"))
  scratchDir = mkdtempSync(join(tmpdir(), "sideye-launch-scratch-"))
  await $`git init`.cwd(repoDir).quiet()
  await $`git config user.email test@sideye.local`.cwd(repoDir).quiet()
  await $`git config user.name Sideye Test`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "one\n")
  await $`git add a.txt`.cwd(repoDir).quiet()
  await $`git commit -m base`.cwd(repoDir).quiet()
  writeFileSync(join(repoDir, "a.txt"), "changed\n")
})

afterEach(() => {
  stopReview(repoDir)
  rmSync(lockPathFor(repoDir), { force: true })
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(scratchDir, { recursive: true, force: true })
})

function launch() {
  return launchReview({
    repoPath: repoDir,
    sessionID: "ses_launch",
    target: { kind: "worktree" },
    openBrowser: false,
  })
}

describe("launchReview", () => {
  test("fresh launch: reviewer URL, captured round 1, 0600 metadata-only lockfile", async () => {
    const result = await launch()
    expect(result.reused).toBe(false)
    expect(result.port).toBeGreaterThan(0)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?reviewer=[A-Za-z0-9_-]+$/)

    const health = await fetch(`http://127.0.0.1:${result.port}/api/health`)
    expect(await health.json()).toMatchObject({ status: "ok", repoPath: repoDir })

    const state = (await (await fetch(`http://127.0.0.1:${result.port}/api/state`)).json()) as {
      rounds: { n: number; files: unknown[] }[]
    }
    expect(state.rounds).toHaveLength(1)
    expect(state.rounds[0]?.files.length).toBeGreaterThan(0)

    const lockFile = lockPathFor(repoDir)
    expect(existsSync(lockFile)).toBe(true)
    expect(statSync(lockFile).mode & 0o777).toBe(0o600)
    const lock = JSON.parse(await Bun.file(lockFile).text()) as Record<string, unknown>
    expect(Object.keys(lock).sort()).toEqual(["createdAt", "pid", "port", "repoPath", "reviewerToken"])
    expect(lock.repoPath).toBe(repoDir)
    expect(lock.port).toBe(result.port)
    expect(lock.pid).toBe(process.pid)
    expect(String(result.url)).toContain(`reviewer=${lock.reviewerToken}`)
  })

  test("second launch in the same process returns the existing URL", async () => {
    const first = await launch()
    const second = await launch()
    expect(second.reused).toBe(true)
    expect(second.url).toBe(first.url)
    expect(second.port).toBe(first.port)
  })

  test("reuses another process's review while its pid is alive and healthy", async () => {
    const childScript = join(scratchDir, "child.ts")
    const childResult = join(scratchDir, "child-result.json")
    writeFileSync(
      childScript,
      `import { launchReview } from ${JSON.stringify(join(import.meta.dir, "..", "src", "launch.ts"))}
const repo = process.argv[2]
const out = process.argv[3]
const result = await launchReview({ repoPath: repo, sessionID: "child-session", target: { kind: "worktree" }, openBrowser: false })
await Bun.write(out, JSON.stringify(result))
setInterval(() => {}, 1000)`,
    )
    const child = Bun.spawn(["bun", childScript, repoDir, childResult], {
      stdout: "ignore",
      stderr: "inherit",
    })
    try {
      const childLaunch = await pollJson(childResult)
      const mine = await launch()
      expect(mine.reused).toBe(true)
      expect(mine.url).toBe((childLaunch as LaunchResult).url)
    } finally {
      child.kill()
    }
  })

  test("dead pid in the lockfile is stale — a fresh review takes over", async () => {
    const childScript = join(scratchDir, "child.ts")
    const childResult = join(scratchDir, "child-result.json")
    writeFileSync(
      childScript,
      `import { launchReview } from ${JSON.stringify(join(import.meta.dir, "..", "src", "launch.ts"))}
const result = await launchReview({ repoPath: process.argv[2], sessionID: "child-session", target: { kind: "worktree" }, openBrowser: false })
await Bun.write(process.argv[3], JSON.stringify(result))
setInterval(() => {}, 1000)`,
    )
    const child = Bun.spawn(["bun", childScript, repoDir, childResult], {
      stdout: "ignore",
      stderr: "inherit",
    })
    await pollJson(childResult)
    child.kill()
    await child.exited // .exitCode stays null in Bun 1.4 — .exited is the reliable signal
    // Wait for the pid to actually die before expecting a takeover.

    const mine = await launch()
    expect(mine.reused).toBe(false)
    const health = await fetch(`http://127.0.0.1:${mine.port}/api/health`)
    expect(await health.json()).toMatchObject({ status: "ok", repoPath: repoDir })
  })

  test("alive pid but dead port fails the health check — takeover", async () => {
    writeFileSync(
      lockPathFor(repoDir),
      JSON.stringify({
        repoPath: repoDir,
        port: 1, // nothing listens on port 1
        reviewerToken: "from-a-crafted-lock",
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )
    const result = await launch()
    expect(result.reused).toBe(false)
    expect(result.url).not.toContain("from-a-crafted-lock")
  })

  test("corrupt lockfile is removed and taken over", async () => {
    writeFileSync(lockPathFor(repoDir), "not json at all", { mode: 0o600 })
    const result = await launch()
    expect(result.reused).toBe(false)
    const lock = JSON.parse(await Bun.file(lockPathFor(repoDir)).text())
    expect(lock.pid).toBe(process.pid)
  })
})

async function pollJson(path: string, timeoutMs = 5000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = await Bun.file(path).text()
      if (text.startsWith("{")) return JSON.parse(text)
    }
    await Bun.sleep(50)
  }
  throw new Error(`child never wrote ${path}`)
}