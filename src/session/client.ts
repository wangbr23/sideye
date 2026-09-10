import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpenCodeClient = OpencodeClient

export interface SessionClientOptions {
  baseUrl: string
  // health check budget — the loud startup check must fail fast, not hang
  healthTimeoutMs?: number
}

// Loud startup link to the running OpenCode instance (LLD §7): the health check
// is bounded in time and fails hard — platform drift surfaces at startup, never
// as silent degradation later. All other requests are left untimed (blocking
// prompts legitimately run for minutes).
export async function createSessionClient(options: SessionClientOptions): Promise<OpenCodeClient> {
  const { baseUrl, healthTimeoutMs = 3000 } = options
  // Bun's `typeof fetch` carries a `preconnect` property — attach a no-op so the
  // wrapper satisfies the SDK's Config.fetch signature without a cast.
  const healthAwareFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      if (!isHealthEndpoint(input)) return fetch(input, init)
      const timeout = AbortSignal.timeout(healthTimeoutMs)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      return fetch(input, { ...init, signal })
    },
    { preconnect: () => {} },
  )
  const client = createOpencodeClient({ baseUrl, fetch: healthAwareFetch })

  try {
    const result = await client.global.health()
    // SDK routes failures into `error` rather than throwing — treat both alike
    if (result.error !== undefined) throw result.error
    if (result.data?.healthy !== true) {
      throw new Error(`did not report healthy (response: ${summarize(result.data)})`)
    }
    return client
  } catch (err) {
    const reason = err instanceof Error ? err.message : summarize(err)
    throw new Error(`OpenCode health check failed at ${baseUrl}: ${reason}`, { cause: err })
  }
}

function isHealthEndpoint(input: Parameters<typeof fetch>[0]): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  return url.endsWith("/global/health")
}

function summarize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}