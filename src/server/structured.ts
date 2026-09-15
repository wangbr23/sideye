import type { ZodType } from "zod"
import type { Part } from "../session/client.ts"

// Sideye's flows request json_schema structured output; some models answer in
// prose anyway (StructuredOutputError "Model did not produce structured
// output"), but the reply text usually still holds valid JSON wrapped in
// improvised markers or markdown fences. The real structured channel is tried
// first, then the reply text is scanned for balanced {...} regions and each
// parse is validated against the flow's schema — first valid result wins.
export interface StructuredAttempt {
  structured?: unknown
  error?: { name?: string; message?: string }
  text?: string
}

export type ParsedStructured<T> = { data: T } | { issues: string }

// Cap the scan: a reply carries at most a couple of candidate blobs, and a
// runaway reply must not spin the parser.
const MAX_JSON_REGIONS = 10

export function parseStructuredOutput<T>(attempt: StructuredAttempt, schema: ZodType<T>): ParsedStructured<T> {
  const failures: string[] = []
  if (attempt.structured !== undefined) {
    const result = schema.safeParse(attempt.structured)
    if (result.success) return { data: result.data }
    failures.push(`structured output: ${validationIssues(result.error)}`)
  } else if (attempt.error !== undefined) {
    failures.push(`${attempt.error.name ?? "error"}: ${attempt.error.message ?? "no structured output"}`)
  }
  for (const region of jsonRegions(attempt.text ?? "")) {
    let candidate: unknown
    try {
      candidate = JSON.parse(region)
    } catch {
      continue
    }
    const result = schema.safeParse(candidate)
    if (result.success) return { data: result.data }
    failures.push(`embedded JSON: ${validationIssues(result.error)}`)
  }
  return {
    issues:
      failures.length > 0
        ? [...new Set(failures)].join("; ")
        : "no structured output and no JSON in the reply text",
  }
}

function validationIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
}

// Top-level balanced {...} regions, outermost first, so prose, markdown fences,
// and improvised markers need no special-casing. String literals are skipped
// so braces inside quotes can't desync the scan, and a stray "}" outside any
// region is ignored.
function jsonRegions(text: string): string[] {
  const regions: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length && regions.length < MAX_JSON_REGIONS; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}" && depth > 0) {
      depth--
      if (depth === 0) regions.push(text.slice(start, i + 1))
    }
  }
  return regions
}

// Joined text of a reply's text parts — the model's raw prose. Doubles as the
// last-resort unparsed surface in the analysis flow.
export function replyText(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}
