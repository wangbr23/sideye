# Sideye

An OpenCode plugin that provides a browser-based code review platform: structured analysis of your diff, anchored comments, an explicit request→plan→fix→status loop with your agent session, and lesson capture into opencode-swe-factory.

## Requirements

- [Bun](https://bun.sh)
- [OpenCode](https://opencode.ai) on your PATH (both launch paths talk to a running OpenCode)
- A git repository (worktree reviews need commits; merge commits are rejected as review targets)

## Install

From source — the only path today, the package is not yet on npm (tracked as T27 in TODO.md):

```sh
git clone <this repo> && cd sideye
bun install
```

Once published, third-party install will be:

```sh
# plugin: add to opencode.json
{ "plugin": ["<package-name>"] }

# slash command: copy from the installed package
cp node_modules/<package-name>/command/sideye.md .opencode/command/sideye.md

# or CLI-only, no opencode config needed
bunx <package-name> review
```

## How it works

Sideye is a Bun package with three surfaces over one in-process review server:

- **Entry points** — the `sideye review` CLI (boots a dedicated headless OpenCode if none is running) or the plugin's `sideye_open_review` tool (binds to the calling TUI session). Both capture the diff — worktree changes vs HEAD, or one commit vs its first parent — parse it into files and hunks, and start a loopback `Bun.serve` server holding all state in memory.
- **Browser frontend** — served by that server; renders the diff per round with the analysis panel (per-file purposes, per-hunk rationales, evidence-cited findings), three comment scopes, Q&A, and the submit/plan/fix/status handoff. Live updates over SSE.
- **OpenCode session** — the analysis, Q&A, plan, and fix prompts all run through the session that launched the review, so the reviewer and the agent share context.

State is process-local by design: the review dies with its launcher, and a lockfile in `$TMPDIR/sideye/` lets a second launch return the running review's URL instead of starting a new one.

## Launch path 1 — CLI

```sh
bun src/cli.ts review            # review worktree changes (staged + unstaged + untracked vs HEAD)
bun src/cli.ts review <sha>      # review one commit vs its first parent
bun src/cli.ts review <sha> --repo /path/to/repo
```

The CLI connects to OpenCode (booting a dedicated headless server if none is running), creates a dedicated review session, starts the review server in-process, opens your browser, and prints the reviewer URL:

```
Review running: http://127.0.0.1:<port>/?reviewer=<token>
```

Keep the terminal open — the review lives in that process and ends when it exits.
Set `SIDEYE_NO_OPEN_BROWSER=1` to print the reviewer URL without opening it automatically, such as in headless or automated runs.

## Launch path 2 — OpenCode plugin

1. Copy the slash-command template into your project (or `~/.config/opencode/command/` for global):

   ```sh
   cp sideye/command/sideye.md <your-project>/.opencode/command/sideye.md
   ```

2. Register the plugin. Once published to npm, add it to your `opencode.json`:

   ```json
   { "plugin": ["sideye"] }
   ```

   For local development, symlink the plugin entry into the project's plugin directory (module imports resolve through the symlink to the clone, where `bun install` has run):

   ```sh
   mkdir -p <your-project>/.opencode/plugins
   ln -s /absolute/path/to/sideye/src/index.ts <your-project>/.opencode/plugins/sideye.ts
   ```

3. In the OpenCode TUI, run `/sideye` (or `/sideye <sha>`). The agent calls the `sideye_open_review` tool, which starts the review bound to the current session and shows the reviewer URL as a TUI toast.

## The review loop

- **Read**: the diff renders per round with per-file purposes, per-hunk rationales, and evidence-cited findings (labels distinguish evidence from inference).
- **Comment**: click a diff line (inline), a file header (file scope), or the header button (overall). Mark a comment as a lesson to feed swe-factory later. Other local agents can comment too — attribution over auth.
- **Ask**: the Comments tab has an ask box — questions route to the agent session with anchor context and come back immediately.
- **Submit**: the header Submit button hands explicit requests (plus accepted findings and lesson-marked comments) to the agent: it drafts a fix plan, you approve it, it edits with a per-request status report and check results, then you can consent to a fresh round.

## Second opinions from other agents (experimental)

The read/comment surface is intentionally open to local agents: `GET /api/state`, `GET /api/events` (SSE), `POST /api/comments` and `POST /api/questions` with a required `author` field and no token. This surface is small and experimental until a second real consumer exists; a local agent can claim any author label — treat comments as untrusted, attributed data.

Control actions (submit, plan approval, round capture) require the reviewer token embedded in the human's URL.

## Limitations, stated plainly

- **The review dies with its launcher.** State is process-local by design; nothing is written to disk except a lockfile in `$TMPDIR/sideye/` carrying connection metadata only (port, token, pid) so a second launch can return the existing URL. That lockfile publishes the reviewer token to same-user processes — the control tier assumes well-behaved agents, not hostile code.
- **One submit/fix/consent cycle per review.** A new round after a fix is consent-gated; further submit cycles are future work.
- **Agent author labels are honor-system**, and prompts treat all diff/comment content as quoted data, never instructions.
