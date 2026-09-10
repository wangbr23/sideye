import type { AppState } from "../types.ts"
import type { RouteHandler } from "./http.ts"
import { sseResponse, broadcast } from "./sse.ts"
import { addComment, acceptFinding, submitReview, askQuestion } from "./state.ts"
import type { OpenCodeClient } from "../session/client.ts"

export interface RouteDependencies {
  // OpenCode session client — present in the real launch flow; the Q&A route
  // reports a loud 500 without it rather than pretending to work.
  client?: OpenCodeClient
}

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
    acceptedFindings: state.acceptedFindings,
    submission: state.submission ?? null,
  }
}

export function buildHandlers(state: AppState, deps: RouteDependencies = {}): Record<string, RouteHandler> {
  return {
    "GET /api/state": () => Response.json(projectState(state)),
    "GET /api/events": () => sseResponse(state),
    "POST /api/comments": async (req) => {
      const result = addComment(state, await parseJson(req))
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.comment)
    },
    "POST /api/findings/accept": async (req) => {
      const input = await parseJson(req)
      const result = acceptFinding(state, input)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.accepted)
    },
    "POST /api/submit": async (req) => {
      const input = await parseJson(req)
      const result = submitReview(state, input)
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
      return Response.json(result.payload)
    },
    "POST /api/questions": async (req) => {
      if (!deps.client) {
        return Response.json({ error: "OpenCode session is not linked" }, { status: 500 })
      }
      const input = await parseJson(req)
      const question = askQuestion(state, input)
      if (!question.ok) return Response.json({ error: question.error }, { status: 400 })
      const answer = await answerQuestion(deps.client, state, question.prompt)
      broadcast(state, "answer", { question: question.question, answer })
      return Response.json({ answer })
    },
  }
}

async function answerQuestion(client: OpenCodeClient, state: AppState, prompt: string): Promise<string> {
  const result = await client.session.prompt({
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
  })
  if (result.error !== undefined) {
    throw new Error(`OpenCode question prompt failed: ${summarizeError(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error("OpenCode question prompt returned no data")
  }
  const text = result.data.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (text.trim() === "") {
    throw new Error("OpenCode question prompt returned no answer text")
  }
  return text
}

function summarizeError(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined // mutators reject non-objects with a 400 and a specific error
  }
}