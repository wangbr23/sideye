import type { AppState, DiffFile, ReviewTarget, Round } from "../types.ts"
import {
  captureCommitDiff,
  captureTrackedDiff,
  captureUntrackedFiles,
  type CapturedTrackedDiff,
} from "../git/capture.ts"
import { parseDiff } from "../git/parse.ts"

export interface AppStateInit {
  token: string
  sessionID: string
  repoPath: string
  target: ReviewTarget
}

export function createState(init: AppStateInit): AppState {
  return {
    token: init.token,
    sessionID: init.sessionID,
    repoPath: init.repoPath,
    target: init.target,
    rounds: [],
    comments: [],
    analysis: new Map(),
    sseClients: new Set(),
  }
}

export interface CapturedDiff extends CapturedTrackedDiff {
  untracked: DiffFile[]
}

export async function captureTarget(repoPath: string, target: ReviewTarget): Promise<CapturedDiff> {
  if (target.kind === "commit") {
    return { ...(await captureCommitDiff(repoPath, target.sha)), untracked: [] }
  }
  return {
    ...(await captureTrackedDiff(repoPath)),
    untracked: await captureUntrackedFiles(repoPath),
  }
}

export function parseRoundFiles(captured: CapturedDiff): DiffFile[] {
  return [...parseDiff(captured.diffText, captured.numstatText), ...captured.untracked]
}

// Capture + parse → frozen Round, appended as round N+1. A clean worktree is
// valid: the round has no files and overall comments/Q&A still work (LLD §6).
export async function captureRound(state: AppState): Promise<Round> {
  const captured = await captureTarget(state.repoPath, state.target)
  const round: Round = {
    n: state.rounds.length + 1,
    target: state.target,
    capturedAt: new Date().toISOString(),
    files: parseRoundFiles(captured),
  }
  state.rounds.push(round)
  return round
}