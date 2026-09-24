# Knowledge base overview template

> Used to generate `<output_dir>/README.md`, produced in Phase K2 batch 5 (the top-level index of the knowledge base).

```markdown
# <Project name>: Deep Knowledge Base
<!-- search-anchor: <project name>, <project English name>, knowledge base, architecture overview, quick navigation, component documents, Graph RAG, graph -->

> **AI reading guide**: this directory is an AI-Native knowledge base. Read this file first for the global picture and the cognitive boundaries,
> then follow the retrieval routing rules into the relevant document for details. **Never read the whole knowledge base directory at once.**

## 🤖 Knowledge Base Retrieval Routing Guide (for AI)

### Quick navigation by question type

| I want to know... | Read... | Path |
|---------|---------|------|
| Overall system architecture and layering | Technical architecture document | `./{project_name} Technical Architecture.md` |
| Design and implementation of a component | Component design document | `./XX_{component}_Design.md` |
| Dependencies between components | G1 dependency matrix | `./graph/G1_*.md` |
| Which modules an API passes through | G2 call chain overview | `./graph/G2_*.md` |
| Where data lives, MQ topology | G3 data flow | `./graph/G3_*.md` |
| Which module an error code belongs to | G4 error code map | `./graph/G4_*.md` |
| The full flow of a business scenario | G5 interaction scenarios | `./graph/G5_*.md` |
| Who A depends on indirectly (multi-hop query) | G6 knowledge graph triples | `./graph/G6_*.md` |
| Blast radius if component X goes down | G7 risk analysis | `./graph/G7_*.md` |
| How to change a configuration | G8 config parameter index | `./graph/G8_*.md` |
| Whether an operation is allowed | G9 business rule constraints | `./graph/G9_*.md` |
| Product constraint → code location mapping | Core API mapping document | `./XX_*_Core_API_Product_Code_Mapping.md` |
| Business development SOP | Business development guidelines | `./XX_*_Business_Development_SOP.md` |

### Retrieval rules

- **Rule 1, index first, then dig in**: for an unfamiliar component, read this file first to find the right path, then go into the component document
- **Rule 2, component-internal questions go to the component document**: core mechanisms, code entry points, data models → `XX_{component}_Design.md`
- **Rule 3, cross-component relation questions go to the graph**: dependency matrix, call chains, impact surface → the `graph/` directory
- **Rule 4, operation feasibility questions go to G9**: constraint matrix + decision tree → `graph/G9_*.md`
- **Rule 5, content marked `[UNVERIFIED]` must not be used for code generation** until confirmed by a human
- **Rule 6, `AMBIGUOUS` relations must not be used for change impact assessment** until clarified

---

## 🚧 Cognitive Boundary Declaration (AI must read)

> This section declares what this knowledge base **does not know**. When a question touches the areas below, the AI
> **must proactively tell the user "this information is outside the knowledge base coverage; check the source code / product docs / contact the team"**
> instead of trying to infer or hallucinate.

### Coverage

| Dimension | Coverage | Notes |
|------|------|------|
| Code baseline | `<commit SHA>` (`<tag>`) | Changes **after** this version are not covered |
| Generated at | `<YYYY-MM-DDTHH:MM:SSZ>` | Time anchor between the knowledge base and the code |
| Core components (P0) | <P0 component list> | Deepest documentation, interface-level coverage |
| Important components (P1) | <P1 component list> | Medium documentation depth, core mechanisms covered |
| Auxiliary components (P2) | <P2 component list> | Limited documentation depth, architecture level only |

### Explicitly not covered (AI should not attempt to answer)

| Area | Reason |
|------|------|
| Internals of third-party SDKs/libraries | The knowledge base records only how they are called, not third-party source |
| Operations/deployment details (ansible/k8s config) | Outside the scope of a codebase knowledge base; consult the operations docs |
| Non-code deliverables (UI design, original product PRDs) | Only the Type-5/6 bridge documents map product constraints |
| Historical architecture evolution | Only the architecture of the current code baseline is reflected |
| Performance benchmark data | The knowledge base contains no load-test data |
| <project-specific uncovered items> | <reason> |

### Low-confidence areas (extra warning needed when answering)

| Area | Reason | Recommendation |
|------|------|------|
| Internal details of P2 auxiliary components | Limited documentation depth | Add "based on limited documentation analysis" when citing |
| Content marked `[UNVERIFIED]` | Cannot be traced back to code | Must tell the user "this information is not verified against code" |
| `AMBIGUOUS` relations | Confidence < 0.3 | Must tell the user "this relation is uncertain" |
| Type-5/6 when product docs are missing | No product doc input | Marked `[PRODUCT_DOC_MISSING]` |

### Knowledge base update notes

- **Incremental update**: `teamai codebase --extract <repo> --project <slug> --incremental` re-extracts only the changed files
- **Full rebuild**: recommended after large-scale code refactoring
- **Last updated**: `<ISO8601>`

---

## Project introduction

<!-- 1-3 sentences: project background, core business goals, main users -->

## Tech stack

| Category | Technology | Notes |
|------|------|------|
| Language | Go / Python | ... |
| Framework | go-zero / FastAPI | ... |
| Database | MySQL / PostgreSQL | ... |
| Cache | Redis | ... |
| Message queue | Kafka / RabbitMQ | (if any) |

## Knowledge base document index

### Architecture-level documents
| Document | Type | Size | Notes |
|------|------|------|------|
| {project_name} Technical Architecture.md | Type-1 | ~200KB | Architecture overview |
| {project_name} Business Architecture.md | Type-2 | ~70KB | Product capabilities + lifecycle |
| {project_name} Deployment Architecture.md | Type-3 | ~40KB | Deployment topology |

### Component design documents
| No. | Component | Layer | Priority | Size |
|------|------|--------|--------|------|
| 01 | <component> | <layer> | P0 | ~NKB |

### Bridge documents (generated when product docs exist)
| Document | Type | Notes |
|------|------|------|
| Core API Product Code Mapping | Type-5 | Product constraint → code location |
| Product Rules Cheat Sheet | Type-6 | Usage limits / FAQ → code |
| Business Development SOP | Type-7 | Development / change operation guidelines |

### Graph document set (Graph RAG)
| Document | Purpose | Size |
|------|------|------|
| G1~G9 | Cross-component relation index | See `graph/README.md` |

## Knowledge base quality overview

| Metric | Value | Status |
|------|------|------|
| Total documents | N | - |
| Content accuracy (with code references) | X% | ✅/⚠️ |
| [UNVERIFIED] ratio | X% | Target <15% |
| Interface coverage (non-NONE components) | X% | Target ≥90% |
| AMBIGUOUS relation count | N | Needs human confirmation |

> See `_review/k4-quality-report.md` for the detailed quality report

## Code baseline version

> ⚠️ This knowledge base was generated from the code version below. After the code evolves, run `teamai codebase --extract <repo> --project <slug> --incremental` for an incremental update.

- **Commit**: `<git commit SHA>`
- **Tag**: `<tag or "no tag">`
- **Generated at**: `<YYYY-MM-DDTHH:MM:SSZ>`

> Version information source: `_review/metadata.json`
```
