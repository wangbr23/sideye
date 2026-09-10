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