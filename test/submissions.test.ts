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

  test("pre-submit comments do not carry to the next round, post-submit comments do", () => {
    const app = state()
    // Pre-submit comment — posted before round 1's submit
    app.comments.push({ id: "pre-submit", author: "human", scope: "overall", anchor: { round: 1 }, body: "old", isLesson: true, createdAt: "one" })
    const { cycle, first } = readyFirst(app)
    expect(approvePlanVersion(app, { cycle: cycle.n, version: first.n }).ok).toBe(true)
    cycle.statuses = []; cycle.capturedRound = 2
    app.rounds.push({ n: 2, target: app.target, capturedAt: "later", files: [] })
    // Post-submit comment — posted after round 1's cycle was created
    app.comments.push({ id: "post-submit", author: "human", scope: "overall", anchor: { round: 1 }, body: "new feedback", isLesson: true, createdAt: "two" })
    const next = startCycle(app, { requests: [] })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.plans[0]!.payload.requests.map((request) => request.id)).toEqual(["post-submit"])
    expect(next.value.plans[0]!.payload.lessons.map((lesson) => lesson.commentId)).toEqual(["post-submit"])
  })

  test("comments in a non-approved plan version are still excluded from the next round", () => {
    const app = state()
    // Comment enters plan v1's payload at submit time
    app.comments.push({ id: "in-v1", author: "human", scope: "overall", anchor: { round: 1 }, body: "fix this", isLesson: false, createdAt: "one" })
    const { cycle, first } = readyFirst(app)
    // Revise — v2 also picks up the same comment
    const revision = revisePlan(app, { feedback: "different approach" })
    expect(revision.ok).toBe(true)
    if (!revision.ok) return
    revision.value.status = "ready"
    revision.value.plan = { perRequest: [
      { requestId: first.payload.requests[0]!.id, approach: "revised", affectedFiles: [] },
      { requestId: "in-v1", approach: "revised", affectedFiles: [] },
    ] }
    // Approve v2
    expect(approvePlanVersion(app, { cycle: cycle.n, version: revision.value.n }).ok).toBe(true)
    cycle.statuses = []; cycle.capturedRound = 2
    app.rounds.push({ n: 2, target: app.target, capturedAt: "later", files: [] })
    // The comment was in both v1 and v2 — it must not appear in round 2
    const next = startCycle(app, { requests: ["new work"] })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.value.plans[0]!.payload.requests.some((r) => r.id === "in-v1")).toBe(false)
  })

  test("stalled cycle still excludes its pre-submit comments", () => {
    const app = state()
    app.comments.push({ id: "pre-stall", author: "human", scope: "overall", anchor: { round: 1 }, body: "old", isLesson: false, createdAt: "one" })
    const started = startCycle(app, { requests: ["fix it"] })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const cycle = started.value
    // Stall without approving
    cycle.stalled = true
    cycle.capturedRound = 2
    app.rounds.push({ n: 2, target: app.target, capturedAt: "later", files: [] })
    // Post-stall comment
    app.comments.push({ id: "post-stall", author: "human", scope: "overall", anchor: { round: 2 }, body: "new", isLesson: false, createdAt: "two" })
    const next = startCycle(app, { requests: [] })
    expect(next.ok).toBe(true)
    if (!next.ok) return
    const ids = next.value.plans[0]!.payload.requests.map((r) => r.id)
    expect(ids).not.toContain("pre-stall")
    expect(ids).toContain("post-stall")
  })
})
