# Design documents

One document per feature design, in English. The status column says how far each design has come.

| Status | Design | Tracking |
| --- | --- | --- |
| Implemented | [Data directory layout](data-directory-layout.md) — global home + per-project partitioning | #374 |
| Implemented | [Unified dashboard](dashboard-unified.md) — four-module local dashboard | — |
| Implemented | [GitCode provider](gitcode-provider.md) | #361 |
| Implemented | [Model profiles](model-profiles.md) — `teamai models` | — |
| Implemented | [Team env by directory](env-by-directory.md) — each directory's shell gets the env of the scope that governs it | #1018 |
| Implemented | [Skill serving](skill-serving.md) — built-in skill content shipped with the CLI (`teamai skill get`) | #678 |
| Implemented, living | [Team secrets](team-secrets.md) — describes only what the current version does | #875, #879 |
| In progress | [Multi-project management](multi-project-management.md) — `project` as a dimension orthogonal to `role`; P1/P2 shipped (`--project`, `manifest/projects.yaml`) | #375 |
| Proposal | [Management backend](management-backend.md) — a backend for members who do not use Git | #341 |
| Historical plan | [Git-native memory](git-native-memory.md) — March 2026 planning note; recall and voting have since shipped and are documented in the [Usage Guide](../guide/knowledge.md#knowledge-capture--retrieval) | — |
| Historical plan | [Team intelligence platform](team-intelligence-platform.md) — March 2026 planning note; session docs, usage analytics and digest have since shipped | — |

Statuses:

- **Implemented** — the feature is in `main`; the document explains the design behind it.
- **Implemented, living** — the document is updated with every change and is the reference for current behavior.
- **In progress** — part of the phasing has shipped; the document says which.
- **Proposal** — describes future behavior; nothing in the CLI implements it yet.
- **Historical plan** — an early planning note kept for context. Current behavior is documented in the [Usage Guide](../usage-guide.md), not here.

Adding a design: one English file per feature, a `> Status:` line under the title, and a row in this table.
