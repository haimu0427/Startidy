# Startidy CLI Commands Reference

All commands support `--json` for machine-readable JSON envelope output on `stdout`. Progress messages and diagnostics are printed to `stderr`.

## Global Options

- `--state-dir <dir>`: Custom state directory path (overrides default OS data directory or `STARTIDY_STATE_DIR`).
- `-V, --version`: Print CLI version.
- `-h, --help`: Print help.

## Commands

### `startidy doctor`
Verifies environment prerequisites:
- Node.js runtime version (>= 22.0.0)
- `gh` CLI availability and version
- GitHub authentication and viewer identity
```bash
startidy doctor --json
```

### `startidy snapshot`
Queries GitHub GraphQL for all user starred repositories, lists, and memberships. Reconciles with local ledger and generates candidates.
```bash
startidy snapshot --out snapshot.json --json
```

### `startidy details`
Retrieves repository README contents, using local cached content when available.
```bash
# Fetch candidate repositories in batches
startidy details --snapshot snapshot.json --candidates --offset 0 --limit 20 --out details.json --json

# Or fetch specific repository IDs
startidy details --snapshot snapshot.json --repo-id R_kgDO... --out details.json --json
```

### `startidy preview`
Performs comprehensive schema, semantic, and mode policy checks on `plan.json` against `snapshot.json`. Computes atomic operation diff and outputs `review.json` with a cryptographic digest.
```bash
startidy preview --snapshot snapshot.json --plan plan.json --out review.json --json

# Also supports reading plan from stdin
cat plan.json | startidy preview --snapshot snapshot.json --plan - --out review.json --json
```

### `startidy apply`
Executes planned atomic operations against GitHub. Acquires account-level lock, checks remote state, tracks execution journal, and updates local ledger.
```bash
# Apply verified review
startidy apply --review review.json --json

# Resume interrupted run
startidy apply --resume run_1720000000_abc --json
```

### `startidy status`
Inspects past or interrupted run progress.
```bash
startidy status --run run_1720000000_abc --json
```

## Exit Codes

| Exit Code | Constant | Meaning |
| :--- | :--- | :--- |
| `0` | `SUCCESS` | Command completed successfully with no errors. |
| `2` | `INVALID_INPUT` | Input argument, plan schema, scope mismatch, or policy violation. |
| `3` | `AUTH_OR_DEPENDENCY` | Missing Node/gh CLI dependency or GitHub auth failure. |
| `4` | `STATE_CONFLICT` | Stale snapshot, remote data drift, or account lock currently held. |
| `5` | `RATE_OR_NETWORK` | GitHub API rate limit or transient network failure exhausted. |
| `6` | `PARTIAL_OR_RECOVERY` | Run stopped partially; resume entry point available via `--resume`. |
| `1` | `INTERNAL_ERROR` | Unexpected internal exception. |
