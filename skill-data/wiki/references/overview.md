# wiki: AI cognition engineering for large codebases

> TeamAI built-in skill. The methodology, scripts and agent specifications are **not** copied into `.claude/`, `.codebuddy/`, `.cursor/` or any other agent directory: they ship inside the installed CLI and are served on demand by `teamai skill get wiki` (`--full` for the references too). What an agent reads therefore always matches the CLI it is running. `teamai skill path wiki` prints the directory that holds the scripts and templates, for the commands below that run them. TeamAI ships no separate team-wiki CLI, and no extra plugin is required.

## Why this skill exists

The AI comprehension problem of large projects:

| Pain point | Symptom |
|------|---------|
| **Context does not fit** | 10+ repositories and hundreds of thousands of lines of code, far beyond the AI context window |
| **Relations are unclear** | RPC/MQ/DB dependencies between microservices are scattered across repositories with no global view |
| **Rules are not remembered** | Business constraints, state machines and config parameters hide deep in call chains |
| **Answers are inaccurate** | AI sees only local code, lacks global architecture awareness, and hallucinates easily |
| **High token consumption** | Every question re-reads large amounts of source, which is very inefficient |

## How it is solved

Architecture reverse-engineering **compresses the huge codebase into a structured knowledge base**:

- Every conclusion has a code `file:line` as evidence
- Every component relation carries a confidence label (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`)
- Every generation run produces accuracy statistics, with automatic warnings when thresholds are exceeded
- AI reads the knowledge base instead of the source and gains global architecture awareness for **about 1/50 of the tokens**
- In Phase 0, `teamai codebase --extract` can generate evidence-backed structural edges (TS/JS/Python/Go AST + multi-language heuristics)
- After extraction, `teamai codebase --deep-enrich --project <slug> --output <repo>` can generate deterministic graph documents (G1/G2/G3) and deep knowledge; no separate team-wiki CLI is needed

---

## Deliverables

```
<output_dir>/
├── README.md                           ← Retrieval routing guide (for AI)
├── {project_name} Technical Architecture.md            ← Whole-system view, ~200KB
├── {project_name} Business Architecture.md             ← Product capabilities + lifecycle
├── {project_name} Deployment Architecture.md           ← Deployment topology
├── XX_{component}_Design.md × N                        ← One per component, with the AI Quick Reference table
├── XX_{project_name}_Core_API_Product_Code_Mapping.md  ← Product constraint → code location bridge document
├── XX_{project_name}_Product_Rules_Cheat_Sheet.md
├── XX_{project_name}_Business_Development_SOP.md
├── {anti-patterns / RPC contracts / troubleshooting notes} × N
├── _manifest.json                      ← Machine-readable manifest (for later graph merging)
└── graph/                              ← Graph RAG graph document set
    ├── G1 Component dependency matrix
    ├── G2 Call chain overview + state machines
    ├── G3 Data flow and storage dependencies
    ├── G4 Error code component map
    ├── G5 Cross-component interaction scenarios (≥10 sequence diagrams)
    ├── G6 Knowledge graph triples (≥100 entries, with confidence)
    ├── G7 Architecture risks and impact analysis
    ├── G8 Core config parameter index
    └── G9 Business rule constraint matrix + AI reasoning decision tree
```

---

## Execution flow

```
Phase 0  → Initialisation: collect paths, project name, product doc sources; optional CLI ast+heuristic structural baseline

Phase K1 → Architecture reverse-engineering: key file extraction → layered analysis → component relation matrix
                                              ⛔ Confirmation point ① Architecture understanding

Phase K2 → Document generation (parallel batches):
             Batches 1~4: Type-4 component documents (dispatched to parallel sub-agents)
                                              ⛔ Confirmation point ② Document quality spot check
             Batches 5~7: architecture overview + bridge documents + knowledge enhancement

Phase K3 → AI-Native enhancement:
             search-anchor + bidirectional links + retrieval routing rules
             Graph RAG graph document set G1~G9 (three-state confidence labels)

Phase K4 → Quality assessment:
             validate_kb.py automatic checks
             Whole-base accuracy audit ([UNVERIFIED] statistics + interface coverage)
             Cross-document consistency check (contradiction detection + automatic fixes)
             RAG retrieval spot check (7 question types)
             AI end-to-end validation (10~15 standard questions + code trace-back)
             Quality report generation
```

Supports `--update` incremental updates (based on a file hash cache, rerunning only changed components).

---

## File structure

The files below ship with the CLI; `teamai skill path wiki` prints the directory that contains them (`{SKILL_DIR}` in this document).

```
{SKILL_DIR}/
├── SKILL.md                                ← Main execution instructions (`teamai skill get wiki`)
├── scripts/
│   ├── scan_repo.py                        ← Repository scan helper
│   └── validate_kb.py                      ← Knowledge base quality validation tool
├── references/
│   ├── overview.md                         ← This file
│   ├── agents/
│   │   ├── kb-doc-generator.md             ← Dedicated Agent for Type-1~8 document generation
│   │   └── graph-rag-agent.md              ← Dedicated Agent for G1~G9 graph documents
│   ├── methodology/
│   │   ├── phase0-collection.md            ← Source material collection method
│   │   ├── phase1-reverse-engineering.md   ← Architecture reverse-engineering method
│   │   ├── phase2-document-types.md        ← Specification and quality standards of the nine document types
│   │   ├── phase3-ai-enhancement.md        ← AI-Native enhancement method
│   │   └── phase4-quality.md               ← Quality assessment checklist
│   ├── phases/                             ← Execution steps of each Phase
│   └── templates/
│       └── project-overview.md             ← Knowledge base README template (with cognitive boundary declaration)
```

---

## Quality standards

| Dimension | Passing standard |
|------|---------|
| Coverage | ≥90% of P0 core components have documents |
| Accuracy | [UNVERIFIED] < 15% |
| Structural quality | Dead links = 0, search-anchor coverage ≥95% |
| AI usability | RAG retrieval spot check accuracy ≥85% |
| Relation trustworthiness | AMBIGUOUS relations < 10%, all listed for confirmation |
