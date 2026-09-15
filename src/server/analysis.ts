import type { AnalysisResult, AppState, Round } from "../types.ts"
import type { AssistantMessage, OpenCodeClient, Part } from "../session/client.ts"
import { promptWithTimeout, showToast } from "../session/client.ts"
import { analysisBatches, analysisJsonSchema, analysisOutputSchema, type AnalysisOutput } from "../session/schemas.ts"
import { analysisPrompt } from "../session/prompts.ts"
import { broadcast } from "./sse.ts"

// Thinking limit per analysis batch: a batch that exceeds this fails the round
// analysis loudly (browser retry button) and stops the agent (LLD §5b). The
// default gives the model room to read context and compose findings; a slow
// batch is retryable from the browser.
export const ANALYSIS_BATCH_TIMEOUT_MS = Number(process.env.SIDEYE_ANALYSIS_TIMEOUT_MS ?? 10 * 60_000)

// Analysis runs answer purely from the quoted diff, so every tool is removed
// from the request: a model left with repo tools wanders (glob/read/bash for
// minutes) and never calls the StructuredOutput tool, ending the run with
// StructuredOutputError retries:0. Exact ids vanish from the model's request
// (llm request filter); the "*" entry is a wildcard permission deny that
// backstops any unlisted plugin/MCP tool at execution. StructuredOutput itself
// is not permission-checked. These rules are session-scoped, so analysis runs
// in a dedicated child session — the reviewer session keeps its own tools.
const ANALYSIS_TOOLS_OFF: Record<string, boolean> = {
  "*": false,
  bash: false,
  edit: false,
  glob: false,
  grep: false,
  read: false,
  write: false,
  apply_patch: false,
  task: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  question: false,
  skill: false,
  lsp: false,
  plan_exit: false,
  invalid: false,
  sideye_review_commit: false,
  sideye_review_worktree: false,
}

export function startAnalysis(state: AppState, round: Round, client: OpenCodeClient): void {
  // runAnalysis records the failure and sends a TUI toast. Do not write the
  // caught error to stdout/stderr: plugin launches share the TUI's terminal.
  void runAnalysis(state, round, client).catch(() => {})
}

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
    const analysisSession = await client.session.create({
      parentID: state.sessionID,
      title: `sideye analysis · round ${round.n}`,
    })
    const analysisSessionID = analysisSession.data?.id
    if (analysisSessionID === undefined) throw new Error("analysis session create returned no id")

    const merged: AnalysisResult = { files: [], hunks: [], findings: [] }
    const unparsed: string[] = []

    for (const batch of analysisBatches(round.files)) {
      const prompt = analysisPrompt(batch)
      const first = await promptBatch(client, analysisSessionID, prompt)
      const parsed = parseStructured(first.info)
      if ("data" in parsed) {
        mergeInto(merged, parsed.data)
        continue
      }
      const retry = await promptBatch(
        client,
        analysisSessionID,
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

async function promptBatch(client: OpenCodeClient, sessionID: string, prompt: string): Promise<{ info: AssistantMessage; parts: Part[] }> {
  const data = await promptWithTimeout(client, {
    sessionID,
    parts: [{ type: "text", text: prompt }],
    format: { type: "json_schema", schema: analysisJsonSchema },
    timeoutMs: ANALYSIS_BATCH_TIMEOUT_MS,
    what: "analysis prompt",
    tools: ANALYSIS_TOOLS_OFF,
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
