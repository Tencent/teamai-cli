---
name: wiki
description: >-
  Make AI truly understand large codebases: for multi-repository, multi-microservice projects
  that have evolved over years, run architecture reverse-engineering + a Graph RAG graph +
  multi-language AST to compress a huge codebase into a structured knowledge base, where every
  conclusion traces back to a code line and every relation carries a confidence label. Suited to
  projects with 10+ repositories or microservices that AI cannot understand globally by reading
  the code directly. Triggers: architecture analysis, architecture reverse-engineering,
  codebase knowledge base, code-to-knowledge, architecture wiki, large multi-repo codebase.
  Loaded on demand by the teamai discovery stub.
---

# wiki: AI cognition engineering for large codebases

> Prerequisites: an accessible source directory (multiple repositories supported), Python 3, and an installed teamai CLI.
> The methodology, sub-agent prompts, templates and scripts ship with the CLI. Run `teamai skill path wiki` to get their absolute path;
> `{SKILL_DIR}` in this document refers to that path; a reference file you open on its own writes that directory as `SKILL_DIR` in braces.
> Write the knowledge-base documents in Simplified Chinese, as earlier releases did. When updating an existing knowledge base, keep its file names and headings; `validate_kb.py` accepts both the current English and the earlier Chinese headings.
> The Phase 0 structural baseline uses `teamai codebase --extract`. TeamAI does not ship a separate team-wiki CLI. No extra plugin is required.

**The problem**: large projects (10+ repositories, dozens of microservices, years of iteration) defeat global understanding by AI. The context window cannot hold all the code, component relations are scattered everywhere, and business rules hide deep in call chains. Letting AI read the code directly is both slow (huge token counts) and inaccurate (no global view).

**The solution**: use architecture reverse-engineering to systematically compress a huge codebase into a **structured, verifiable, AI-Native** deep knowledge base. Every conclusion traces back to a code line, every relation carries a confidence label, and every update is incrementally verified. AI reads the knowledge base instead of the source, and gains global architecture awareness for about **1/50 of the tokens**.

## Usage

The user states the mode in natural language, or simply says "build a codebase knowledge base":

```
default     Standard: single-session core path
--deep      Full K1~K4 + G1~G9
--update    Incremental update of an existing knowledge/
continue    Resume from the _review/progress.json checkpoint
```

---

## Agent architecture

| Agent | File | When started |
|-------|------|---------|
| Knowledge base document generator Agent | `{SKILL_DIR}/references/agents/kb-doc-generator.md` | Phase K2, every component batch |
| Graph RAG Agent | `{SKILL_DIR}/references/agents/graph-rag-agent.md` | Phase K3 |

**Main agent responsibilities**: workflow orchestration, confirmation point management, progress.json maintenance, quality report aggregation.

---

## Entry decision

**This decision must run first on every activation.**

```
IF the user input contains "--update" or "incremental update":
  → Update mode
ELSE IF the user input contains "continue" or "resume":
  → Continue mode
ELSE:
  → Check whether _review/progress.json exists under the user-specified directory
  IF it exists → report the state, wait for "resume last run" or "start over"
  ELSE         → Phase 0
```

---

## Continue mode

```
Step 1: Locate progress.json
Step 2: Read and parse it, show a resume summary
Step 3: Jump according to current_phase:
  "phase0_done"              → Phase K1
  "phasek1_waiting_confirm"  → Show k1-architecture-map.md, wait for confirmation ①
  "phasek1_confirmed"        → Phase K2
  "phasek2_batch_N"          → Continue Phase K2 from batch N (skip completed ones)
  "phasek2_waiting_confirm"  → Wait for confirmation ②
  "phasek2_confirmed"        → Phase K3
  "phasek3_done"             → Phase K4
  "phasek4_done"/"completed" → Report completion, ask whether to --update or rerun a component
```

---

## Update mode (incremental update)

**Trigger**: the user asks for an "incremental update", or specifies the `--update` mode in this skill.
**Precondition**: an existing progress.json in the completed state.

```
Step 1: Read progress.json, get file_hash_cache
Step 2: Scan project_root, compute the current SHA256 of every file
Step 3: Compare hashes, classify: added / modified / deleted
Step 4: Show the change summary, wait for user confirmation:
  ┌────────────────────────────────────┐
  │ Change summary                     │
  │ Added: N files                     │
  │ Modified: N files (incl. Aurora.py)│
  │ Deleted: N files                   │
  │ Affected components: [list]        │
  │ Affected graph documents: G1/G2/G6/G7 │
  └────────────────────────────────────┘
Step 5: Rerun only the affected scope:
  - Phase K2: regenerate the Type-4 documents of affected components (overwrite)
  - Phase K3 partial: update the graph documents that involve changed components (G1/G2/G6/G7)
  - Phase K4: rerun validate_kb.py
Step 6: Update file_hash_cache + the metadata.json commit SHA
Step 7: Component-level diff (handle added/removed repositories or components)
  IF the repos list differs from last time:
    Added repositories → run a full K1 scan on the new repository, add it to the component inventory, generate Type-4 documents
    Removed repositories → prepend `⚠️ [DEPRECATED] The repository for this component has been removed` to the component document
    → Update the component inventory in k1-architecture-map.md
    → Update the G1 matrix (remove rows/columns of removed components, add rows/columns for new ones)
```

---

## progress.json specification

**Path**: `<output_dir>/../_review/progress.json`

```json
{
  "version": "5",
  "repos": [
    {"name": "repo-a", "path": "/absolute/path/to/repo-a", "language": "go"},
    {"name": "repo-b", "path": "/absolute/path/to/repo-b", "language": "python"}
  ],
  "output_dir": "/absolute/path/to/knowledge",
  "primary_language": "go",
  "project_name": "ProjectName",
  "scan_time": "2026-01-01T10:00:00Z",
  "current_phase": "phasek2_batch_2",
  "confirmed_phases": ["phase0", "phasek1"],

  "service_map": {
    "description": "Service name → repository map built in Phase K1 Step 3",
    "ServiceA": {"repo": "repo-a", "entry": "cmd/serviceA/main.go"},
    "ServiceB": {"repo": "repo-b", "entry": "app/main.py"}
  },

  "kb_progress": {
    "component_total": 12,
    "components_done": ["Aurora", "Frame"],
    "components_pending": ["CCDB", "Dispatcher"],
    "type1_done": false,
    "type2_done": false,
    "type3_done": false,
    "bridge_docs_done": false,
    "graph_rag_done": false
  },

  "accuracy_stats": {
    "total_claims": 0,
    "verified": 0,
    "unverified": 0,
    "ambiguous_relations": 0
  },

  "interface_coverage": {
    "description": "Interface count reconciliation, filled by the Phase K2 self-check",
    "ComponentA": {"type": "HTTP", "scanned": 13, "documented": 0, "gap": 13},
    "ComponentB": {"type": "MQ",   "scanned": 5,  "documented": 0, "gap": 5}
  },

  "consistency_check": {
    "description": "Cross-document consistency check result from Phase K3 Step 3",
    "contradictions": 0,
    "missing_refs": 0,
    "g1_deviations": 0,
    "consistency_rate": 0.0
  },

  "e2e_validation": {
    "description": "AI end-to-end validation result from Phase K4 Step 4",
    "total_questions": 0,
    "correct": 0,
    "partial": 0,
    "incorrect": 0,
    "boundary_ok": 0,
    "boundary_fail": 0,
    "accuracy_rate": 0.0
  },

  "file_hash_cache": {
    "relative/path/to/file.go": "sha256_hex"
  }
}
```

> `accuracy_stats` accumulates after every Phase K2 batch and is the global trust indicator of the knowledge base.

---

## Core principles (accuracy first)

1. **Code is the single source of truth**: every conclusion must cite a code file:line as evidence; anything unverifiable is marked `[UNVERIFIED]`
2. **Three-state confidence is mandatory**: every relation in the graph is labelled `EXTRACTED(1.0)` / `INFERRED(0.6~0.9)` / `AMBIGUOUS(0.1~0.3)`; no invention out of thin air, no 0.5 default
3. **Two-level accuracy verification**: Phase K2 self-checks every document right after generation; Phase K4 verifies the whole knowledge base
4. **Two human-in-the-loop confirmations**: architecture understanding (K①) and component document quality (K②) must be confirmed by a human to stop systematic errors from spreading
5. **Parallel generation + resume from checkpoint**: Type-4 component documents are dispatched in parallel (all Agent calls in the same message); progress.json is persisted after every batch
6. **Token economy**: the `Glob → Grep → Read` three-step method; full directory scans are forbidden
7. **Honest auditing**: `[UNVERIFIED]` must not be hidden; quality numbers are shown in full; when unsure, mark AMBIGUOUS instead of deleting
8. **Cognitive boundary declaration**: the knowledge base README must state explicitly what is covered and what is not, so AI knows when to say "not sure"
9. **Cross-document consistency**: Phase K3 must cross-check relation descriptions between components; contradictions count as "consistent" only after they are fixed
10. **End-to-end verifiable**: Phase K4 tests the knowledge base's actual answering ability with standardised questions; E2E accuracy target ≥ 80%

---

## Phase workflow (loaded on demand)

The full steps of each phase live in separate files. Load a file when its phase comes up; do not read them all at once:

| Phase | File | Content |
|---|---|---|
| Phase 0 | `{SKILL_DIR}/references/phases/phase0-init.md` | Initialisation, `teamai codebase --extract` structural baseline, repository inventory |
| Phase K1 | `{SKILL_DIR}/references/phases/k1-reverse-engineering.md` | Architecture reverse-engineering and source material collection, scan script, architecture analysis report |
| Phase K2 | `{SKILL_DIR}/references/phases/k2-documents.md` | Document generation (parallel batches + intermediate quality confirmation) |
| Phase K3 | `{SKILL_DIR}/references/phases/k3-ai-native.md` | AI-Native enhancement + Graph RAG graph document set |
| Phase K4 | `{SKILL_DIR}/references/phases/k4-quality.md` | Quality assessment, validation script, quality report |

Methodology background (optional, for reference while writing documents): `{SKILL_DIR}/references/methodology/`;
sub-agent prompts: `{SKILL_DIR}/references/agents/`;
knowledge base README template: `{SKILL_DIR}/references/templates/project-overview.md`.

Human-readable overview (not for execution): `{SKILL_DIR}/references/overview.md`.

`teamai skill get wiki --full` prints every reference file in one go (about 130 KB). Use it only when you need to read everything.

## Output directory layout

```
<output_dir>/
├── README.md                           ← Knowledge base index + retrieval routing rules + cognitive boundary declaration (for AI)
│                                         Start from the template: cp "{SKILL_DIR}/references/templates/project-overview.md" <output_dir>/README.md
├── {project_name} Technical Architecture.md                ← [Type-1] Architecture overview (target ≤80KB, split automatically when larger)
├── {project_name} Technical Architecture-Core Call Chains.md ← [Type-1b] Split out only when Type-1 exceeds 80KB
├── {project_name} Technical Architecture-AI Metadata.md    ← [Type-1c] Split out only when Type-1 exceeds 80KB
├── {project_name} Business Architecture.md                 ← [Type-2] Product capabilities + lifecycle ~70KB
├── {project_name} Deployment Architecture.md               ← [Type-3] Deployment topology ~40KB
├── XX_{component}_Design.md × N                            ← [Type-4] 20~100KB each
├── XX_{project_name}_Core_API_Product_Code_Mapping.md      ← [Type-5] Generated only when product docs exist
├── XX_{project_name}_Product_Rules_Cheat_Sheet.md          ← [Type-6]
├── XX_{project_name}_Business_Development_SOP.md           ← [Type-7]
├── {knowledge_enhancement_doc} × N                         ← [Type-8] Anti-patterns / RPC contracts / troubleshooting / knowledge library
└── graph/                                                  ← [Type-9] Graph RAG graph document set
    ├── README.md                                           ← Graph index + lookup by question type
    ├── G1_{project_name}_Component_Dependency_Matrix.md
    ├── G2_{project_name}_Component_Call_Chain_Overview.md
    ├── G3_{project_name}_Data_Flow_and_Storage_Dependencies.md
    ├── G4_{project_name}_Error_Code_Component_Map.md
    ├── G5_{project_name}_Cross_Component_Interaction_Scenarios.md
    ├── G6_{project_name}_Knowledge_Graph_Triples.md
    ├── G7_{project_name}_Architecture_Risks_and_Impact_Analysis.md
    ├── G8_{project_name}_Core_Config_Parameter_Index.md
    └── G9_{project_name}_Business_Rule_Constraint_Matrix.md

_review/                                ← Process files (not part of the knowledge base)
├── progress.json                       ← Resume-from-checkpoint + incremental update state
├── metadata.json                       ← Code baseline version
├── interface-inventory.json            ← Interface scan baseline (Phase K1 Step 5)
├── k1-architecture-map.md              ← Architecture reverse-engineering result (confirmed by the user)
├── k2-doc-list.md                      ← Document inventory + accuracy statistics
├── k3-consistency-check.md             ← Cross-document consistency check report (Phase K3 Step 3)
└── k4-quality-report.md                ← Quality report (incl. E2E validation results)
```

---

## Control between phases

| User reply | Behaviour |
|---------|------|
| "continue" / "go on" / "ok" | Enter the next phase |
| "stop" | Stop; files generated so far stay usable |
| Describes a problem directly | Adjust, reconfirm, then continue |
| Edits files directly and then replies "continue" | Continue based on the edited file contents |

---

## Constraints

- **The main agent does no code analysis**: all of it is done by dedicated Agents; Read the corresponding agent file before starting one
- **No redundant output**: Write generated files directly; never print the full content in the conversation first
- **Component document naming**: `XX_{component}_Design.md` (XX is a two-digit number assigned in dependency-chain order, lower layers get lower numbers)
- **When no product docs exist**: Type-5/6 may be skipped, or constraint values marked `[PRODUCT_DOC_MISSING]`; never guess
- **Parallel mode**: a Type-4 batch must send all Agent calls concurrently in the same message; serial batches run in order

### Honesty Rules

- **No invention out of thin air**: every relation in the graph must have an explicit basis in a component document; never guess from names
- **Confidence must not be faked**: EXTRACTED=1.0, INFERRED 0.4~0.9 by evidence strength, AMBIGUOUS 0.1~0.3; the 0.5 default is banned
- **[UNVERIFIED] must not be hidden**: above 20%, add a visible warning at the top of the document
- **Quality numbers shown in full**: validate_kb.py output must not show only the passing items
- **Token cost transparency**: after every batch, show the number of files read and the estimated token consumption
- **When unsure, prefer AMBIGUOUS**: better to mark as pending confirmation than to delete or pretend certainty

---

## Working with the TeamAI CLI (must read)

| Phase | Command / path |
|------|-------------|
| Phase 0 structural baseline | `teamai codebase --extract <repo> --project <slug>` (writes `<repo>/teamwiki/`) |
| Deep knowledge | Use `teamai codebase --deep-enrich --project <slug> --output <repo>` after extract has written `teamwiki/evidence/code/<slug>/`. `--output` is the repository root, not the `teamwiki/` directory. Prefix with `teamai --dry-run` to preview without writing. TeamAI does not ship a separate team-wiki CLI. No extra plugin is required. |
| Compile into the wiki after K3 | Skip. TeamAI does not ship a separate team-wiki CLI. Continue with this skill using `teamai` and the files under this skill directory. No extra plugin is required. |
| Product docs into the graph | Skip. Same English note as above. |
| Product ↔ code bridging | Use `teamai codebase --reconcile --output <repo>` after product pages and extracted code pages are under `<repo>/teamwiki/`. Prefix with `teamai --dry-run` to preview without updating the graph. |
| One-shot refresh | Use `teamai codebase --extract <repo> --project <slug> --incremental`, reusing the Phase 0 repository path and project slug even when running from another directory. Do not look for another CLI. |
| Quality assessment | Use `python3 "{SKILL_DIR}/scripts/validate_kb.py" <output_dir>` and `teamai codebase --lint --output <repo>` to check `<repo>/teamwiki/` (`--output` takes the repository root, not the `teamwiki/` directory). Skip any extra evaluate binary. |

**Path convention**: `{SKILL_DIR}` is the directory printed by `teamai skill path wiki`. The methodology is in `{SKILL_DIR}/references/methodology/`, sub-agent prompts in `{SKILL_DIR}/references/agents/`, and scripts in `{SKILL_DIR}/scripts/`.

The whole workflow runs within the content served by `teamai skill get wiki` and the `teamai` CLI. No extra plugin is required.
