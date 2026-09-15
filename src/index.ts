import { type Plugin, tool } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { launchReview } from "./launch.ts"
import { createSessionClient } from "./session/client.ts"
import type { ReviewTarget } from "./types.ts"

function extractSha(raw: string): string | undefined {
  const match = raw.match(/\b([0-9a-f]{7,40})\b/i)
  return match?.[1]
}

// OpenCode plugin entry (LLD §5a, HLD §3): registers two sideye tools — one
// for worktree reviews, one for commit reviews. Split tools are more reliable
// than a single tool with an optional arg: the agent picks which tool to call
// (high reliability) instead of deciding whether to populate an optional field
// (the failure mode that prompted this split).
// The plugin context's client is the legacy SDK surface, and our session flows
// speak the v2 API — so we build our own v2 client from the plugin's serverUrl.
export const SideyePlugin: Plugin = async (input) => {
  const client = createOpencodeClient({ baseUrl: input.serverUrl.origin })

  async function launch(context: { worktree: string; sessionID: string }, target: ReviewTarget) {
    await createSessionClient({ baseUrl: input.serverUrl.origin })
    const result = await launchReview({
      repoPath: context.worktree,
      sessionID: context.sessionID,
      target,
      client,
    })
    try {
      await client.tui.showToast({
        title: "Sideye",
        message: `Review running: ${result.url}`,
        variant: result.reused ? "info" : "success",
      })
    } catch {
      // toast is best-effort — the URL still comes back to the agent
    }
    return `Sideye review running: ${result.url}${result.reused ? " (reused the existing review for this repo)" : ""}`
  }

  return {
    tool: {
      sideye_review_worktree: tool({
        description:
          "Open a Sideye browser review of the current worktree changes (staged + unstaged + untracked vs HEAD). Use when the user wants to review their uncommitted work.",
        args: {},
        async execute(_args, context) {
          return launch(context, { kind: "worktree" })
        },
      }),
      sideye_review_commit: tool({
        description:
          "Open a Sideye browser review of a specific commit (vs its first parent). Use when the user names a commit SHA or says \"most recent commit\" / \"last commit\" / \"HEAD\".",
        args: {
          sha: tool.schema
            .string()
            .describe("The commit SHA to review. Pass \"HEAD\" for the most recent commit, or the full/abbreviated SHA (e.g. \"a665a44\")."),
        },
        async execute(args, context) {
          const resolved = args.sha.trim().toUpperCase() === "HEAD"
            ? await resolveHead(context.worktree)
            : extractSha(args.sha)
          if (!resolved) {
            return `Could not find a valid commit SHA in "${args.sha}". Pass a 7-40 character hex SHA or "HEAD".`
          }
          return launch(context, { kind: "commit", sha: resolved })
        },
      }),
    },
  }
}

async function resolveHead(repoPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoPath, stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const sha = text.trim()
    return sha.length >= 7 ? sha : undefined
  } catch {
    return undefined
  }
}
