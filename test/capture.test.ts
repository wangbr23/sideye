import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureTrackedDiff } from "../src/git/capture.ts"

let repoDir: string

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "sideye-capture-"))
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

describe("captureTrackedDiff", () => {
  test("clean worktree yields empty diff and numstat", async () => {
    const captured = await captureTrackedDiff(repoDir)
    expect(captured.diffText).toBe("")
    expect(captured.numstatText).toBe("")
  })

  test("unstaged modification appears as one hunk", async () => {
    writeFileSync(join(repoDir, "a.txt"), "one\ntwo\n")
    const captured = await captureTrackedDiff(repoDir)
    expect(captured.diffText).toContain("+two")
    expect(captured.diffText).toContain("@@")
    expect(captured.numstatText).toContain("a.txt")
  })

  test("staged modification is covered without unstaged changes", async () => {
    writeFileSync(join(repoDir, "a.txt"), "replaced\n")
    await git("add", "a.txt")
    const captured = await captureTrackedDiff(repoDir)
    expect(captured.diffText).toContain("-one")
    expect(captured.diffText).toContain("+replaced")
  })

  test("staged and unstaged edits to the same file both appear", async () => {
    writeFileSync(join(repoDir, "a.txt"), "staged\n")
    await git("add", "a.txt")
    writeFileSync(join(repoDir, "a.txt"), "staged\nunstaged\n")
    const captured = await captureTrackedDiff(repoDir)
    expect(captured.diffText).toContain("+staged")
    expect(captured.diffText).toContain("+unstaged")
  })

  test("untracked files are not included (T10 captures those)", async () => {
    writeFileSync(join(repoDir, "new.txt"), "untracked\n")
    const captured = await captureTrackedDiff(repoDir)
    expect(captured.diffText).toBe("")
    expect(captured.numstatText).toBe("")
  })

  test("non-repo directory throws", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "sideye-nongit-"))
    try {
      expect(captureTrackedDiff(nonRepo)).rejects.toThrow()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})