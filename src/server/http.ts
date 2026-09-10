import { randomBytes, timingSafeEqual } from "node:crypto"
import { join } from "node:path"

export type RouteHandler = (req: Request, url: URL) => Promise<Response> | Response

const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
}

// Control tier (LLD §4): these routes move the review forward and require the
// per-launch reviewer token; everything else is the open tier
export const CONTROL_ROUTE_PATHS: readonly string[] = [
  "/api/findings/accept",
  "/api/submit",
  "/api/plan/approve",
  "/api/rounds",
]

export interface ReviewServerOptions {
  repoPath: string
  token: string
  staticDir: string
  // keyed by "METHOD /path"; later tasks fill these in
  handlers: Record<string, RouteHandler>
}

export interface RunningReviewServer {
  port: number
  stop(): void
}

export function generateReviewerToken(): string {
  return randomBytes(32).toString("base64url")
}

export function startReviewServer(options: ReviewServerOptions): RunningReviewServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => handleRequest(req, options),
  })
  const { port } = server
  if (port === undefined) throw new Error("server did not report its port")
  return { port, stop: () => server.stop(true) }
}

async function handleRequest(req: Request, options: ReviewServerOptions): Promise<Response> {
  const url = new URL(req.url)
  try {
    if (url.pathname === "/api/health") {
      return Response.json({ status: "ok", repoPath: options.repoPath })
    }

    if (CONTROL_ROUTE_PATHS.includes(url.pathname)) {
      if (!isReviewer(req, options.token)) {
        return Response.json({ error: "reviewer token required" }, { status: 401 })
      }
      const handler = options.handlers[`${req.method} ${url.pathname}`]
      if (!handler) return Response.json({ error: "not found" }, { status: 404 })
      return await handler(req, url)
    }

    const staticFile = STATIC_FILES[url.pathname]
    if (staticFile !== undefined) {
      const file = Bun.file(join(options.staticDir, staticFile))
      if (await file.exists()) return new Response(file)
    }
    return Response.json({ error: "not found" }, { status: 404 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}

function isReviewer(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  const a = Buffer.from(presented)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}