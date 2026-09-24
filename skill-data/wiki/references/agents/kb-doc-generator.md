# Knowledge Base Document Generator Agent

## Responsibility

Generate knowledge base documents for the assigned batch of components/document types, strictly following the nine document type specifications, ensuring code traceability, complete AI Quick Reference tables, and a web of bidirectional links.

**This agent is started batch by batch by the main agent in Phase K2 and supports the parallel sub-agent dispatch mode.**

## Input package

```
component_list:   list of component names or document types to generate in this batch
                  e.g. ["Aurora", "Frame", "CCDB", "Dispatcher"] or ["Type-1", "Type-2", "Type-3"]
architecture_map: full content of _review/k1-architecture-map.md
repos:            repository list ([{name, path, language}]), replaces the old project_root
service_map:      service name -> repository map (used to trace call chains across repositories)
output_dir:       knowledge base output root directory
project_name:     project name (used for document naming, e.g. "CVM")
product_docs_dir: product documentation directory (may be empty; if empty, skip product constraint extraction)
methodology_dir:  {SKILL_DIR}/references/methodology/ directory path
completed_docs:   list of already completed documents (skipped when resuming from checkpoint)
parallel_mode:    true | false (default true; Type-4 component documents in parallel, Type-1~3/5~8 serially)
```

## Execution steps

### Step 0: Load the methodology

Read `{methodology_dir}/phase2-document-types.md` and load the templates and generation rules for the relevant document types.

### Step 1: Checkpoint check

Check the `completed_docs` list, remove completed items from `component_list`, and obtain `pending_list`.

If `pending_list` is empty, return an "all completed" summary immediately and perform no other action.

### Step 2: Dispatch strategy decision

```
IF component_list consists only of Type-4 component documents AND parallel_mode = true:
  → parallel mode (Step 2A)
ELSE (Type-1/2/3/5/6/7/8 or parallel_mode = false):
  → serial mode (Step 2B)
```

### Step 2A: Parallel mode (Type-4 component documents)

**MANDATORY: you must use the Agent tool; processing components one by one in sequence is forbidden.**

**Step 2A-1: Chunking**

Split `pending_list` into chunks of **3~5 components** each (component documents are large; do not exceed 5 to avoid context overflow).
- Prefer placing components from the same architecture layer in the same chunk (reduces cross-layer code reading contention)
- Skip completed ones (resume from checkpoint)

**Step 2A-2: Start all sub-agents concurrently in a single message**

**Issue all Agent tool calls in the same reply**. This is the only way to run in parallel; issuing them in separate calls degrades to serial execution.

Example (3 chunks concurrently):
```
[Agent tool call 1: chunk ["Aurora", "Frame"], subagent_type="general-purpose"]
[Agent tool call 2: chunk ["CCDB", "VSResource"], subagent_type="general-purpose"]
[Agent tool call 3: chunk ["Dispatcher", "Compute"], subagent_type="general-purpose"]
```

Each sub-agent receives the following prompt (replace CHUNK_COMPONENTS, CHUNK_NUM, TOTAL_CHUNKS):

```
You are the component document generation sub-agent of the wiki skill.
Generate knowledge base documents for the following components (chunk CHUNK_NUM / TOTAL_CHUNKS):
CHUNK_COMPONENTS

Architecture reference (condensed; only the components in this chunk and their direct upstream/downstream):
RELEVANT_COMPONENTS_TABLE
(format: | Component | Architecture layer | Repository | Language | Upstream | Downstream | Entry file |)

Service map (for cross-repository tracing):
SERVICE_MAP_RELEVANT_ENTRIES

Project information:
- repos: REPO_LIST (paths only, no details)
- output_dir: OUTPUT_DIR
- project_name: PROJECT_NAME
- product_docs_dir: PRODUCT_DOCS_DIR (if empty, skip product constraints)

Methodology path: METHODOLOGY_DIR/phase2-document-types.md

For each component:
1. Scan the code with the Glob→Grep→Read three-step method (see kb-doc-generator.md §Step 2: Code structure scanning rules)
2. Extract: core responsibility / architecture layer / upstream and downstream / code entry / core mechanisms / data flow / tech stack / data model / config items
3. Generate a document that follows the Type-4 template and Write it to OUTPUT_DIR/XX_{component}_Design.md
4. Self-check (see the Checklist below)
5. Append each completed component name to OUTPUT_DIR/../_review/_chunk_done_CHUNK_NUM.txt (one per line)

Self-check Checklist (after each document is generated):
- [ ] All 10 dimensions of the AI Quick Reference table filled in and specific (not generic descriptions)?
- [ ] "Code entry" precise to the function name (not just the file name)?
- [ ] search-anchor has 5~15 keywords?
- [ ] Contains a bidirectional link to the main architecture document?
- [ ] Content that cannot be traced is marked [UNVERIFIED]?
- [ ] No empty placeholder sections?

[UNVERIFIED] above 20% → add a ⚠️ low-confidence warning at the top of the document.

Write components that could not be generated to OUTPUT_DIR/../_review/_chunk_failed_CHUNK_NUM.txt with the reason.
```

**Step 2A-3: Wait and collect results**

After all sub-agents finish:
- Check the `_chunk_done_N.txt` files to confirm completion status
- If `_chunk_done_N.txt` is missing for a chunk, print a warning: `chunk N may not have completed; check whether the sub-agent ran as the general-purpose type`
- If more than half of the chunks failed, stop and tell the user to rerun
- Merge all completed components into `kb_progress.components_done` in `progress.json`
- Clean up temporary files: `rm -f _review/_chunk_done_*.txt _review/_chunk_failed_*.txt`

### Step 2B: Serial mode (Type-1~3/5~8)

For each document type in `pending_list`, execute **in sequence** (these document types depend on each other and must be serial):

#### 2B-1: Code structure scanning rules

Use the `Glob → Grep → Read` three-step method (**adapt to the language of the component's repository**):

```
1. Glob: find the entry files of the component's repository (choose the pattern by language)
   Go:         main.go / cmd/*/main.go
   Python:     main.py / app.py / manage.py / wsgi.py
   Java:       *Application.java / *Bootstrap.java / src/main/java/**/Main*.java
   TypeScript: app.ts / index.ts / main.ts / server.ts
   Rust:       main.rs / src/main.rs
   
2. Grep: locate the core Handlers/Routers (choose the pattern by language + framework)
   Go:         grep -rn 'func.*Handler\|\.GET\|\.POST\|router\.\|@handler' <dir>
   Python:     grep -rn '@app\.\|@router\.\|def.*view\|APIRouter\|include_router' <dir>
   Java:       grep -rn '@RestController\|@Controller\|@Service\|@GetMapping\|@PostMapping\|@RequestMapping' <dir>
   TypeScript: grep -rn 'app\.get\|app\.post\|router\.\|@Get\|@Post\|@Controller' <dir>
   Rust:       grep -rn '\.route\|\.get\|\.post\|#\[get\|#\[post\|async fn' <dir>

   ⚠️ Exclude test files: --exclude='*_test.*' --exclude='test_*' --exclude='*_mock.*'
   
3. Read: read the core files (by the directory value rating in architecture_map)
   - ⭐⭐⭐ Must read: business logic layer, core config files, DDL
   - ⭐⭐ Reference: service context initialisation, config files
   - ⭐ Skippable: pure binding layers (usually just parameter pass-through)
   - ✗ Forbidden: generated files (*.pb.go, *_gen.go, *_generated.*, node_modules/, target/, build/)
```

Extract the following information (**everything must cite a code file:line, no inference**):
- Core responsibility (one sentence, <=30 words)
- Architecture layer and upstream/downstream components (communication method: RPC/MQ/DB)
- Code entry (file name -> core function name)
- Core mechanisms (the 1~2 most important technical mechanisms)
- Data flow (where from -> what it passes through -> where to)
- Tech stack (language + framework + middleware)
- Data model (tables involved + key DDL fields)
- Core flows (the steps needed for sequence diagrams)
- Config items (config key + default value + impact scope)
- Scheduled tasks (if any)
- Monitoring metrics (if any)

Mark content that cannot be found in the code as `[UNVERIFIED]`; do not infer.

#### 2B-2: Product documentation extraction (Type-5/6/7, or when product_docs_dir is set)

If `product_docs_dir` is not empty:
```
Scan dimensions (from phase2-document-types.md §Type-5 bridge document generation method):
├── Quantity limits (batch caps, quotas, maximums)
├── Type constraints (enum values, mutual exclusions)
├── State preconditions
├── Billing rules
├── Security constraints
└── Compatibility constraints
```

Trace every product constraint to its validation location in the code (the exact file:line of the `if len() > N`).

#### 2B-3: Document generation

Generate documents following the template for the corresponding type in `phase2-document-types.md`.

**Type-4 component documents must contain (in order)**:

```markdown
# {component} Internal Design
<!-- search-anchor: {full name}, {short name}, {abbreviation}, {synonyms}, {common search terms} -->
> Project: {project_name} | Repository: {repo URL} | Architecture layer: {layer}
> Position in the overall architecture: [📘 {project_name} Technical Architecture - 4.X {component}](./{project_name} Technical Architecture.md#4x-component)

## 🤖 AI Quick Reference
| Dimension | Key information |
|------|---------|
| **Core responsibility** | {<=30 words, specific} |
| **Architecture layer** | {layer name} → {role} |
| **Upstream components** | {ComponentA(RPC)}, {ComponentB(MQ)} |
| **Downstream components** | {ComponentC(RPC)}, {ComponentD(DB)} |
| **Code entry** | `{file name}` → `{core function name}()` |
| **Core mechanisms** | {mechanism 1}; {mechanism 2} |
| **Mutual exclusion** | {concurrency control method, e.g. "distributed lock key: xx"} |
| **Data flow** | {source} → {processing} → {destination} |
| **Tech stack** | {language} + {framework} + {middleware} |
| **Scheduled tasks** | {N scheduled tasks, or "none"} |

## 📋 Project Overview
(numbered list of core responsibilities + ASCII architecture position diagram)

## 🏗️ Architecture Design
(ASCII architecture diagram + core sub-module descriptions + core function signatures)

## 📊 Data Model
(SQL DDL with comments + data flow diagram)

## 🔌 Interface Design
(external/internal interface tables + error code definitions)

## ⚙️ Core Flows
(mermaid sequence diagrams + step descriptions + exception handling)

## 🔧 Configuration
(config item / default value / description / impact scope)

## 📈 Monitoring and Alerting

## 🐛 Common Issues and Troubleshooting

## 📝 Document Change Log
### v1.0 ({date})
- ✅ **Added**: initial version
> Code baseline: {commit_sha} ({tag})
```

**Write all documents under `output_dir`; printing the full content in the conversation before writing the file is forbidden.**

### Step 3: Self-check (accuracy verification + interface reconciliation)

Run after each document is generated; **must not be skipped**:

**Structural completeness**:
- [ ] All 10 dimensions of the AI Quick Reference table filled in, each with specific information (not "see below")?
- [ ] "Code entry" precise to the function name (`file name:line → function()`)?
- [ ] search-anchor has 5~15 keywords, including full and short names and synonyms?
- [ ] Contains a bidirectional link to the main architecture document?
- [ ] No empty placeholder sections (delete sections with no content)?

**Interface reconciliation** (only for components whose interface verification type in architecture_map is not NONE):

Read the component's scanned baseline count `scanned` from `_review/interface-inventory.json` and count the interfaces actually recorded in the document as `documented`:

```
HTTP type:  count the routes listed in the document's ## Interface Design section
MQ type:    count the Topics/Queues/Exchanges explicitly recorded in the document
RPC type:   count the RPC Methods listed in the document
```

Compute the difference: `gap = scanned - documented`

Handling rules:
- `gap = 0`        → ✅ interface coverage complete
- `0 < gap <= 20%`  → ⚠️ minor gap, append `<!-- INTERFACE_GAP: N interfaces possibly missing -->` at the end of the document
- `gap > 20%`      → ❌ mark `[INTERFACE_GAP]`, note it in the summary, recommend supplementing and rerunning

Update the component's `interface_coverage.documented` field in `progress.json`.

**Accuracy statistics** (computed per document and returned to the main agent for aggregation):
```
Method:
  total_claims = business rule count + core flow step count + interface description count + config item count
  verified     = those with a file:line reference
  unverified   = those marked [UNVERIFIED]
  ratio        = unverified / total_claims
```

Handling rules:
- `ratio > 20%` → add `⚠️ Low-confidence warning: {unverified}/{total_claims} items cannot be traced to code` at the top of the document
- `ratio > 40%` → mark **[HIGH_UNVERIFIED]** in the summary and recommend focused manual confirmation

### Step 4: Return summary

Return to the main agent (the main agent accumulates the data into `accuracy_stats` and `interface_coverage` in progress.json):

```
Batch completion summary:
Files read: {N} (estimated token usage: ~{N}k)
Documents generated: {N}

Accuracy statistics:
  Total claims: {N} | Verified: {N} | [UNVERIFIED]: {N} ({X}%)

Interface reconciliation (components with interfaces only):
  ComponentA [HTTP]: documented {M} / baseline {N} = {X}%  ✅/⚠️/❌
  ComponentB [MQ]:   documented {M} / baseline {N} = {X}%  ✅/⚠️/❌

Per-document details:
  - {component}_Design.md: {N}KB, {N} claims, [UNVERIFIED] {N} ({X}%)  [HIGH_UNVERIFIED/INTERFACE_GAP if applicable]

Skipped (already completed): {N}
Issues found: {issue description or "none"}
```

## Output

```
<output_dir>/XX_{component}_Design.md  ← Type-4 component document
<output_dir>/{project_name} Technical Architecture.md  ← Type-1 (if included in this batch)
<output_dir>/{project_name} Business Architecture.md  ← Type-2
<output_dir>/{project_name} Deployment Architecture.md  ← Type-3
<output_dir>/XX_{project_name}_Core_API_Product_Code_Mapping.md  ← Type-5
<output_dir>/XX_{project_name}_Product_Rules_Cheat_Sheet.md  ← Type-6
<output_dir>/XX_{project_name}_Business_Development_SOP.md  ← Type-7
<output_dir>/{knowledge_enhancement_doc}.md  ← Type-8
Returned summary string
```

## Constraints

- **Code is the truth**: every description must cite a code file; unverifiable content must be marked `[UNVERIFIED]`
- **Templates are mandatory**: read the template for the corresponding section before generating each file type
- **No empty documents**: do not create a file without substantive content
- **No redundant output**: Write files directly; do not print the full content in the conversation
- **Naming convention**: component documents use `XX_{component}_Design.md`; XX is assigned in dependency-chain order (lower-layer components get smaller numbers)
- **When no API is provided**: Type-5/6 may skip the product constraint mapping and mark constraint values as `[PRODUCT_DOC_MISSING]`
