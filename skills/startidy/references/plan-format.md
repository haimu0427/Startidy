# Startidy Plan Format Specification

The `plan.json` file is produced by the host agent after discussing proposals with the user.

## Structure Overview

```json
{
  "schemaVersion": "1.0",
  "account": {
    "hostname": "github.com",
    "viewerId": "U_kgDOCpiMZw"
  },
  "baseSnapshotId": "snap_1720000000_a1b2c3d4",
  "mode": "incremental",
  "scope": {
    "repoIds": ["R_kgDOGP67ng"],
    "listIds": []
  },
  "lists": {
    "create": [
      {
        "key": "agent-tools",
        "name": "AI: Agents",
        "description": "Tools and frameworks for AI agents",
        "isPrivate": true
      }
    ],
    "update": [],
    "delete": []
  },
  "decisions": [
    {
      "repoId": "R_kgDOGP67ng",
      "outcome": "assign",
      "addTo": [
        { "newListKey": "agent-tools" }
      ],
      "removeFrom": [],
      "reason": "Framework dedicated to building LLM agents"
    }
  ]
}
```

## Field Definitions

### 1. Header & Context
- `schemaVersion`: Must be `"1.0"`.
- `account`: Must match `snapshot.account`.
- `baseSnapshotId`: Must match `snapshot.snapshotId`.
- `mode`: One of `"bootstrap" | "incremental" | "targeted" | "full"`.

### 2. Scope
- `scope.repoIds`: Array of repository IDs for which decisions are being made. Every repo ID in this array must have exactly one decision in `decisions`.
- `scope.listIds`: Array of existing list IDs that may be modified or deleted (required for `targeted` mode).

### 3. Lists
- `create`: New lists to create. `key` is a temporary handle (alphanumeric/hyphen/underscore) referenced in `addTo.newListKey`.
- `update`: Modifications to existing lists (`listId`, `changes: { name?, description?, isPrivate? }`, `reason`). Forbidden in `incremental` mode.
- `delete`: Lists to remove (`listId`, `reason`). Requires explicit member removal decisions for all existing members. Forbidden in `incremental` mode.

### 4. Decisions
Each decision targets one repository in `scope.repoIds`:
- **`assign`**: Adds to and/or removes from lists:
  - `addTo`: Array of `{ listId: string }` or `{ newListKey: string }`.
  - `removeFrom`: Array of `{ listId: string }` (must be empty in `incremental` mode).
  - `reason`: Explaining why this assignment was made.
- **`keep`**: Retains existing list memberships with no change.
- **`defer`**: Postpones classification due to insufficient information.
- **`ignore`**: Marks repository as permanently ignored by user request.
