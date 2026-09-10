import { createOpencodeServer, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

// CLI OpenCode connection (LLD §5a, HLD §3): `sideye review` boots a dedicated
// headless server via the SDK's createOpencodeServer (spawns `opencode serve`,
// waits for its listen line), then links a client to it. This module wraps that
// so the CLI keeps a handle to shut the server down when the review ends.
export interface CliOpencode {
  client: OpencodeClient
  url: string
  stop(): void
}

export async function connectCliOpencode(): Promise<CliOpencode> {
  const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 15000 })
  const client = createOpencodeClient({ baseUrl: server.url })
  return { client, url: server.url, stop: () => server.close() }
}