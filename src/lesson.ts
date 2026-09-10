import type { AppState, LessonCandidate } from "./types.ts"

// Lesson capture (LLD §7): lesson-marked comments become LessonCandidates with
// full provenance, included in the submit payload; the fix prompt instructs the
// agent to propose each via swe_factory_propose_lesson. swe-factory's presence
// is never probed — the agent reports absence in its status report.
const EXCERPT_MAX = 200

export function buildLessonCandidates(state: AppState): LessonCandidate[] {
  return state.comments
    .filter((comment) => comment.isLesson)
    .map((comment) => ({
      commentId: comment.id,
      excerpt: comment.body.length > EXCERPT_MAX ? `${comment.body.slice(0, EXCERPT_MAX)}…` : comment.body,
      provenance: {
        source: "sideye",
        repo: state.repoPath,
        target: describeTarget(state.target),
        round: comment.anchor.round,
        ...(comment.anchor.file !== undefined ? { file: comment.anchor.file } : {}),
        ...(comment.anchor.hunkIndex !== undefined ? { hunkIndex: comment.anchor.hunkIndex } : {}),
        ...(comment.anchor.lineRange !== undefined ? { lineRange: comment.anchor.lineRange } : {}),
      },
    }))
}

function describeTarget(target: AppState["target"]): string {
  return target.kind === "worktree" ? "worktree" : `commit ${target.sha}`
}