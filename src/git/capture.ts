import { $ } from "bun"
import type { DiffFile, Hunk } from "../types.ts"
import { join } from "node:path"

export interface CapturedTrackedDiff {
  diffText: string
  numstatText: string
}

// Tracked-diff capture for the worktree target: `git diff HEAD` covers staged +
// unstaged vs HEAD in one output (LLD §6). Untracked files are captured
// separately (T10). An empty diff is valid — a clean worktree is reviewable.
export async function captureTrackedDiff(repoPath: string): Promise<CapturedTrackedDiff> {
  const diff = await $`git diff HEAD`.cwd(repoPath).quiet()
  const numstat = await $`git diff HEAD --numstat`.cwd(repoPath).quiet()
  return { diffText: diff.text(), numstatText: numstat.text() }
}

export const UNTRACKED_MAX_BYTES_PER_FILE = 100 * 1024
export const UNTRACKED_MAX_FILES = 50

const BINARY_SNIFF_BYTES = 8 * 1024

// Commit-target capture (LLD §6): diff vs first parent. Merge commits are
// rejected at launch — merge comparisons are out of scope for the MVP. A root
// commit has no parent, so it uses `git diff-tree --root` instead.
export async function captureCommitDiff(repoPath: string, sha: string): Promise<CapturedTrackedDiff> {
  const parents = (await $`git show -s --format=%P ${sha}`.cwd(repoPath).quiet())
    .text()
    .trim()
  const parentList = parents === "" ? [] : parents.split(/\s+/)

  if (parentList.length > 1) {
    throw new Error(
      `${sha} is a merge commit (${parentList.length} parents) — Sideye does not review merges; review a non-merge commit or the worktree instead`,
    )
  }
  if (parentList.length === 0) {
    const diff = await $`git diff-tree --root -r -p --format= ${sha}`.cwd(repoPath).quiet()
    const numstat = await $`git diff-tree --root -r --numstat --format= ${sha}`
      .cwd(repoPath)
      .quiet()
    return { diffText: diff.text(), numstatText: numstat.text() }
  }
  const diff = await $`git diff ${parentList[0]} ${sha}`.cwd(repoPath).quiet()
  const numstat = await $`git diff ${parentList[0]} ${sha} --numstat`.cwd(repoPath).quiet()
  return { diffText: diff.text(), numstatText: numstat.text() }
}

// Untracked-file capture for the worktree target (LLD §6): `??` entries from
// `git status --porcelain=v1 -z -uall` (respects .gitignore), each embedded as a
// synthetic added-file hunk. Caps: over 100 KiB per file → `truncated`, content
// clipped; over 50 files → the rest are listed by path only (no hunks, truncated).
// Binary files (NUL byte in the first 8 KiB) are flagged `binary: true`, no hunks.
export async function captureUntrackedFiles(repoPath: string): Promise<DiffFile[]> {
  const status = await $`git status --porcelain=v1 -z -uall`.cwd(repoPath).quiet()
  const paths = status
    .text()
    .split("\0")
    .filter((entry) => entry.startsWith("??"))
    .map((entry) => entry.slice(3))
    .filter((path) => path !== "")

  const files: DiffFile[] = []
  for (const path of paths) {
    if (files.length >= UNTRACKED_MAX_FILES) {
      files.push({ path, status: "untracked", binary: false, truncated: true, hunks: [] })
      continue
    }
    const bytes = new Uint8Array(await Bun.file(join(repoPath, path)).arrayBuffer())
    if (bytes.slice(0, BINARY_SNIFF_BYTES).includes(0)) {
      files.push({ path, status: "untracked", binary: true, hunks: [] })
      continue
    }
    files.push(syntheticAddedFile(path, new TextDecoder().decode(bytes)))
  }
  return files
}

function syntheticAddedFile(path: string, text: string): DiffFile {
  const allLines = text.split("\n")
  if (allLines.at(-1) === "") allLines.pop() // trailing newline is not a line

  const lines: { origin: "+" | "-" | " "; content: string }[] = []
  let usedBytes = 0
  let truncated = false
  for (const content of allLines) {
    const lineBytes = Buffer.byteLength(content, "utf8")
    if (usedBytes + lineBytes > UNTRACKED_MAX_BYTES_PER_FILE) {
      truncated = true
      break
    }
    lines.push({ origin: "+", content })
    usedBytes += lineBytes
  }

  const hunk: Hunk = {
    index: 0,
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines,
  }
  const file: DiffFile = {
    path,
    status: "untracked",
    binary: false,
    hunks: [hunk],
  }
  if (truncated) file.truncated = true
  return file
}