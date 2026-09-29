# Startidy (v2)

Contract-driven GitHub Stars organizer for AI agents and developers.

Organize your starred repositories into structured GitHub User Lists safely, deterministically, and incrementally.

---

## What's New in v2

- **Host Agent Reasoning**: No LLM API keys required. Startidy relies on your host agent (Claude Code, Codex, Cursor, etc.) for taxonomy reasoning and classification via an [Agent Skill](skills/startidy/SKILL.md).
- **Strict Data Contracts**: All data exchange is defined by JSON Schema 2020-12 (`snapshot`, `plan`, `review`).
- **Safe & Incremental by Default**: Existing lists and memberships are preserved. Incremental mode prevents unauthorized deletions or renames.
- **Preview & Review Before Execution**: Every planned change generates a verified `review.json` with cryptographic digest and atomic operations.
- **Crash Recovery & Idempotence**: Interrupted runs are journaled before each write. A uniquely verifiable remote result resumes safely; ambiguous create results stop as `needs_review` rather than risking a duplicate List.
- **Zero Token Leakage**: Uses the authenticated GitHub CLI (`gh`) under the hood.

---

## Prerequisites

1. **Node.js**: Version `>= 22.0.0`
2. **GitHub CLI (`gh`)**: Installed and authenticated (`gh auth login`) with read/write access to user lists.

Run diagnostic check:
```bash
startidy doctor --json
```

---

## Installation

### 1. Install CLI

```bash
# Global install via npm
npm install -g startidy

# Or run via npx
npx startidy --help
```

### 2. Install Agent Skill

Startidy provides a universal agent skill in [`skills/startidy/`](skills/startidy/):
- **Claude Code**: Copy or link `skills/startidy` to `.claude/skills/startidy`
- **Codex / ChatGPT**: Copy or link `skills/startidy` to `.agents/skills/startidy`
- **Cursor**: Reference `skills/startidy/SKILL.md` in project skills

---

## Three-Phase Workflow

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

### Phase 1: Observation & Snapshot
```bash
# Capture full state of Stars, Lists, and candidates
startidy snapshot --out snapshot.json --json

# Read README contents for candidate repositories in batches
startidy details --snapshot snapshot.json --candidates --offset 0 --limit 20 --out details.json --json
```

### Phase 2: Plan & Preview
The agent formulates categories and decisions according to [plan-format.md](skills/startidy/references/plan-format.md) and validates the plan:
```bash
startidy preview --snapshot snapshot.json --plan plan.json --out review.json --json
```
The preview outputs a verified `review.json` with exact counts of additions, list creations, and deferred items.

### Phase 3: Apply & Recovery
```bash
# Apply verified review
startidy apply --review review.json --json

# In case of network interruption or rate limiting:
startidy status --run <runId> --json
startidy apply --resume <runId> --json
```

If status is `needs_review`, inspect the reported operation and remote List state first. Resume performs read-back reconciliation; it never blindly retries an unprovable List creation.

Record an explicit resolution before resuming:

```bash
# Adopt an exactly matching existing List for a blocked CreateList
startidy resolve --run <runId> --action adopt --list-id <listId> --json

# Explicitly retry, accept current remote state, or stop the run
startidy resolve --run <runId> --action retry --json
startidy resolve --run <runId> --action accept-current --json
startidy resolve --run <runId> --action abort --json

startidy apply --resume <runId> --json
```

---

## Command Reference

| Command | Purpose | Key Flags |
| :--- | :--- | :--- |
| `startidy doctor` | Verify Node, gh CLI, and auth | `--json` |
| `startidy snapshot` | Capture current Stars and Lists | `--out <file>`, `--json` |
| `startidy details` | Retrieve READMEs with caching | `--snapshot <file>`, `--candidates`, `--repo-id <id...>`, `--offset <n>`, `--limit <n>`, `--out <file>` |
| `startidy preview` | Validate plan and generate review | `--snapshot <file>`, `--plan <file>`, `--out <file>` |
| `startidy apply` | Execute verified operations | `--review <file>`, `--resume <runId>` |
| `startidy resolve` | Resolve a blocked operation | `--run <runId>`, `--action <action>`, `--list-id <id>` |
| `startidy status` | Check run progress & journal | `--run <runId>` |

All commands accept `--state-dir <dir>` to override the local state directory.

---

## Exit Codes

- `0`: Success / No change
- `2`: Invalid input / Schema validation failure / Policy violation
- `3`: Dependency missing / GitHub authentication failed
- `4`: State conflict / Snapshot stale / Account lock held
- `5`: Rate limit or network retry budget exhausted
- `6`: Partial execution / Resumable state recorded
- `1`: Unexpected internal error

---

## License

MIT
