import type { AnalysisResult, AppState, Round } from "../types.ts"
import type { AssistantMessage, OpenCodeClient, Part } from "../session/client.ts"
import { promptWithTimeout, showToast } from "../session/client.ts"
import { analysisBatches, analysisJsonSchema, analysisOutputSchema, type AnalysisOutput } from "../session/schemas.ts"
import { analysisPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Thinking limit per analysis batch: a batch that exceeds this fails the round
// analysis loudly (browser retry button) and stops the agent (LLD §5b).
export const ANALYSIS_BATCH_TIMEOUT_MS = Number(process.env.SIDEYE_ANALYSIS_TIMEOUT_MS ?? 3 * 60_000)

// Analysis pipeline (LLD §5b, §7): one blocking session.prompt per batch with
// json_schema structured output. Per batch: zod validation → one repair retry
// with the validation error appended → plain-text fallback. Batch results merge
// into one AnalysisResult per round. Projected lifecycle state and SSE events
// keep the browser honest while the prompts run or if transport fails.
export async function runAnalysis(state: AppState, round: Round, client: OpenCodeClient): Promise<AnalysisResult> {
  state.analysisStatus.set(round.n, "pending")
  broadcast(state, "analysis.pending", { round: round.n })
  void showToast(client, `Analyzing the diff (round ${round.n}) — results appear in the review browser.`, "info")

  try {
    const merged: AnalysisResult = { files: [], hunks: [], findings: [] }
    const unparsed: string[] = []

    for (const batch of analysisBatches(round.files)) {
      const prompt = analysisPrompt(batch)
      const first = await promptBatch(state, client, prompt)
      const parsed = parseStructured(first.info)
      if ("data" in parsed) {
        mergeInto(merged, parsed.data)
        continue
      }
      const retry = await promptBatch(
        state,
        client,
        `${prompt}\n\nYour previous reply failed validation (${parsed.issues}). Reply again with corrected JSON matching the schema.`,
      )
      const reparsed = parseStructured(retry.info)
      if ("data" in reparsed) {
        mergeInto(merged, reparsed.data)
        continue
      }
      const fallback = fallbackText(retry.parts)
      if (fallback.trim() !== "") unparsed.push(fallback)
    }

    if (unparsed.length > 0) merged.unparsed = unparsed.join("\n\n")
    state.analysis.set(round.n, merged)
    state.analysisStatus.delete(round.n)
    broadcast(state, "analysis.update", { round: round.n })
    void showToast(
      client,
      `Analysis ready (round ${round.n}) — ${merged.files.length} files, ${merged.hunks.length} hunks, ${merged.findings.length} findings.`,
      "success",
    )
    return merged
  } catch (err) {
    state.analysisStatus.set(round.n, "failed")
    broadcast(state, "analysis.failed", { round: round.n })
    void showToast(client, `Analysis failed (round ${round.n}) — retry from the review browser.`, "error")
    throw err
  }
}

function parseStructured(info: AssistantMessage): { data: AnalysisOutput } | { issues: string } {
  if (info.error !== undefined) {
    return { issues: `${info.error.name ?? "error"}: ${describeError(info.error)}` }
  }
  const result = analysisOutputSchema.safeParse(info.structured)
  if (result.success) return { data: result.data }
  return { issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
}

function describeError(error: AssistantMessage["error"]): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  if (error && typeof error === "object" && "data" in error && error.data !== null && typeof error.data === "object") {
    return summarize(error.data)
  }
  return summarize(error)
}

async function promptBatch(state: AppState, client: OpenCodeClient, prompt: string): Promise<{ info: AssistantMessage; parts: Part[] }> {
  const data = await promptWithTimeout(client, {
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: analysisJsonSchema },
    timeoutMs: ANALYSIS_BATCH_TIMEOUT_MS,
    what: "analysis prompt",
  })
  return data
}

function mergeInto(merged: AnalysisResult, output: AnalysisOutput): void {
  merged.files.push(...output.files)
  merged.hunks.push(...output.hunks)
  merged.findings.push(...output.findings)
}

function fallbackText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function summarize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}
