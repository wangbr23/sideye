import { describe, expect, test, afterEach } from "bun:test"
import { spawn } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

// CLI e2e: `bun src/cli.ts review [sha]` boots a real OpenCode server via the
// SDK (spawns `opencode serve`), so this exercises the whole CLI flow: target
// resolve, session create, launch, reviewer URL, lockfile reuse across two CLI
// runs, and review death with the process. Requires the `opencode` binary.
const CLI = join(import.meta.dir, "..", "src", "cli.ts")
const lockPathFor = (repoPath: string) =>
  join(tmpdir(), "sideye", `${createHash("sha256").update(repoPath).digest("hex")}.json`)

let repo: string | undefined
let processes: Bun.Subprocess[] = []

afterEach(async () => {
  for (const proc of processes) {
    proc.kill("SIGTERM")
    const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)])
    if (!stopped) {
      proc.kill("SIGKILL")
      await proc.exited
    }
  }
  processes = []
  if (repo !== undefined) {
    rmSync(lockPathFor(repo), { force: true })
    rmSync(repo, { recursive: true, force: true })
    repo = undefined
  }
})

const skipWithoutOpencode = Bun.which("opencode") === null
if (skipWithoutOpencode) console.log("opencode binary not on PATH — skipping CLI e2e tests")

describe("sideye review CLI", () => {
  test.skipIf(skipWithoutOpencode)(
    "review [sha] launches, prints a reviewer URL, and dies with the process",
    async () => {
    repo = await gitRepo()
    const { sha } = await stage()
    writeFileSync(join(repo, "untracked.txt"), "untracked\n")

    const cli = start("review", sha)
    const url = await cliUrl(cli)

    const origin = url.replace(/\?reviewer=.*/, "")
    const health = (await (await fetch(`${origin}/api/health`)).json()) as { status: string }
    expect(health.status).toBe("ok")
    const state = (await (await fetch(`${origin}/api/state`)).json()) as {
      target: { kind: string; sha?: string }
      rounds: { files: { path: string }[] }[]
      sessionID: string
    }
    expect(state.target).toEqual({ kind: "commit", sha })
    expect(state.rounds[0]?.files.map((f) => f.path)).toEqual(["a.txt"])
    expect(state.sessionID).toBeTruthy()

    cli.kill("SIGTERM")
    await cli.exited
    await Bun.sleep(300)
    expect(fetch(`${origin}/api/health`)).rejects.toThrow()
  }, 30000)

  test.skipIf(skipWithoutOpencode)("second CLI run reuses the first's reviewer URL via the lockfile", async () => {
    repo = await gitRepo()
    const { sha } = await stage()

    const first = start("review", sha)
    const url = await cliUrl(first)
    const second = start("review", sha)
    const reused = await cliUrl(second)
    expect(reused).toBe(url)
  }, 30000)

  test.skipIf(skipWithoutOpencode)("invalid sha fails loudly before any server or browser exists", async () => {
    repo = await gitRepo()
    const cli = start("review", "not-a-sha")
    const [exited, stderr] = await Promise.all([cli.exited, readAll(cli.stderr)])
    expect(exited).toBe(1)
    expect(stderr).toMatch(/not-a-sha/)
  })

  test.skipIf(skipWithoutOpencode)("--help prints usage and exits clean", async () => {
    repo = await gitRepo()
    const cli = start("--help")
    const [exited, stdout] = await Promise.all([cli.exited, readAll(cli.stdout)])
    expect(exited).toBe(0)
    expect(stdout).toContain("usage:")
  })
})

function start(...args: string[]): Bun.Subprocess {
  const proc = spawn(["bun", CLI, ...args], {
    cwd: repo,
    env: { ...process.env, SIDEYE_NO_OPEN_BROWSER: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  processes.push(proc)
  return proc
}

async function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sideye-cli-"))
  await Bun.$`git init`.cwd(dir).quiet()
  await Bun.$`git config user.email t@t`.cwd(dir).quiet()
  await Bun.$`git config user.name t`.cwd(dir).quiet()
  writeFileSync(join(dir, "a.txt"), "one\n")
  await Bun.$`git add a.txt`.cwd(dir).quiet()
  await Bun.$`git commit -m base`.cwd(dir).quiet()
  return dir
}

async function stage() {
  writeFileSync(join(repo!, "a.txt"), "changed\n")
  await Bun.$`git add a.txt`.cwd(repo!).quiet()
  await Bun.$`git commit -m change`.cwd(repo!).quiet()
  const sha = (await Bun.$`git rev-parse HEAD`.cwd(repo!).quiet()).text().trim()
  return { sha }
}

function piped(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (stream !== null && typeof stream === "object") return stream
  throw new Error("subprocess stream was not piped")
}

async function readAll(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  return new Response(piped(stream)).text()
}

async function cliUrl(proc: Bun.Subprocess, timeoutMs = 30000): Promise<string> {
  const reader = piped(proc.stdout).getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (value !== undefined) text += decoder.decode(value)
    const url = text.match(/Review running: (\S+)/)
    if (url !== null) return url[1] ?? ""
    if (done) break
  }
  throw new Error(`CLI never printed a reviewer URL. Output so far: ${text}`)
}
