# Sideye

An OpenCode plugin that provides a comprehensive code review platform.

## Stack
- Language/runtime: TypeScript on Bun
- Framework: Bun built-ins (`Bun.serve`, `bun test`) — no bundler
- Package manager: Bun

## Commands
- Install: `bun install`
- Dev/run: Not configured
- Test: `bun test`
- Lint/typecheck: `bun run typecheck` (tsc --noEmit)
- Build: Not configured (no bundler — TS served/compiled by Bun)

## Conventions
Cross-project coding principles live in the user's global instructions. Project coding conventions live in `CLEANCODE.md`; keep detailed code-quality rules there so this file stays focused on project context.

This section is only for what's specific to *this* repo:
- Code style:
- Testing approach:
- Commit message format:

## Architecture
(Placeholder — fill in once the system has real shape. High-level modules/services and how they talk to each other. Update this when the shape changes, not on every commit.)

## Context files
Keep these current — they're what gives any session, model, or tool continuity without re-deriving history from scratch.

- **AGENTS.md** (this file) — stack, commands, repo-specific conventions, architecture. Update only when one of those actually changes.
- **CLAUDE.md** — pointer to this file only. Don't duplicate content into it.
- **CLEANCODE.md** — coding conventions agents should follow while editing code. Update when recurring code-quality preferences or project-specific patterns become clear.
- **docs/journal.md** — append-only session log. Never edit past entries; if something turns out wrong, say so in a new one.
- **docs/decisions.md** — append-only log of significant technical decisions. A reversed decision gets a new entry that supersedes the old one.
- **docs/designs/** — design documents. Save working versions here rather than leaving them only in chat.
- **TODO.md** — current and near-term work. Tasks carry an id, a manual/agent tag, and optional `depends-on` links so parallel-safe work can be computed.

**Before starting nontrivial work:** read this file, read `CLEANCODE.md`, skim recent journal entries, and check `TODO.md`.
**After finishing a session:** append a journal entry, update `TODO.md`, and append a decision entry if a load-bearing decision was made.

<!-- opencode-swe-factory:lesson-capture-protocol@1 start -->
## Lesson Capture Protocol

A lesson is anything from this session about how to work that a future session should repeat or avoid: work that went well and should be repeated, or a mistake, correction, or expressed preference that should change how you work. Judge the substance, not the user's exact words.
Decisions about what to build — scope, requirements, product or architecture choices — are not lessons. Record those in the project's decision/design docs (e.g. docs/decisions.md, docs/designs/); writing them there is the terminal action, not a lesson proposal.
Bias toward proposing. Proposals are drafts awaiting human approval and expire if ignored, so a wasted proposal costs seconds while a missed lesson repeats the mistake. Recording a lesson in repo docs, a journal, or a summary does not substitute for proposing it.
When a lesson-worthy moment happens, propose it via the swe_factory_propose_lesson tool in the same turn, proactively — never wait to be asked. Never include secrets or credential-like content in a proposal.
Immediately after a proposal returns, present it for approval via the question tool (or your environment's equivalent interactive ask) with Approve / Edit / Defer / Reject options. Never just list the candidate in text.
<!-- opencode-swe-factory:lesson-capture-protocol@1 end -->
