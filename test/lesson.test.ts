import { describe, expect, test } from "bun:test"
import { createState, submitReview, deleteComment } from "../src/server/state.ts"
import { buildLessonCandidates } from "../src/lesson.ts"
import { fixPrompt } from "../src/session/prompts.ts"
import type { AppState } from "../src/types.ts"

// Lesson capture plumbing (LLD §7): lesson-marked comments → LessonCandidates
// with provenance in the submit payload; the fix prompt instructs proposing
// each via swe_factory_propose_lesson, with the degrade instruction.

function stateWithLessons(): AppState {
  const state = createState({
    token: "tok",
    sessionID: "ses_1",
    repoPath: "/repo",
    target: { kind: "commit", sha: "abc123" },
  })
  state.comments.push(
    {
      id: "c1",
      author: "human",
      scope: "inline",
      anchor: { round: 1, file: "a.txt", hunkIndex: 2, lineRange: [3, 4] },
      body: "This is the lesson-worthy insight: prefer explicit state machines over sentinel flags.",
      isLesson: true,
      createdAt: "2026-09-10T00:00:00.000Z",
    },
    {
      id: "c2",
      author: "human",
      scope: "overall",
      anchor: { round: 1 },
      body: "plain comment, not a lesson",
      isLesson: false,
      createdAt: "2026-09-10T00:00:01.000Z",
    },
  )
  return state
}

describe("buildLessonCandidates", () => {
  test("lesson-marked comments become candidates with full provenance", () => {
    const state = stateWithLessons()
    const candidates = buildLessonCandidates(state)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual({
      commentId: "c1",
      excerpt: "This is the lesson-worthy insight: prefer explicit state machines over sentinel flags.",
      provenance: {
        source: "sideye",
        repo: "/repo",
        target: "commit abc123",
        round: 1,
        file: "a.txt",
        hunkIndex: 2,
        lineRange: [3, 4],
      },
    })
  })

  test("long bodies are truncated in the excerpt", () => {
    const state = createState({ token: "t", sessionID: "s", repoPath: "/r", target: { kind: "worktree" } })
    state.comments.push({
      id: "c1",
      author: "human",
      scope: "overall",
      anchor: { round: 1 },
      body: "x".repeat(500),
      isLesson: true,
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    const [candidate] = buildLessonCandidates(state)
    expect(candidate?.excerpt.length).toBe(201) // 200 chars + ellipsis
    expect(candidate?.excerpt.endsWith("…")).toBe(true)
    expect(candidate?.provenance.target).toBe("worktree")
  })
})

describe("submit payload lessons", () => {
  test("submit serializes lesson candidates; every comment also joins as a request", () => {
    const state = stateWithLessons()
    const result = submitReview(state, { requests: ["apply the insight"] })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.payload.lessons).toEqual(buildLessonCandidates(state))
    expect(result.payload.lessons).toHaveLength(1)
    expect(state.comments).toHaveLength(2)
    const commentRequests = result.payload.requests.filter((r) => r.origin === "comment")
    expect(commentRequests).toHaveLength(2)
    expect(commentRequests.map((r) => r.id)).toEqual(["c1", "c2"])
    expect(commentRequests[0]).toMatchObject({ text: state.comments[0]?.body, comment: { author: "human" } })
  })

  test("submit without lesson-marked comments carries an empty lessons array", () => {
    const state = createState({ token: "t", sessionID: "s", repoPath: "/r", target: { kind: "worktree" } })
    const result = submitReview(state, { requests: ["x"] })
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.payload.lessons).toEqual([])
  })

  test("deleting a lesson-marked comment pre-submit keeps it out of the payload", () => {
    const state = stateWithLessons()
    const deleted = deleteComment(state, { id: "c1" })
    if (!deleted.ok) throw new Error(`expected ok, got: ${deleted.error}`)
    const result = submitReview(state, {})
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`)
    expect(result.payload.lessons).toEqual([])
  })
})

describe("fix prompt lessons", () => {
  test("lesson candidates appear with the propose instruction and degrade note", () => {
    const prompt = fixPrompt({
      requests: [{ id: "r1", text: "apply the insight", origin: "user" }],
      plan: { perRequest: [{ requestId: "r1", approach: "refactor", affectedFiles: ["a.txt"] }] },
      lessons: [
        {
          excerpt: "prefer explicit state machines",
          provenance: { round: 1, file: "a.txt", hunkIndex: 2 },
        },
      ],
    })
    expect(prompt).toContain("Lessons captured by the reviewer")
    expect(prompt).toContain("prefer explicit state machines")
    expect(prompt).toContain("swe_factory_propose_lesson")
    expect(prompt).toContain("If that tool is not available")
    expect(prompt).toContain("round 1, file a.txt, hunk 2")
  })

  test("no lessons → no lesson block in the prompt", () => {
    const prompt = fixPrompt({
      requests: [{ id: "r1", text: "x", origin: "user" }],
      plan: { perRequest: [] },
    })
    expect(prompt).not.toContain("Lessons captured")
    expect(prompt).not.toContain("swe_factory_propose_lesson")
  })
})