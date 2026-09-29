# CLAUDE.md

This file provides guidance to Claude Code and other agent hosts when working with code in this repository.

## Package & Commands

- Package: `@haimu0427/startidy` (v2.0.0)

```bash
bun install                                # install dependencies
bun run typegen                            # compile JSON Schemas to src/generated/
bun run build                              # bundle CLI into dist/index.js (ESM, Node >=22 target)
bun test                                   # run unit and integration tests
node dist/index.js <command>               # run built CLI via Node
npx @haimu0427/startidy <command>          # run via npx
```

## Architecture (v2)

Startidy is a contract-driven GitHub Stars organizer. It delegates planning, categorizing, and user interaction to the host agent while providing a deterministic, safe, and verifiable CLI for GitHub reads and writes.

```text
User ⇄ Host Agent / Skill
        │ (reads snapshot, classifies repos, constructs plan.json)
        ▼
   startidy CLI
        │ (parses args, validates JSON Schema/policy, produces review.json, executes)
        ▼
      core (pure domain logic: ports, snapshot, candidates, plan, policy, diff, executor)
        ▼
    adapters (github-gh via `gh api`, file-store with account isolation & locking)
```

### Three-Phase Pipeline

1. **Read**:
   - `startidy doctor --json`: Diagnoses Node, gh CLI, and GitHub authentication.
   - `startidy snapshot --out snapshot.json --json`: Captures starred repos, user lists, memberships, and candidates.
   - `startidy details --snapshot snapshot.json --candidates --offset 0 --limit 20 --out details.json --json`: Retrieves README contents in manageable batches.
2. **Plan & Review**:
   - Agent formulates categories and decisions conforming to `src/schemas/plan.schema.json`.
   - `startidy preview --snapshot snapshot.json --plan plan.json --out review.json --json`: Validates schema, references, scope, and policy; generates cryptographic digest and diff operations.
3. **Execution & Recovery**:
   - `startidy apply --review review.json --json`: Executes verified operations against GitHub under an account lock.
   - `startidy status --run <runId> --json`: Inspects execution journal.
   - `startidy apply --resume <runId> --json`: Safely resumes partial executions without duplicating verified operations.

### Data Contracts

- `src/schemas/snapshot.schema.json`: Normalized user state, lists, repos, and candidates.
- `src/schemas/plan.schema.json`: Change intent (`bootstrap`, `incremental`, `targeted`, `full`).
- `src/schemas/review.schema.json`: Review binding plan, snapshot baseline, atomic operations, digest, and summary.
- Types in `src/generated/` are strictly generated via `bun run typegen`. Do not edit them by hand.
