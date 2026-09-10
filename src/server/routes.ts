import type { AppState } from "../types.ts"
import type { RouteHandler } from "./http.ts"
import { sseResponse } from "./sse.ts"
import { addComment } from "./state.ts"

// Open-tier state projection (LLD §4): everything the frontend and local agents
// may read. The reviewer token and the SSE client set are deliberately excluded
// — the token only ever travels in the reviewer URL.
export function projectState(state: AppState): unknown {
  return {
    sessionID: state.sessionID,
    repoPath: state.repoPath,
    target: state.target,
    rounds: state.rounds,
    comments: state.comments,
    analysis: Object.fromEntries(state.analysis),
    submission: state.submission ?? null,
  }
}

export function buildHandlers(state: AppState): Record<string, RouteHandler> {
  return {
    "GET /api/state": () => Response.json(projectState(state)),
    "GET /api/events": () => sseResponse(state),
    "POST /api/comments": async (req) => {
      let input: unknown
      try {
        input = await req.json()
      } catch {
        return Response.json({ error: "request body must be valid JSON" }, { status: 400 })
      }
      const result = addComment(state, input)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.comment)
    },
  }
}