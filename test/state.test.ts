import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createState, captureRound, addComment, acceptFinding, submitReview } from "../src/server/state.ts"
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

describe("addComment", () => {
  // a.txt rewritten to three lines → hunk @@ -1 +1,3 @@: new-side span 1..3
  test("valid inline comment appends with generated id and createdAt", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    await captureRound(state)

    const result = addComment(state, {
      author: "human",
      scope: "inline",
      anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [2, 3] },
      body: "this looks wrong",
      isLesson: true,
    })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.comment.id).toBeTruthy()
    expect(result.comment.createdAt).toBeTruthy()
    expect(result.comment.author).toBe("human")
    expect(result.comment.scope).toBe("inline")
    expect(result.comment.anchor).toEqual({ round: 1, file: "a.txt", hunkIndex: 0, lineRange: [2, 3] })
    expect(result.comment.body).toBe("this looks wrong")
    expect(result.comment.isLesson).toBe(true)
    expect(state.comments).toEqual([result.comment])
  })

  test("comments stay anchored to their round after later captures", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    await captureRound(state)
    const result = addComment(state, {
      author: "agent",
      scope: "inline",
      anchor: { round: 1, file: "a.txt", hunkIndex: 0 },
      body: "round-1 note",
    })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)

    writeFileSync(join(repoDir, "a.txt"), "four\nfive\nsix\n")
    const second = await captureRound(state)
    expect(second.n).toBe(2)
    expect(state.comments).toHaveLength(1)
    expect(state.comments[0]?.anchor).toEqual({ round: 1, file: "a.txt", hunkIndex: 0 })
  })

  test("missing, blank, or non-string author is rejected", () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    for (const author of [undefined, "", "   ", 42, null]) {
      const result = addComment(state, {
        author,
        scope: "overall",
        anchor: { round: 1 },
        body: "x",
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/author/)
    }
    expect(state.comments).toHaveLength(0)
  })

  test("anchor validation: unknown round, scope/field mismatch, missing file or hunk", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    await captureRound(state)

    const cases: { input: unknown; error: RegExp }[] = [
      { input: { author: "a", scope: "overall", anchor: { round: 2 }, body: "x" }, error: /anchor\.round/ },
      { input: { author: "a", scope: "nope", anchor: { round: 1 }, body: "x" }, error: /scope/ },
      {
        input: { author: "a", scope: "overall", anchor: { round: 1, file: "a.txt" }, body: "x" },
        error: /overall/,
      },
      {
        input: { author: "a", scope: "file", anchor: { round: 1, file: "a.txt", hunkIndex: 0 }, body: "x" },
        error: /file-scope/,
      },
      {
        input: { author: "a", scope: "file", anchor: { round: 1, file: "missing.txt" }, body: "x" },
        error: /anchor\.file/,
      },
      {
        input: { author: "a", scope: "inline", anchor: { round: 1, file: "a.txt" }, body: "x" },
        error: /hunkIndex/,
      },
      {
        input: { author: "a", scope: "inline", anchor: { round: 1, file: "a.txt", hunkIndex: 5 }, body: "x" },
        error: /anchor\.hunkIndex/,
      },
      {
        input: { author: "a", scope: "inline", anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [2, 9] }, body: "x" },
        error: /lineRange/,
      },
      {
        input: { author: "a", scope: "inline", anchor: { round: 1, file: "a.txt", hunkIndex: 0, lineRange: [3, 2] }, body: "x" },
        error: /lineRange/,
      },
      { input: { author: "a", scope: "overall", anchor: { round: 1 } }, error: /body/ },
      { input: "not an object", error: /JSON object/ },
    ]
    for (const { input, error } of cases) {
      const result = addComment(state, input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(error)
    }
    expect(state.comments).toHaveLength(0)
  })

  test("file- and overall-scope comments anchor without hunk fields; isLesson defaults false", async () => {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\nthree\n")
    await captureRound(state)

    const fileResult = addComment(state, {
      author: "human",
      scope: "file",
      anchor: { round: 1, file: "a.txt" },
      body: "file-level note",
    })
    if (!fileResult.ok) throw new Error(`expected ok, got: ${fileResult.error}`)
    expect(fileResult.comment.anchor).toEqual({ round: 1, file: "a.txt" })
    expect(fileResult.comment.isLesson).toBe(false)

    const overallResult = addComment(state, {
      author: "lint-bot",
      scope: "overall",
      anchor: { round: 1 },
      body: "general note",
    })
    if (!overallResult.ok) throw new Error(`expected ok, got: ${overallResult.error}`)
    expect(overallResult.comment.anchor).toEqual({ round: 1 })
  })
})

describe("acceptFinding and submitReview", () => {
  const finding = { id: "f1", file: "a.txt", claim: "off-by-one in the loop", citations: [] }

  function stateWithAnalysis() {
    const state = createState({ token: "tok", sessionID: "ses_1", repoPath: repoDir, target: worktree })
    state.analysis.set(1, { files: [], hunks: [], findings: [finding] })
    return state
  }

  test("accepting a real finding records it, duplicates and unknowns rejected", () => {
    const state = stateWithAnalysis()
    const result = acceptFinding(state, { round: 1, findingId: "f1" })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.accepted).toEqual([{ round: 1, findingId: "f1" }])

    expect(acceptFinding(state, { round: 1, findingId: "f1" }).ok).toBe(false)
    expect(acceptFinding(state, { round: 1, findingId: "nope" }).ok).toBe(false)
    expect(acceptFinding(state, { round: 2, findingId: "f1" }).ok).toBe(false)
    expect(acceptFinding(state, { findingId: "f1" }).ok).toBe(false)
    expect(acceptFinding(state, "not an object").ok).toBe(false)
    expect(state.acceptedFindings).toEqual([{ round: 1, findingId: "f1" }])
  })

  test("submit serializes user requests and accepted findings, then locks", async () => {
    const state = stateWithAnalysis()
    acceptFinding(state, { round: 1, findingId: "f1" })

    const result = submitReview(state, { requests: ["split the loop", "add a test"] })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.payload.requests).toHaveLength(3)
    const [first, second, third] = result.payload.requests
    expect(first).toMatchObject({ text: "split the loop", origin: "user" })
    expect(second).toMatchObject({ text: "add a test", origin: "user" })
    expect(third).toMatchObject({ text: "off-by-one in the loop", origin: "accepted-finding" })
    expect(first?.id).toBeTruthy()
    expect(first?.id).not.toBe(second?.id)
    expect(result.payload.lessons).toEqual([])
    expect(state.submission?.payload).toEqual(result.payload)

    const again = submitReview(state, { requests: [] })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toMatch(/already exists/)
  })

  test("submit rejects malformed requests and body shapes", () => {
    const state = stateWithAnalysis()
    for (const input of [
      "not an object",
      { requests: "one" },
      { requests: [42] },
      { requests: ["ok", "   "] },
    ]) {
      expect(submitReview(state, input).ok).toBe(false)
    }
    expect(state.submission).toBeUndefined()
  })

  test("submit without accepted findings and without requests yields an empty payload", async () => {
    const state = stateWithAnalysis()
    await captureRound(state) // analysis references round 1 which now exists
    const result = submitReview(state, {})
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.payload).toEqual({ requests: [], lessons: [] })
    expect(state.submission?.payload).toEqual(result.payload)
  })
})