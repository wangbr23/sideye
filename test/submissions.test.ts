import { describe, expect, test } from "bun:test"
import { createState } from "../src/server/state.ts"
import { approvePlanVersion, retryPlan, revisePlan, startCycle } from "../src/server/submissions.ts"

function state() {
  const state = createState({ token: "token", sessionID: "session", repoPath: "/repo", target: { kind: "worktree" } })
  state.rounds.push({ n: 1, target: state.target, capturedAt: "now", files: [] })
  return state
}

function readyFirst(state: ReturnType<typeof createState>) {
  const started = startCycle(state, { requests: ["first"] })
  if (!started.ok) throw new Error(started.error)
  const cycle = started.value
  const first = cycle.plans[0]!
  first.status = "ready"
  first.plan = { perRequest: [{ requestId: first.payload.requests[0]!.id, approach: "do it", affectedFiles: [] }] }
  return { cycle, first }
}

describe("submission cycles", () => {
  test("revisions snapshot new comments and leave a ready base approvable after failure", () => {
    const app = state(); const { cycle, first } = readyFirst(app)
    app.comments.push({ id: "comment", author: "human", scope: "overall", anchor: { round: 1 }, body: "also this", isLesson: true, createdAt: "later" })
    const revision = revisePlan(app, { feedback: "cover the edge case" })
    expect(revision.ok).toBe(true)
    if (!revision.ok) return
    expect(revision.value.payload.requests.map((request) => request.id)).toContain("comment")
    expect(revision.value.payload.lessons.map((lesson) => lesson.commentId)).toEqual(["comment"])
    revision.value.status = "failed"
    expect(approvePlanVersion(app, { cycle: cycle.n, version: first.n }).ok).toBe(true)
    expect(cycle.approvedPlan).toBe(1)
  })

  test("retry preserves the semantic candidate and stale approval is rejected", () => {
    const app = state(); const { cycle, first } = readyFirst(app)
    first.status = "failed"; first.error = "bad output"
    const payload = structuredClone(first.payload)
    expect(retryPlan(app, { cycle: cycle.n, version: first.n }).ok).toBe(true)
    expect(first.payload).toEqual(payload)
    expect(approvePlanVersion(app, { cycle: cycle.n, version: first.n }).ok).toBe(false)
    expect(approvePlanVersion(app, { cycle: 99, version: 1 }).ok).toBe(false)
  })

  test("approved comments are not repeated in the next captured round, queued comments are", () => {
    const app = state()
    app.comments.push({ id: "approved", author: "human", scope: "overall", anchor: { round: 1 }, body: "old", isLesson: true, createdAt: "one" })
    const { cycle, first } = readyFirst(app)
    expect(approvePlanVersion(app, { cycle: cycle.n, version: first.n }).ok).toBe(true)
    cycle.statuses = []; cycle.capturedRound = 2
    app.rounds.push({ n: 2, target: app.target, capturedAt: "later", files: [] })
    app.comments.push({ id: "queued", author: "human", scope: "overall", anchor: { round: 1 }, body: "new", isLesson: true, createdAt: "two" })
    const next = startCycle(app, { requests: [] })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.plans[0]!.payload.requests.map((request) => request.id)).toEqual(["queued"])
    expect(next.value.plans[0]!.payload.lessons.map((lesson) => lesson.commentId)).toEqual(["queued"])
  })
})
