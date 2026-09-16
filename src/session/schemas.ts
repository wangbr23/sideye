import { z } from "zod"
import type { DiffFile } from "../types.ts"

// Small and flat per the HLD's reliability note — every field is required except
// the optional anchor fields on findings, mirroring AnalysisResult in types.ts.
const evidence = z.object({ source: z.string(), quote: z.string() })
const confidence = z.enum(["evidence", "inference"])

export const analysisOutputSchema = z.object({
  files: z.array(
    z.object({
      file: z.string(),
      purpose: z.string(),
      confidence,
      citations: z.array(evidence),
    }),
  ),
  hunks: z.array(
    z.object({
      file: z.string(),
      hunkIndex: z.number().int().nonnegative(),
      rationale: z.string(),
      confidence,
      citations: z.array(evidence),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string(),
      file: z.string().optional(),
      hunkIndex: z.number().int().nonnegative().optional(),
      claim: z.string(),
      citations: z.array(evidence),
    }),
  ),
})

export type AnalysisOutput = z.infer<typeof analysisOutputSchema>

export const analysisJsonSchema = z.toJSONSchema(analysisOutputSchema)

// Some models mimic a conventional review document when the StructuredOutput
// tool fails: file explanations contain nested hunks and findings use
// description/note plus evidence/source fields. Normalize that observed shape
// so useful analysis is not relegated to the raw fallback pane.
const nestedAnalysisFindingSchema = z.object({
  id: z.string(),
  claim: z.string().optional(),
  description: z.string().optional(),
  note: z.string().optional(),
  confidence: confidence.optional(),
  citations: z.array(evidence).optional(),
  evidence: z.array(evidence).optional(),
  source: z.string().optional(),
  quote: z.string().optional(),
}).refine((finding) => finding.claim !== undefined || finding.description !== undefined || finding.note !== undefined)

export const nestedAnalysisOutputSchema: z.ZodType<AnalysisOutput> = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      purpose: z.string(),
      confidence: confidence.optional(),
      citations: z.array(evidence).optional(),
      hunks: z.array(
        z.object({
          rationale: z.string(),
          confidence: confidence.optional(),
          citations: z.array(evidence).optional(),
        }),
      ).optional(),
    }),
  ),
  findings: z.array(nestedAnalysisFindingSchema),
}).transform((output) => ({
  files: output.files.map((file) => ({
    file: file.path,
    purpose: file.purpose,
    confidence: file.confidence ?? "inference",
    citations: file.citations ?? [],
  })),
  hunks: output.files.flatMap((file) =>
    (file.hunks ?? []).map((hunk, hunkIndex) => ({
      file: file.path,
      hunkIndex,
      rationale: hunk.rationale,
      confidence: hunk.confidence ?? "inference",
      citations: hunk.citations ?? [],
    })),
  ),
  findings: output.findings.map((finding) => ({
    id: finding.id,
    claim: finding.claim ?? finding.description ?? finding.note!,
    citations:
      finding.citations
      ?? finding.evidence
      ?? (finding.source !== undefined && finding.quote !== undefined
        ? [{ source: finding.source, quote: finding.quote }]
        : []),
  })),
}))

// Plan output (LLD §5c-2): one approach + affected files per request.
export const planOutputSchema = z.object({
  perRequest: z.array(
    z.object({
      requestId: z.string(),
      approach: z.string(),
      affectedFiles: z.array(z.string()),
    }),
  ),
})

export type PlanOutput = z.infer<typeof planOutputSchema>

export const planJsonSchema = z.toJSONSchema(planOutputSchema)

// Fix + status output (LLD §5c-3): one status per request, with the checks the
// agent ran from the project's AGENTS.md commands.
export const fixOutputSchema = z.object({
  statuses: z.array(
    z.object({
      requestId: z.string(),
      status: z.enum(["addressed", "partial", "blocked", "declined"]),
      reason: z.string(),
      checks: z.array(
        z.object({
          command: z.string(),
          passed: z.boolean(),
          summary: z.string(),
        }),
      ).optional(),
    }),
  ),
})

export type FixOutput = z.infer<typeof fixOutputSchema>

export const fixJsonSchema = z.toJSONSchema(fixOutputSchema)

// LLD §5b: batches are ≤5 files or ≤400 changed lines, whichever trips first;
// binary files are excluded entirely (binary-ish = binary or no content hunks).
export const ANALYSIS_BATCH_FILES = 5
export const ANALYSIS_BATCH_LINES = 400

export function analysisBatches(files: DiffFile[]): DiffFile[][] {
  const analyzable = files.filter((f) => !f.binary && f.hunks.length > 0)
  const batches: DiffFile[][] = []
  let current: DiffFile[] = []
  let currentLines = 0
  for (const file of analyzable) {
    const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    if (current.length > 0 && (current.length >= ANALYSIS_BATCH_FILES || currentLines + lines > ANALYSIS_BATCH_LINES)) {
      batches.push(current)
      current = []
      currentLines = 0
    }
    current.push(file)
    currentLines += lines
  }
  if (current.length > 0) batches.push(current)
  return batches
}
