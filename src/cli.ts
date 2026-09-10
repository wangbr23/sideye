import { resolve } from "node:path"
import { captureCommitDiff } from "./git/capture.ts"
import { launchReview, stopReview } from "./launch.ts"
import { createSessionClient } from "./session/client.ts"
import { connectCliOpencode } from "./session/cli-connection.ts"
import type { ReviewTarget } from "./types.ts"

// `sideye review [commit]` — the CLI launcher (LLD §2, §5a). Thin: parse args,
// resolve repo + target, connect OpenCode, create a dedicated session, launch
// the in-process review, print the reviewer URL, and hold the process open —
// the review dies with this process by design (HLD §3, process-local).

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv[0] === "review" ? argv.slice(1) : argv
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("usage: sideye review [commit-sha] [--repo <path>]")
    return
  }
  const repoFlag = args.indexOf("--repo")
  const repoPath = resolve(repoFlag >= 0 ? (args[repoFlag + 1] ?? fail("--repo needs a path")) : process.cwd())
  const sha = args.find((arg, i) => arg !== "--repo" && args[i - 1] !== "--repo")

  const target: ReviewTarget = sha === undefined ? { kind: "worktree" } : { kind: "commit", sha }
  if (target.kind === "commit") {
    // Surface merge/invalid-sha rejection before any server or browser exists (§9)
    try {
      await captureCommitDiff(repoPath, target.sha)
    } catch (err) {
      // Bun's ShellError keeps the git stderr detail the raw message lacks
      const detail =
        err !== null && typeof err === "object" && "stderr" in err && err.stderr != null
          ? String(err.stderr).trim()
          : err instanceof Error
            ? err.message
            : String(err)
      throw new Error(`commit target rejected: ${detail}`)
    }
  }

  console.log("Connecting to OpenCode…")
  const opencode = await connectCliOpencode()
  try {
    const { client, url } = opencode
    await createSessionClient({ baseUrl: url })
    const session = await client.session.create({ title: `sideye review · ${repoPath}` })
    if (session.data === undefined) throw new Error("OpenCode session creation returned no data")

    const result = await launchReview({
      repoPath,
      sessionID: session.data.id,
      target,
      client,
    })
    console.log(`Review running: ${result.url}`)
    if (result.reused) console.log("(reusing the review already running for this repo)")
    console.log("Keep this terminal open — the review ends when it closes.")
  } catch (err) {
    opencode.stop()
    throw err
  }

  const shutdown = () => {
    stopReview(repoPath)
    opencode.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

function fail(message: string): never {
  throw new Error(message)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}