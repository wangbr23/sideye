import type { AppState } from "../types.ts"

const encoder = new TextEncoder()

// SSE channel (LLD §4): one open GET /api/events per client; the server pushes
// analysis/answer/plan/status/round events into every connected controller.
// On reconnect the client does a full GET /api/state refetch — no incremental
// sync (LLD §8), so the channel only needs fan-out.
export function sseResponse(state: AppState): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      state.sseClients.add(c)
      c.enqueue(encoder.encode(": connected\n\n"))
    },
    cancel() {
      if (controller) state.sseClients.delete(controller)
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

export function broadcast(state: AppState, event: string, data: unknown): void {
  const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  for (const client of [...state.sseClients]) {
    try {
      client.enqueue(chunk)
    } catch {
      state.sseClients.delete(client)
    }
  }
}