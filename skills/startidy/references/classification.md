# Repository Classification Guidelines

Guidelines for the host agent when proposing, grouping, and refining GitHub User Lists.

## Core Principles

1. **User Purpose Over Generic Labels**:
   - Organize repositories by what the user uses them for (e.g., `Dev: CLI Tools`, `AI: LLM Frameworks`, `Infra: Kubernetes`), not generic tags like `awesome` or `misc`.
   - Maintain naming language consistency based on user preference or pre-existing list names.

2. **Respect Existing Taxonomy**:
   - In `bootstrap` or `incremental` modes, always prefer assigning new stars to existing lists before suggesting brand new categories.
   - Do not rename, merge, or delete existing user lists unless explicitly requested in `targeted` or `full` mode.

3. **Incremental Safety**:
   - In default `incremental` runs, only candidates from `snapshot.candidates` may be decided upon.
   - Existing memberships must not be removed (`removeFrom` must remain empty in incremental mode).

4. **Multi-Category Assignment**:
   - When a repository legitimately spans two disciplines (e.g. a Rust-based WebAssembly compiler), assign it to both if user preferences allow multi-categorization.
   - Avoid over-tagging: usually 1 to 2 targeted lists are better than 5 broad ones.

5. **Defer When Uncertain**:
   - If a repository has minimal description, an empty or uninformative README, or ambiguous purpose, use `outcome: "defer"` with a clear reason.
   - Do not guess or dump into an arbitrary list.

6. **Ignore Explicit Exclusions**:
   - If a user explicitly specifies that certain repositories should not be tracked or organized, set `outcome: "ignore"`.

## Category Suggestion Patterns

| Area | Recommended List Examples |
| :--- | :--- |
| **Artificial Intelligence** | `AI: Agents`, `AI: RAG & Embeddings`, `AI: Models & Inference` |
| **System & Infrastructure** | `Infra: Docker & K8s`, `System: Linux & Shell`, `Database: Storage` |
| **Web & Applications** | `Web: Frontend & UI`, `Web: Backend Frameworks`, `Security & Pentest` |
| **Developer Experience** | `DevTools: CLI`, `DevTools: IDE & Editors`, `Languages: Rust` |
| **Learning & References** | `Learn: Books & CS`, `Awesome: Curated Lists` |
