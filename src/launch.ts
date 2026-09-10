import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHandlers } from "./server/routes.ts"
import { generateReviewerToken, startReviewServer, type RunningReviewServer } from "./server/http.ts"
import { captureRound, createState } from "./server/state.ts"
import type { OpenCodeClient } from "./session/client.ts"
import type { ReviewTarget } from "./types.ts"

// Shared launcher (LLD §4, §5a): one active review per repo per process, one
// review per repo per machine. Reuse is keyed by a 0600 lockfile carrying only
// connection metadata (no review data ever touches disk) — a second launch
// returns the existing reviewer URL when the recorded process is alive and its
// health endpoint answers; stale locks are removed and taken over.
export interface LaunchOptions {
  repoPath: string
  sessionID: string
  target: ReviewTarget
  // linked OpenCode session client — the Q&A route needs it; analysis (T19)
  // callers hold their own reference. Optional until T8/T24 wire their flows.
  client?: OpenCodeClient
  openBrowser?: boolean // default true — best-effort, failure never blocks the launch
}

export interface LaunchResult {
  url: string // reviewer URL — the token travels only in this URL (LLD §4)
  port: number
  reused: boolean
}

interface Lockfile {
  repoPath: string
  port: number
  reviewerToken: string
  pid: number
  createdAt: string
}

const active = new Map<string, { server: RunningReviewServer; url: string }>()

export async function launchReview(options: LaunchOptions): Promise<LaunchResult> {
  const inProcess = active.get(options.repoPath)
  if (inProcess) return { url: inProcess.url, port: inProcess.server.port, reused: true }

  const reused = await tryReuse(options.repoPath)
  if (reused) return reused

  const token = generateReviewerToken()
  const state = createState({
    token,
    sessionID: options.sessionID,
    repoPath: options.repoPath,
    target: options.target,
  })
  // Round 1 is captured here so capture failures (merge target, bad sha)
  // surface at launch with a clear error (§9) instead of a round-less review.
  await captureRound(state)

  const server = startReviewServer({
    repoPath: options.repoPath,
    token,
    staticDir: join(import.meta.dir, "..", "frontend"),
    handlers: buildHandlers(state, { client: options.client }),
  })
  const url = reviewerUrl(server.port, token)
  const lock: Lockfile = {
    repoPath: options.repoPath,
    port: server.port,
    reviewerToken: token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }
  writeLockfile(lock)
  active.set(options.repoPath, { server, url })
  if (options.openBrowser !== false) openBrowserBestEffort(url)
  return { url, port: server.port, reused: false }
}

// Test/CLI teardown: stops the in-process review for a repo. The lockfile is
// intentionally left behind — the next launch treats a dead pid as stale.
export function stopReview(repoPath: string): boolean {
  const entry = active.get(repoPath)
  if (!entry) return false
  entry.server.stop()
  active.delete(repoPath)
  return true
}

async function tryReuse(repoPath: string): Promise<LaunchResult | undefined> {
  const lock = readLockfile(repoPath)
  if (!lock || lock.repoPath !== repoPath) {
    if (lock) removeLockfile(repoPath) // corrupt or mismatched lock — take over
    return undefined
  }
  if (!pidAlive(lock.pid) || !(await healthCheck(lock.port, repoPath))) {
    removeLockfile(repoPath)
    return undefined
  }
  return { url: reviewerUrl(lock.port, lock.reviewerToken), port: lock.port, reused: true }
}

function lockPath(repoPath: string): string {
  const hash = createHash("sha256").update(repoPath).digest("hex")
  return join(tmpdir(), "sideye", `${hash}.json`)
}

function readLockfile(repoPath: string): Lockfile | undefined {
  try {
    return JSON.parse(readFileSync(lockPath(repoPath), "utf8")) as Lockfile
  } catch {
    return undefined
  }
}

function writeLockfile(lock: Lockfile): void {
  const dir = join(tmpdir(), "sideye")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(lockPath(lock.repoPath), JSON.stringify(lock), { mode: 0o600 })
}

function removeLockfile(repoPath: string): void {
  try {
    rmSync(lockPath(repoPath))
  } catch {
    // already gone — nothing to clean
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function healthCheck(port: number, repoPath: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string; repoPath?: string }
    return body.status === "ok" && body.repoPath === repoPath
  } catch {
    return false
  }
}

function reviewerUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?reviewer=${token}`
}

function openBrowserBestEffort(url: string): void {
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" })
  } catch {
    // best-effort — the URL is still returned to the caller
  }
}