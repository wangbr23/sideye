import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureTrackedDiff,
  captureUntrackedFiles,
  UNTRACKED_MAX_BYTES_PER_FILE,
  UNTRACKED_MAX_FILES,
} from "../src/git/capture.ts"

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
describe("captureUntrackedFiles", () => {
  test("untracked text file becomes a synthetic added-file hunk", async () => {
    writeFileSync(join(repoDir, "new.txt"), "alpha\nbeta\n")
    const files = await captureUntrackedFiles(repoDir)
    expect(files).toHaveLength(1)
    const file = files[0]
    expect(file?.path).toBe("new.txt")
    expect(file?.status).toBe("untracked")
    expect(file?.binary).toBe(false)
    expect(file?.hunks).toHaveLength(1)
    const hunk = file?.hunks[0]
    expect(hunk?.header).toBe("@@ -0,0 +1,2 @@")
    expect(hunk?.newStart).toBe(1)
    expect(hunk?.newLines).toBe(2)
    expect(hunk?.lines).toEqual([
      { origin: "+", content: "alpha" },
      { origin: "+", content: "beta" },
    ])
  })

  test("untracked file without trailing newline keeps its last line", async () => {
    writeFileSync(join(repoDir, "no-newline.txt"), "alpha\nbeta")
    const files = await captureUntrackedFiles(repoDir)
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { origin: "+", content: "alpha" },
      { origin: "+", content: "beta" },
    ])
  })

  test(".gitignore'd files are excluded", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "secret.txt\n")
    writeFileSync(join(repoDir, "secret.txt"), "hidden\n")
    const files = await captureUntrackedFiles(repoDir)
    expect(files.map((f) => f.path)).toEqual([".gitignore"])
  })

  test("file over the size cap is truncated and clipped", async () => {
    const line = "x".repeat(99) + "\n"
    writeFileSync(join(repoDir, "big.txt"), line.repeat(2000))
    const files = await captureUntrackedFiles(repoDir)
    const file = files[0]
    expect(file?.truncated).toBe(true)
    const lines = file?.hunks[0]?.lines ?? []
    expect(lines.length).toBeLessThan(2000)
    const usedBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l.content, "utf8"), 0)
    expect(usedBytes).toBeLessThanOrEqual(UNTRACKED_MAX_BYTES_PER_FILE)
    expect(lines[0]?.content).toBe("x".repeat(99))
  })

  test("more than 50 untracked files: 50 embedded, rest listed by path only", async () => {
    for (let i = 0; i < UNTRACKED_MAX_FILES + 10; i++) {
      writeFileSync(join(repoDir, `f${String(i).padStart(2, "0")}.txt`), `content ${i}\n`)
    }
    const files = await captureUntrackedFiles(repoDir)
    expect(files).toHaveLength(UNTRACKED_MAX_FILES + 10)
    const withHunks = files.filter((f) => f.hunks.length > 0)
    const pathOnly = files.filter((f) => f.hunks.length === 0)
    expect(withHunks).toHaveLength(UNTRACKED_MAX_FILES)
    expect(pathOnly).toHaveLength(10)
    for (const f of pathOnly) {
      expect(f.truncated).toBe(true)
      expect(f.binary).toBe(false)
    }
  })

  test("binary untracked file is flagged, not embedded as text", async () => {
    writeFileSync(join(repoDir, "img.png"), Buffer.from([0x89, 0x00, 0x01, 0x02]))
    const files = await captureUntrackedFiles(repoDir)
    expect(files[0]?.binary).toBe(true)
    expect(files[0]?.hunks).toEqual([])
  })

  test("empty untracked file gets a zero-line synthetic hunk", async () => {
    writeFileSync(join(repoDir, "empty.txt"), "")
    const files = await captureUntrackedFiles(repoDir)
    const hunk = files[0]?.hunks[0]
    expect(hunk?.lines).toEqual([])
    expect(hunk?.header).toBe("@@ -0,0 +1,0 @@")
  })

  test("no untracked files yields empty list", async () => {
    const files = await captureUntrackedFiles(repoDir)
    expect(files).toEqual([])
  })
})
