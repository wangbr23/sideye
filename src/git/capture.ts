import { $ } from "bun"

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