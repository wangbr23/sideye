import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createState, captureRound } from "../src/server/state.ts"
import type { ReviewTarget } from "../src/types.ts"

let repoDir: string

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-state-"))
  await git("init")
  await git("config", "user.email", "test@sideye.local")
  await git("config", "user.name", "Sideye Test")
  writeFileSync(join(repoDir, "a.txt"), "one\n")
  await git("add", "a.txt")
  await git("commit", "-m", "base")
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

async function git(...args: string[]) {
  await $`git ${args}`.cwd(repoDir).quiet()
}

const worktree: ReviewTarget = { kind: "worktree" }

describe("AppState store", () => {
  test("initial state has empty rounds, comments, analysis, subscribers", () => {
    const state = createState({
      token: "tok",
      sessionID: "ses_1",
      repoPath: repoDir,
      target: worktree,
    })
    expect(state.rounds).toEqual([])
    expect(state.comments).toEqual([])
    expect(state.analysis.size).toBe(0)
    expect(state.sseClients.size).toBe(0)
    expect(state.submission).toBeUndefined()
  })

  test("round assembly merges tracked and untracked files into a frozen round", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    writeFileSync(join(repoDir, "a.txt"), "edited\n")
    writeFileSync(join(repoDir, "new.txt"), "untracked\n")

    const round = await captureRound(state)
    expect(round.n).toBe(1)
    expect(round.target).toEqual(worktree)
    expect(round.capturedAt).toBeTruthy()
    expect(round.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"])
    const untracked = round.files[1]
    expect(untracked?.status).toBe("untracked")
    expect(untracked?.hunks[0]?.lines).toEqual([{ origin: "+", content: "untracked" }])
    expect(state.rounds).toHaveLength(1)
  })

  test("second capture increments the round number", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    await captureRound(state)
    writeFileSync(join(repoDir, "b.txt"), "more\n")
    const second = await captureRound(state)
    expect(second.n).toBe(2)
    expect(state.rounds).toHaveLength(2)
  })

  test("clean worktree yields an empty round-1, which is valid", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    const round = await captureRound(state)
    expect(round.n).toBe(1)
    expect(round.files).toEqual([])
  })

  test("commit target captures the commit diff, untracked ignored", async () => {
    writeFileSync(join(repoDir, "a.txt"), "committed\n")
    await git("add", "a.txt")
    await git("commit", "-m", "second")
    const sha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()
    writeFileSync(join(repoDir, "loose.txt"), "untracked, must be ignored\n")

    const state = createState({
      token: "tok",
      sessionID: "ses_1",
      repoPath: repoDir,
      target: { kind: "commit", sha },
    })
    const round = await captureRound(state)
    expect(round.files.map((f) => f.path)).toEqual(["a.txt"])
    expect(round.files[0]?.hunks[0]?.lines).toEqual([
      { origin: "-", content: "one" },
      { origin: "+", content: "committed" },
    ])
  })

  test("merge commit target is rejected", async () => {
    await git("checkout", "-b", "feature")
    writeFileSync(join(repoDir, "feat.txt"), "feat\n")
    await git("add", "feat.txt")
    await git("commit", "-m", "feature")
    await git("checkout", "main")
    writeFileSync(join(repoDir, "main.txt"), "main\n")
    await git("add", "main.txt")
    await git("commit", "-m", "main work")
    await git("merge", "feature", "-m", "merge")
    const sha = (await $`git rev-parse HEAD`.cwd(repoDir).quiet()).text().trim()

    const state = createState({
      token: "tok",
      sessionID: "ses_1",
      repoPath: repoDir,
      target: { kind: "commit", sha },
    })
    expect(captureRound(state)).rejects.toThrow(/merge/)
  })
})