import { createOpencodeClient, type OpencodeClient, type OutputFormat } from "@opencode-ai/sdk/v2"

export type OpenCodeClient = OpencodeClient
export type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

export interface SessionClientOptions {
  baseUrl: string
  // health check budget — the loud startup check must fail fast, not hang
  healthTimeoutMs?: number
}

// Thinking limit for the analysis and plan flows (LLD §5b/§5c): each blocking
// structured-output prompt races this timeout, and on expiry the running agent
// loop is aborted so the model actually stops thinking rather than burning
// tokens past the limit. The caller turns the resulting error into its flow's
// failed state, which the browser renders with a retry action.
export async function promptWithTimeout(
  client: OpenCodeClient,
  params: { sessionID: string; parts: { type: "text"; text: string }[]; format?: OutputFormat; timeoutMs: number; what?: string },
) {
  const { sessionID, parts, format, timeoutMs, what = "prompt" } = params
  const result = await client.session.prompt({ sessionID, parts, format }, { signal: AbortSignal.timeout(timeoutMs) })
  if (result.error !== undefined) {
    // The SDK folds an aborted fetch into result.error instead of throwing;
    // Bun's TimeoutError keeps its name even though JSON.stringify loses it.
    const errorName = (result.error as { name?: string }).name
    if (errorName === "TimeoutError") {
      void client.session.abort({ sessionID }).catch(() => {})
      const minutes = Math.round(timeoutMs / 60_000)
      const limit = minutes >= 1 ? `${minutes} min` : `${Math.max(1, Math.round(timeoutMs / 1000))}s`
      throw new Error(`thinking limit reached: no response within ${limit} — the agent was stopped`, {
        cause: result.error,
      })
    }
    throw new Error(`OpenCode ${what} failed: ${summarize(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error(`OpenCode ${what} returned no data`)
  }
  return result.data
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

// Best-effort TUI toast — a clear "sideye is thinking" signal for the person
// watching the originating session. Presentation only: any failure (headless
// stub, plugin drift) is swallowed and never affects the review flow.
export async function showToast(client: OpenCodeClient, message: string, variant: "info" | "success" | "error" = "info"): Promise<void> {
  try {
    await client.tui.showToast({ title: "Sideye", message, variant })
  } catch {
    // presentation surface unavailable — nothing to do
  }
}

function summarize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}