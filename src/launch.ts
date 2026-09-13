import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHandlers } from "./server/routes.ts"
import { generateReviewerToken, startReviewServer, type RunningReviewServer } from "./server/http.ts"
import { runAnalysis } from "./server/analysis.ts"
import { captureRound, createState } from "./server/state.ts"
import type { AppState, ReviewTarget } from "./types.ts"
import type { OpenCodeClient } from "./session/client.ts"

// Shared launcher (LLD §4, §5a): one active review per repo per process, one
// review per repo per machine. Reuse is keyed by a 0600 lockfile carrying only
// connection metadata (no review data ever touches disk) — a second launch
// returns the existing reviewer URL when the recorded process is alive, its
// health endpoint answers, and the review target matches. A launch with a
// different target (new commit / worktree vs commit) replaces the running
// review instead: the browser page heartbeats POST /api/beacon, and a sweeper
// tears the review down (stops the server, removes the lockfile, and in CLI
// mode exits the process) once no page has beaconed within the grace window —
// closing the page ends the review, so a later launch always starts fresh.
export interface LaunchOptions {
  repoPath: string
  sessionID: string
  target: ReviewTarget
  // linked OpenCode session client — round-1 analysis, Q&A, submit/plan/fix
  // flows all prompt through it. Optional: tests launch without a session.
  client?: OpenCodeClient
  openBrowser?: boolean // default true — best-effort, failure never blocks the launch
  // how the launcher hosts the review: "cli" processes exit when the review
  // ends; "plugin" processes only stop the in-process server.
  mode?: "cli" | "plugin"
  // invoked when the review ends (heartbeat expiry, replacement, takeover).
  // Never invoked for in-process replacement — the process keeps hosting the
  // new review.
  onEnd?: () => void
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
  mode: "cli" | "plugin"
  target: ReviewTarget
  createdAt: string
}

// Sweep tuning, read per call so tests can shorten the windows: how often the
// sweeper checks and how long a review survives without a page beacon
// (browser closed / machine slept past the window). 90s of grace tolerates
// background-tab timer throttling.
const sweepIntervalMs = (): number => Number(process.env.SIDEYE_SWEEP_MS ?? 10_000)
const heartbeatGraceMs = (): number => Number(process.env.SIDEYE_HEARTBEAT_GRACE_MS ?? 90_000)

interface ActiveReview {
  server: RunningReviewServer
  state: AppState
  url: string
  onEnd?: () => void
  sweepTimer?: ReturnType<typeof setInterval>
}

const active = new Map<string, ActiveReview>()

export async function launchReview(options: LaunchOptions): Promise<LaunchResult> {
  const mode = options.mode ?? "plugin"
  const inProcess = active.get(options.repoPath)
  if (inProcess) {
    if (sameTarget(inProcess.state.target, options.target)) {
      return { url: inProcess.url, port: inProcess.server.port, reused: true }
    }
    // A different target means a different review — replace the in-process one
    // without onEnd: this process keeps hosting the new review.
    teardownReview(options.repoPath, { removeLock: true, callOnEnd: false })
  }

  const reused = await tryReuse(options.repoPath, options.target, mode)
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
  const round = await captureRound(state)

  // Round-1 analysis starts with the launch, in the background like every
  // other session flow — the Analysis/Findings tabs fill via analysis.update
  // SSE. Later rounds are analyzed by POST /api/rounds on consented capture.
  if (options.client) {
    void runAnalysis(state, round, options.client).catch((err) => {
      console.error("analysis failed for round", round.n, err)
    })
  }

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
    mode,
    target: options.target,
    createdAt: new Date().toISOString(),
  }
  writeLockfile(lock)
  active.set(options.repoPath, { server, state, url, onEnd: options.onEnd })
  startSweeper(options.repoPath)
  if (options.openBrowser !== false) openBrowserBestEffort(url)
  return { url, port: server.port, reused: false }
}

// Test/CLI teardown: stops the in-process review for a repo. The lockfile is
// intentionally left behind — the next launch treats a dead pid as stale.
export function stopReview(repoPath: string): boolean {
  const entry = active.get(repoPath)
  if (!entry) return false
  teardownReview(repoPath, { removeLock: false, callOnEnd: false })
  return true
}

function teardownReview(repoPath: string, opts: { removeLock: boolean; callOnEnd: boolean }): void {
  const entry = active.get(repoPath)
  if (entry) {
    stopSweeper(repoPath)
    entry.server.stop()
    active.delete(repoPath)
    if (opts.callOnEnd) entry.onEnd?.()
  }
  if (opts.removeLock) removeLockfile(repoPath)
}

async function tryReuse(repoPath: string, target: ReviewTarget, mode: "cli" | "plugin"): Promise<LaunchResult | undefined> {
  const lock = readLockfile(repoPath)
  if (!lock || lock.repoPath !== repoPath) {
    if (lock) removeLockfile(repoPath) // corrupt or mismatched lock — take over
    return undefined
  }
  if (!pidAlive(lock.pid) || !(await healthCheck(lock.port, repoPath))) {
    removeLockfile(repoPath)
    return undefined
  }
  if (!sameTarget(lock.target, target)) {
    // The reviewer wants a different review for this repo. A CLI-owned review
    // is a dedicated process — SIGTERM lets it shut down cleanly. A foreign
    // plugin-owned review can't be stopped from here: take over the lock and
    // let its own sweeper reap it on the next ownership check.
    if (lock.mode === "cli") await terminateGracefully(lock.pid)
    removeLockfile(repoPath)
    return undefined
  }
  return { url: reviewerUrl(lock.port, lock.reviewerToken), port: lock.port, reused: true }
}

function sameTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  if (a.kind === "worktree" || b.kind === "worktree") return a.kind === b.kind
  return a.sha === b.sha
}

// The sweeper runs once per launched review: it tears the review down when no
// open page has beaconed within the grace window, or when another launch took
// the lockfile over (pid mismatch) — the old owner quietly yields.
function startSweeper(repoPath: string): void {
  const entry = active.get(repoPath)
  if (!entry) return
  if (entry.sweepTimer !== undefined) clearInterval(entry.sweepTimer)
  entry.sweepTimer = setInterval(() => sweepOnce(repoPath), sweepIntervalMs())
}

function stopSweeper(repoPath: string): void {
  const timer = active.get(repoPath)?.sweepTimer
  if (timer !== undefined) clearInterval(timer)
}

function sweepOnce(repoPath: string): void {
  const entry = active.get(repoPath)
  if (!entry) return
  const lock = readLockfile(repoPath)
  if (lock === undefined || lock.pid !== process.pid) {
    teardownReview(repoPath, { removeLock: false, callOnEnd: true })
    return
  }
  if (Date.now() - entry.state.lastHeartbeat > heartbeatGraceMs()) {
    teardownReview(repoPath, { removeLock: true, callOnEnd: true })
  }
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

// Dedicated CLI review processes handle SIGTERM by stopping the review and
// exiting — a bounded wait for the shutdown beats racing the takeover.
async function terminateGracefully(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return // already gone — nothing to stop
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && pidAlive(pid)) {
    await Bun.sleep(50)
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