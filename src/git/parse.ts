import type { DiffFile, Hunk } from "../types.ts"

// Unified-diff parser (LLD §6): raw `git diff` text + numstat text → DiffFile[].
// Binary detection: numstat rows with `-` counts mark the file binary; the diff
// body's `Binary files ... differ` line is kept as a belt-and-braces fallback.
// Rename detection relies on git's default rename output; the file path is the
// new (b/) side. Hunks store content as-is; one trailing \r is stripped so CRLF
// diffs don't leak carriage returns into rendered lines.
export function parseDiff(diffText: string, numstatText: string): DiffFile[] {
  const binaryPaths = collectBinaryPaths(numstatText)
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let currentHunk: Hunk | null = null

  const flush = () => {
    if (current) files.push(current)
    current = null
    currentHunk = null
  }

  for (const raw of diffText.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw

    if (line.startsWith("diff --git ")) {
      flush()
      // `a/<old> b/<new>`; split on the last " b/" so paths containing " b/" lose
      // only their prefix, and unusual renames still parse
      const sep = line.lastIndexOf(" b/")
      const m = /^diff --git a\/(.*)$/.exec(line)
      if (!m || m[1] === undefined || sep === -1) continue
      const newPath = line.slice(sep + 3)
      current = { path: newPath, status: "modified", binary: false, hunks: [] }
      continue
    }

    if (current !== null && currentHunk !== null) {
      if (line.startsWith("\\ No newline at end of file")) continue
      const origin = line[0]
      if (origin === "+" || origin === "-" || origin === " ") {
        currentHunk.lines.push({ origin, content: line.slice(1) })
        continue
      }
      if (origin !== undefined) {
        currentHunk = null // anything else ends the hunk
      }
    }

    if (current === null) continue
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m || m[1] === undefined || m[3] === undefined) continue
      currentHunk = {
        index: current.hunks.length,
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      }
      current.hunks.push(currentHunk)
    } else if (line.startsWith("new file mode")) {
      current.status = "added"
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted"
    } else if (line.startsWith("rename from")) {
      current.status = "renamed"
    } else if (line.startsWith("Binary files ")) {
      current.binary = true
    }
  }

  flush()
  for (const file of files) {
    if (binaryPaths.has(file.path)) file.binary = true
  }
  return files
}

function collectBinaryPaths(numstatText: string): Set<string> {
  const binary = new Set<string>()
  for (const line of numstatText.split("\n")) {
    if (line === "") continue
    const cols = line.split("\t")
    if (cols.length < 3 || cols[0] === undefined || cols[1] === undefined) continue
    if (cols[0] === "-" && cols[1] === "-") {
      binary.add(numstatNewPath(cols.slice(2).join("\t")))
    }
  }
  return binary
}

// numstat renders renames as `old => new`, possibly with a shared brace span
// like `a/{b => c}/d`; extract the new path
function numstatNewPath(raw: string): string {
  const m = /^(.*)\{([^}]*) => ([^}]*)\}(.*)$/.exec(raw)
  if (m && m[1] !== undefined && m[3] !== undefined && m[4] !== undefined) {
    return m[1] + m[3] + m[4]
  }
  const arrow = raw.indexOf(" => ")
  return arrow === -1 ? raw : raw.slice(arrow + 4)
}