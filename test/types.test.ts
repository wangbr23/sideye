import { describe, expect, test } from "bun:test"
import type {
  AppState,
  Comment,
  DiffFile,
  Hunk,
  ReviewTarget,
  Round,
} from "../src/types.ts"

const worktreeTarget: ReviewTarget = { kind: "worktree" }

const hunk: Hunk = {
  index: 0,
  header: "@@ -1,2 +1,3 @@",
  oldStart: 1,
  oldLines: 2,
  newStart: 1,
  newLines: 3,
  lines: [
    { origin: " ", content: "existing line" },
    { origin: "-", content: "old line" },
    { origin: "+", content: "new line" },
  ],
}

const file: DiffFile = {
  path: "src/index.ts",
  status: "modified",
  binary: false,
  hunks: [hunk],
}

const round: Round = {
  n: 1,
  target: worktreeTarget,
  capturedAt: "2026-09-10T00:00:00.000Z",
  files: [file],
}

const comment: Comment = {
  id: "c1",
  author: "human",
  scope: "inline",
  anchor: { round: 1, file: "src/index.ts", hunkIndex: 0, lineRange: [1, 2] },
  body: "This should handle the empty case.",
  isLesson: false,
  createdAt: "2026-09-10T00:00:00.000Z",
}

const state: AppState = {
  token: "token",
  sessionID: "ses_1",
  repoPath: "/repo",
  target: worktreeTarget,
  rounds: [round],
  comments: [comment],
  analysis: new Map(),
  analysisStatus: new Map(),
  acceptedFindings: [],
  submissions: [],
  progress: {},
  sseClients: new Set(),
  lastHeartbeat: 0,
}

describe("data model shapes", () => {
  test("round anchors comments to frozen structure indices", () => {
    expect(comment.anchor.round).toBe(round.n)
    const anchored = round.files[0]?.hunks[comment.anchor.hunkIndex ?? -1]
    expect(anchored?.index).toBe(0)
  })

  test("diff file without hunks is valid for binary/deleted cases", () => {
    const binary: DiffFile = {
      path: "img.png",
      status: "modified",
      binary: true,
      hunks: [],
    }
    expect(binary.hunks).toEqual([])
  })

  test("commit target carries a sha; worktree target does not", () => {
    const commit: ReviewTarget = { kind: "commit", sha: "abc123" }
    expect(worktreeTarget.kind).toBe("worktree")
    if (commit.kind === "commit") expect(commit.sha).toBe("abc123")
  })
})
