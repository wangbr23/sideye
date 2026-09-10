import { type Plugin, tool } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { launchReview } from "./launch.ts"
import { createSessionClient } from "./session/client.ts"
import type { ReviewTarget } from "./types.ts"

// OpenCode plugin entry (LLD §5a, HLD §3): registers the sideye_open_review
// tool. The reviewer URL is shown as a TUI toast and returned to the agent.
// The plugin context's client is the legacy SDK surface, and our session flows
// speak the v2 API — so we build our own v2 client from the plugin's serverUrl.
export const SideyePlugin: Plugin = async (input) => {
  const client = createOpencodeClient({ baseUrl: input.serverUrl.origin })
  return {
    tool: {
      sideye_open_review: tool({
        description:
          "Open a Sideye browser review: structured analysis of the current worktree diff (staged+unstaged+untracked vs HEAD) or one commit vs its first parent, with anchored comments that turn into agent work. Returns the reviewer URL.",
        args: {
          commit: tool.schema
            .string()
            .optional()
            .describe("Commit sha to review (vs its first parent; merges are rejected). Omit to review the current worktree changes."),
        },
        async execute(args, context) {
          // loud-and-early platform check (LLD §7) before any server exists
          await createSessionClient({ baseUrl: input.serverUrl.origin })
          const target: ReviewTarget =
            args.commit !== undefined && args.commit !== "" ? { kind: "commit", sha: args.commit } : { kind: "worktree" }
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
        },
      }),
    },
  }
}