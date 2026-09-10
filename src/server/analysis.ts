import type { AnalysisResult, AppState, Round } from "../types.ts"
import type { AssistantMessage, OpenCodeClient, Part } from "../session/client.ts"
import { analysisBatches, analysisJsonSchema, analysisOutputSchema, type AnalysisOutput } from "../session/schemas.ts"
import { analysisPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Analysis pipeline (LLD §5b, §7): one blocking session.prompt per batch with
// json_schema structured output. Per batch: zod validation → one repair retry
// with the validation error appended → plain-text fallback. Batch results merge
// into one AnalysisResult per round; every batch lands as an `analysis.update`
// SSE event, then the merged result is stored. Transport-level failures
// propagate — platform drift fails loudly, never silently.
export async function runAnalysis(state: AppState, round: Round, client: OpenCodeClient): Promise<AnalysisResult> {
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
    unparsed.push(fallbackText(retry.parts))
  }

  if (unparsed.length > 0) merged.unparsed = unparsed.join("\n\n")
  state.analysis.set(round.n, merged)
  broadcast(state, "analysis.update", { round: round.n })
  return merged
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
  const result = await client.session.prompt({
    sessionID: state.sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: analysisJsonSchema },
  })
  if (result.error !== undefined) {
    throw new Error(`OpenCode analysis prompt failed: ${summarize(result.error)}`)
  }
  if (result.data === undefined) {
    throw new Error("OpenCode analysis prompt returned no data")
  }
  return result.data
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