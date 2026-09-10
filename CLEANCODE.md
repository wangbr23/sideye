# Clean Code Conventions

Project-specific coding standards for agents and humans. Keep this practical and update it when conventions become clear from real work.

## Core principles

- Prefer simple, direct solutions over clever abstractions.
- Keep changes small, focused, and reviewable.
- Optimize for readability and maintainability before novelty.
- Do not introduce abstractions until there are at least two real call sites or a clear present need.
- Surface ambiguity, conflicting requirements, or risky tradeoffs instead of guessing silently.

## Structure

- Avoid god files and oversized components/modules.
- Put reusable logic in the project's established `lib`/`utils`/service layer once reuse is real.
- Keep code close to where it is used until it has a reason to move.
- Prefer explicit names that describe domain intent over generic names like `data`, `item`, or `helper`.

## Type safety

- Avoid `any`, broad casts, non-null assertions, and ignored type errors unless there is a documented reason.
- Model domain states explicitly instead of relying on loose objects or sentinel values.
- Validate external input at boundaries.

## Error handling

- Handle expected failures deliberately.
- Do not swallow errors silently.
- Return or throw errors in the style already used by the project.
- Include enough context for debugging without leaking secrets or sensitive data.

## Testing

- Add or update tests for behavior changes when the project has a test setup.
- Prefer behavior-focused tests over brittle implementation tests.
- If tests cannot be run or do not exist yet, say so in the final report.

## Cleanup before finishing

- Remove dead code, debug logging, commented-out experiments, and unused imports.
- Do not leave TODO/FIXME comments unless they describe a real follow-up task also recorded in `TODO.md`.
- Run the relevant format, lint, typecheck, and test commands from `AGENTS.md` when available.
