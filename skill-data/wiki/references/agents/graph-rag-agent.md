# Graph RAG Agent

## Responsibility

Extract cross-component relationship information from the generated knowledge base component documents and produce a structured graph document set (G1~G9), solving the information-scattering problem RAG retrieval faces in "cross-component relationship query" scenarios.

**This agent is started once, serially, by the main agent in Phase K3.**

## Input package

```
all_kb_docs_dir:  knowledge base output root directory (contains all Type-1~8 documents)
architecture_map: full content of _review/k1-architecture-map.md
doc_list:         _review/k2-doc-list.md (document list)
project_name:     project name (used for document naming)
output_dir:       graph document output directory (<all_kb_docs_dir>/graph/)
methodology_file: {SKILL_DIR}/references/methodology/phase2-document-types.md, §Type-9 content
```

## Execution steps

### Step 1: Relationship extraction

Scan all component documents (Type-4) under `all_kb_docs_dir` and extract from the AI Quick Reference table and the body:

```
Scan dimensions:
├── Call relationships (upstream component -> this component, this component -> downstream component, communication method)
├── Storage dependencies (which DB/Redis/MQ are read/written)
├── Message topology (published/consumed Exchange/Topic/Queue/RoutingKey)
├── State transitions (operation -> start state -> intermediate state -> final state, state field values)
├── Constraints (operation -> state prerequisites -> hardware constraints -> billing constraints -> quota)
├── Config mapping (config item -> affected behavior -> change risk)
└── Error code ownership (error code range -> component -> troubleshooting direction)
```

**Three-state confidence labelling** (every relationship/triple must be labelled, no omissions):

| Label | Meaning | Evidence basis | Confidence score |
|------|------|---------|-----------|
| `EXTRACTED` | Relationship explicitly described in a component document (e.g. "Upstream component: Aurora(RPC)") | Explicitly recorded in code/docs | 1.0 |
| `INFERRED` | Reasonably inferred relationship (e.g. a dependency chain implied by an architecture diagram) | Structural evidence + reasonable inference | 0.6~0.9 |
| `AMBIGUOUS` | Uncertain relationship, needs manual confirmation | Weak or contradictory evidence | 0.1~0.3 |

> ⚠️ **Never use 0.5 as a default score**. Evaluate every relationship independently: INFERRED with a direct code reference gets 0.8~0.9, inference based only on naming gets 0.6~0.7, and only genuinely unclear cases use AMBIGUOUS.

Build intermediate data structures (in memory, do not write files):
- `relations[]`: (from, to, protocol, scenario, **confidence: EXTRACTED|INFERRED|AMBIGUOUS**, **confidence_score: 0.1~1.0**)
- `state_transitions[]`: (entity, from_state, to_state, trigger_op, state_field_value, **confidence**, **confidence_score**)
- `constraints[]`: (operation, state_req, hardware_req, billing_req, quota_req, **confidence**, **confidence_score**)
- `config_items[]`: (key, default, component, behavior, change_risk, effect_mode)
- `error_codes[]`: (code_range, component, meaning, debug_direction)
- `triples[]`: (subject, predicate, object, protocol, scenario, **confidence: EXTRACTED|INFERRED|AMBIGUOUS**, **confidence_score: 0.1~1.0**)

### Step 2: Generate graph documents one by one

Generate G1~G9 in order (serially, Write each one as soon as it is complete):

---

#### G1: Component Dependency Matrix

```markdown
# {project_name} Component Dependency Matrix
<!-- search-anchor: component dependencies, dependency matrix, communication method, call relationships -->
## 🤖 AI Quick Reference
| Document scope | Answers the retrieval question "who depends on X? what does X depend on?" |
| Core value | N×N communication matrix + forward/reverse dependency index |
| Use cases | Change impact assessment, service dependency review, architecture refactoring planning |

## N×N component communication matrix
(rows: caller, columns: callee, values: `RPC`/`MQ`/`DB`/`—`, confidence label in brackets)
Example: `RPC[E]` = EXTRACTED, `MQ[I:0.8]` = INFERRED 0.8, `RPC[A]` = AMBIGUOUS

## Forward dependency index (what A depends on)
| Component | Depends on | Communication method | Confidence | Typical scenario |

## Reverse dependency index (who depends on A)
| Component | Depended on by | Communication method | Confidence | Typical scenario |

## External service dependencies
| External service | Depended on by which components | Communication method | Confidence | Degradation strategy |

## Confidence statistics
| Label | Count | Notes |
|------|------|------|
| EXTRACTED | N | Directly described in code/docs |
| INFERRED | N | Reasonable inference, scored 0.6~0.9 |
| AMBIGUOUS | N | Uncertain, needs manual confirmation |
```

---

#### G2: Component Call Chain Overview + state machines

```markdown
# {project_name} Component Call Chain Overview and State Machines
<!-- search-anchor: call chain, state machine, end-to-end chain, API chain -->
## 🤖 AI Quick Reference
| Document scope | Answers the retrieval question "which modules does API X pass through? how do entity states transition?" |
| Core value | End-to-end chains of core APIs + complete state machines + operation-state constraint matrix |

## Core API end-to-end call chains
(for each core API, use the standard call chain format + a mermaid sequence diagram)

## Complete state machines of core entities
(mermaid stateDiagram-v2, annotated with state field values and triggering operations)

## Operation-state constraint quick matrix
| Operation \ Current state | State A | State B | ... |
(✅ allowed / ❌ forbidden / ⚠️ conditional)

## AI state-judgement reasoning rules
(mermaid graph TD decision tree)
```

---

#### G3: Data Flow and Storage Dependencies

```markdown
# {project_name} Data Flow and Storage Dependencies
<!-- search-anchor: data flow, storage dependencies, MQ topology, cache -->
## Storage system dependency matrix
| Component | MySQL | Redis | MQ | Object storage | Other |

## MQ queue topology
| Exchange/Topic | Routing Key | Producer | Consumer | Message meaning |

## Cache strategy matrix
| Component | Cache key pattern | TTL | Invalidation strategy |
```

---

#### G4: Error Code Component Map

```markdown
# {project_name} Error Code Component Map
<!-- search-anchor: error code, error mapping, InvalidParameter -->
## Error code range allocation
| Error code range/prefix | Owning component | Meaning scope |

## External -> internal error code mapping
| External error code | Internal component | Internal meaning | Troubleshooting direction |
```

---

#### G5: Cross-Component Interaction Scenarios

For each core business scenario, generate:
```markdown
## Scenario N: {scenario name}
<!-- typical scenarios: create/delete/modify resources, quota checks, billing, state changes, etc. -->
```mermaid
sequenceDiagram
    actor User
    participant A as {ComponentA}
    participant B as {ComponentB}
    ...
```
**Normal flow**: step descriptions
**Exception handling**: each exception branch
```

Requirement: >=10 scenarios, covering the main write operations and key read operations.

---

#### G6: Knowledge Graph Triples

```markdown
# {project_name} Knowledge Graph Triples
<!-- search-anchor: knowledge graph, triples, multi-hop reasoning -->

## Ontology definition
### Entity types: Service, Handler, Config, Table, Queue, API, ErrorCode
### Relationship types: CALLS, PUBLISHES, CONSUMES, READS, WRITES, CONFIGURES, MAPS_TO

## Explicit triples (>=100)
| Subject | Predicate | Object | Protocol/Scenario | Confidence | Score |

> Every triple's Confidence must be `EXTRACTED` / `INFERRED` / `AMBIGUOUS`; Score must not be omitted and must not default to 0.5.

## Multi-hop dependency path index
| Query pattern | Example path |
| "Which tables does A ultimately write to?" | A→(CALLS)→B→(WRITES)→Table |

## Reverse reachability index
| Target node | Reachable paths |
```

---

#### G7: Architecture Risks and Impact Analysis

```markdown
# {project_name} Architecture Risks and Impact Analysis
<!-- search-anchor: architecture risk, blast radius, impact surface -->
## Component risk level summary
| Component | Risk level | Blast radius | Notes |
(🔴 high / 🟡 medium / 🟢 low)

## Blast radius analysis of key components (>=3 high-risk components)
Impact chain analysis when component X fails

## Critical paths and bottleneck identification
## Cluster analysis (which components form tightly coupled clusters)
## Change risk assessment matrix
```

---

#### G8: Core Config Parameter Index

```markdown
# {project_name} Core Config Parameter Index
<!-- search-anchor: config parameters, config index, config changes -->
## Layered configuration architecture diagram (mermaid)

## Config parameter tables per layer
| Config item | Owning component | Default | Affected behavior | Change risk | Effect mode |
(change risk: 🟢 low / 🟡 medium / 🔴 high; effect mode: hot reload / restart required)

## Config change impact quick reference
| Change type | Impact scope | Effect mode | Rollback strategy |

## When answering "how do I change config XX", the AI must always state:
1. Config file location
2. Impact scope
3. Effect mode
4. Rollback strategy
5. Change risk
6. Whether a canary rollout is needed
```

---

#### G9: Business Rule Constraint Matrix

```markdown
# {project_name} Business Rule Constraint Matrix
<!-- search-anchor: business rules, constraint matrix, operation constraints, AI reasoning -->
## Operation precondition matrix
| Operation | State requirement | Hardware constraint | Billing constraint | Quota constraint | Other constraints |

## Constraint decision tree (mermaid graph TD)
(covers the multi-layer constraint check flow of the main operations)

## Special instance type constraint summary
| Instance/resource type | Restricted operations | Reason |
(✅ allowed / ❌ forbidden / ⚠️ conditional)

## AI reasoning rules quick reference
(mermaid flowchart: the layer-by-layer check order the AI follows when judging "can operation X be performed")
```

---

### Step 3: Generate the graph directory README

Write to `{output_dir}/README.md`:
```markdown
# {project_name} Graph Document Set (Graph RAG)
<!-- search-anchor: graph documents, Graph RAG, relationship index -->

## Relationship to the main document system
(graph documents do not replace component documents; they provide a structured index from the relationship perspective)

## Document directory
| File | Size | Core content |

## Look up by question type
| Question type | Example question | Document to consult |
| Dependencies | "Who depends on X?" | G1 Component Dependency Matrix |
| Call chains | "Which modules does API X pass through?" | G2 Call Chain Overview |
| Data location | "Where is the data stored?" | G3 Data Flow and Storage Dependencies |
| Error troubleshooting | "Which module does error code XXX belong to?" | G4 Error Code Component Map |
| Scenario handbook | "What is the full quota check flow?" | G5 Cross-Component Interaction Scenarios |
| Multi-hop reasoning | "What does A indirectly depend on?" | G6 Knowledge Graph Triples |
| Risk assessment | "How big is the impact if X goes down?" | G7 Architecture Risks and Impact Analysis |
| Config changes | "How do I change config XX?" | G8 Core Config Parameter Index |
| Operation constraints | "Can I do XX?" | G9 Business Rule Constraint Matrix |

## Suggested retrieval routing rules
(keyword -> document to search first)

## Maintenance notes
(when and how far graph documents must be updated after component documents change)
```

### Step 4: Return summary

```
Graph RAG generation complete:
Generated documents: G1~G9, 9 in total + README
  - G1_Component_Dependency_Matrix.md: {N}KB, {N} components, {N} relationships
      Confidence: EXTRACTED {N} / INFERRED {N} / AMBIGUOUS {N}
  - G2_Component_Call_Chain_Overview.md: {N}KB, {N} call chains, {N} state machine states
  - G3_Data_Flow_and_Storage_Dependencies.md: {N}KB
  - G4_Error_Code_Component_Map.md: {N}KB, {N} error code ranges
  - G5_Cross_Component_Interaction_Scenarios.md: {N}KB, {N} scenario sequence diagrams
  - G6_Knowledge_Graph_Triples.md: {N}KB, {N} triples
      Confidence: EXTRACTED {N} / INFERRED {N} / AMBIGUOUS {N}
  - G7_Architecture_Risks_and_Impact_Analysis.md: {N}KB
  - G8_Core_Config_Parameter_Index.md: {N}KB, {N} config items
  - G9_Business_Rule_Constraint_Matrix.md: {N}KB
AMBIGUOUS entries summary (need manual confirmation): {N} places
  - Example: "Aurora→Compute communication method uncertain (not specified in docs) [A:0.2]"
Issues found: {issues or "none"}

⚠️ Note to the main agent: once Graph RAG is complete, immediately run Phase K3 Step 3 (cross-document consistency check).
```

## Output

```
<output_dir>/README.md
<output_dir>/G1_{project_name}_Component_Dependency_Matrix.md
<output_dir>/G2_{project_name}_Component_Call_Chain_Overview.md
<output_dir>/G3_{project_name}_Data_Flow_and_Storage_Dependencies.md
<output_dir>/G4_{project_name}_Error_Code_Component_Map.md
<output_dir>/G5_{project_name}_Cross_Component_Interaction_Scenarios.md
<output_dir>/G6_{project_name}_Knowledge_Graph_Triples.md
<output_dir>/G7_{project_name}_Architecture_Risks_and_Impact_Analysis.md
<output_dir>/G8_{project_name}_Core_Config_Parameter_Index.md
<output_dir>/G9_{project_name}_Business_Rule_Constraint_Matrix.md
Returned summary string
```

## Constraints

- **Component documents are the sole source for relationship extraction**: do not read the raw code directly, to avoid inconsistency with the Phase K2 output
- **Three-state confidence is mandatory**: every relationship/triple must be labelled `EXTRACTED`/`INFERRED`/`AMBIGUOUS`, no omissions
- **Never use 0.5 as the default confidence**: score every relationship independently; INFERRED with direct structural evidence 0.8~0.9, naming-based inference 0.6~0.7, weak evidence 0.4~0.5; AMBIGUOUS uses 0.1~0.3
- **Never invent relationships**: if the component documents provide no basis, label it AMBIGUOUS rather than fabricating EXTRACTED
- **Every graph document must have an AI Quick Reference table**
- **Every graph document must have a search-anchor**
- **Graph documents do not replace component documents**: they only provide a structured index from the relationship perspective
- **State machines must use mermaid stateDiagram-v2**
- **Constraint decision trees must use mermaid graph TD**
- **Triples must follow the (Subject, Predicate, Object, Confidence, Score) format**
- **Operation-state constraints must be in ✅/❌/⚠️ matrix format**
