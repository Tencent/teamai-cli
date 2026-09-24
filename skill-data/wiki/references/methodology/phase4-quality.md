# Phase 4: Quality Assessment and Iterative Improvement

> Helper tool: `python3 "{SKILL_DIR}/scripts/validate_kb.py" <output_dir>` automatically checks link integrity, anchor coverage, AI Quick Reference table coverage, bidirectional links, and README index inclusion rate

## Five-Dimension Assessment Model

| Dimension | Weight | Passing standard |
|------|------|---------|
| **Coverage** | 25% | ≥ 90% of core components are documented |
| **Depth** | 25% | ≥ 80% of code entries can be located directly |
| **Consistency** | 20% | 0 dead links, 0 contradictory descriptions |
| **AI usability** | 20% | RAG retrieval accuracy ≥ 85% |
| **Freshness** | 10% | Core document update lag ≤ 30 days |

## Coverage Check

```
□ Does every code repository have a corresponding component design document?
□ Does every core API have a product-to-code mapping?
□ Does every data table have a schema description in some document?
□ Is every MQ Exchange/Topic/Queue marked in the topology diagram?
□ Is every error code in the mapping table?
□ Is every config item in the configuration description?
□ Is every scheduled task described in some document?
```

## RAG Retrieval Test Cases

| Test type | Example question | Expected hit |
|---------|---------|---------|
| Component location | "Where is the code entry of {component}?" | Component design document |
| Flow tracing | "What is the internal call chain of {API name}?" | Product-to-code mapping |
| Constraint query | "What is the batch cap of {operation}?" | Rules cheat sheet |
| State query | "Which operations can be executed in state {state}?" | State mutual exclusion rules |
| Error investigation | "How do I investigate {error code}?" | Anti-patterns / troubleshooting records |
| Code generation | "Write a Handler for {feature}" | SOP + interface contracts |
| Concept disambiguation | "What is the difference between {A} and {B}?" | Product knowledge library |

## Incremental Update Trigger Table

| Trigger condition | Update action |
|---------|---------|
| New code repository | Generate a Type-4 component document |
| API interface change | Update the Type-5 mapping + Type-6 cheat sheet |
| New product feature | Update the Type-2 business architecture + Type-8a knowledge library |
| Production incident | Add a Type-8d troubleshooting record + update Type-8b anti-patterns |
| Architecture refactoring | Update the Type-1 architecture overview + affected Type-4 documents |
| Config change | Update the configuration section of the corresponding component document |

## Version Management Convention

Maintain a change log at the bottom of every document:

```markdown
## 📝 Document Change Log

### vX.Y (YYYY-MM-DD)
- ✅ **Added**: {description of added content}
- ✅ **Fixed**: {description of fixed content}
- ✅ **Updated**: {description of updated content}
- ⚠️ **Deprecated**: {description of deprecated content}
```

## Fixing Common Quality Issues

| Issue | Fix method |
|------|---------|
| Dead links | Grep `](` links globally, or run `python3 "{SKILL_DIR}/scripts/validate_kb.py" <output_dir>` |
| Inconsistent terminology | Build a glossary and replace globally |
| Outdated code entries | Diff against the code repositories periodically |
| Outdated constraint values | Cross-check against the product docs periodically |
| AI retrieval failures | Add search-anchor keywords |
| Isolated documents | Add bidirectional links |

---

## Complete Generation Pipeline Checklist

### Phase 0 Checklist: Source Material Collection

```
□ All core code repositories cloned
□ Product API docs collected (interface name / inputs / outputs / error codes)
□ Product usage docs collected (usage limits / FAQ / billing description)
□ Database schema extracted (DDL / table schemas)
□ Workflow orchestration configs extracted (workflow_config etc.)
□ Proto/IDL files extracted
□ Error code definitions extracted
```

### Phase 1 Checklist: Architecture Reverse-Engineering

```
□ Code knowledge graph built (nodes + edges)
□ Architecture layers determined (≥4 layers)
□ Component relationship matrix built (N×N)
□ Core call chains traced (≥5 core APIs)
□ MQ topology inferred (Exchange/Topic/Queue/Routing Key)
□ Database ER model built
□ Glossary compiled (external-to-internal mappings)
```

### Phase 2 Checklist: Document Generation

```
□ [Type-1] Technical architecture overview document (1)
  □ Includes the reader navigation guide
  □ Includes AI retrieval routing rules
  □ Includes core call chain sequence diagrams (≥5)
  □ Includes the component relationship matrix
  □ Includes the AI-only chapter 9
  □ Includes the glossary

□ [Type-2] Business architecture document (1)
  □ Includes the product capability matrix
  □ Includes the billing model (if applicable)
  □ Includes the core entity lifecycle state machine

□ [Type-3] Deployment architecture document (1)
  □ Includes the service deployment matrix
  □ Includes environment configuration

□ [Type-4] Component design documents (N)
  □ Each includes an AI Quick Reference table
  □ Each includes bidirectional links
  □ Each includes code entries (precise to the function)
  □ Each includes an architecture diagram (ASCII Art)
  □ Each includes core flow descriptions

□ [Type-5] Product-to-code mapping document
  □ Covers all core APIs
  □ Each API includes a constraint table
  □ Each API includes a call chain
  □ Each API includes an error code mapping

□ [Type-6] Product rules cheat sheet
  □ Covers all rule categories
  □ Constraint values are exact
  □ Includes the state mutual exclusion matrix

□ [Type-7] Business development SOP
  □ Includes runnable code templates
  □ Includes the error code mapping table
  □ Includes the AI review checklist

□ [Type-8] Knowledge enhancement documents
  □ [8a] Product knowledge library (concept disambiguation)
  □ [8b] Anti-patterns and pitfalls guide
  □ [8c] RPC interface contracts
  □ [8d] Troubleshooting case records
```

### Phase 3 Checklist: AI-Native Enhancement

```
□ All component documents include an AI Quick Reference table
□ The Technical Architecture document includes retrieval routing rules
□ All documents include a search-anchor
□ Bidirectional link network complete (0 dead links)
□ QA pairs generated (10~20)
□ Document priorities defined
```

### Phase 3b Checklist: Graph Document Set (Graph RAG)

```
□ [G1] Component Dependency Matrix
  □ N×N communication matrix complete
  □ Forward/reverse dependency index
  □ External service dependencies

□ [G2] Component Call Chain Overview + state machine
  □ End-to-end core API chains (read + write)
  □ Complete mermaid state machine diagram
  □ Core state field value transition path table (if internal state codes exist)
  □ User-visible state ↔ internal state mapping (if multi-layer states exist)
  □ Operation-state constraint quick lookup matrix (✅/❌)
  □ AI state reasoning rules

□ [G3] Data Flow and Storage Dependencies
  □ Storage system dependency matrix
  □ MQ queue topology
  □ Cache strategy matrix

□ [G4] Error Code Component Map
  □ Error code range allocation table
  □ External → internal error code mapping

□ [G5] Cross-Component Interaction Scenarios
  □ mermaid sequence diagrams for ≥10 scenarios
  □ Every scenario has exception handling

□ [G6] Knowledge Graph Triples
  □ Ontology definition (entity types + relationship types)
  □ ≥100 explicit triples
  □ Multi-hop dependency path index
  □ Reverse reachability index

□ [G7] Architecture Risks and Impact Analysis
  □ Component risk level summary table
  □ Blast radius analysis (≥3 key components)
  □ Cluster analysis
  □ Change risk assessment matrix

□ [G8] Core Config Parameter Index
  □ Layered config architecture diagram (mermaid)
  □ Config parameter table per layer (config item / default / behavior impact / change risk / activation)
  □ Config change impact surface quick lookup matrix

□ [G9] Business Rule Constraint Matrix
  □ Operation precondition matrix
  □ Detailed hardware constraint table
  □ Migration constraint decision tree (mermaid)
  □ Detailed billing constraint table
  □ Special instance type constraint summary (✅/❌/⚠️)
  □ AI reasoning rules quick lookup (mermaid flowchart)

□ Graph directory README.md index complete
  □ Lookup-by-question-type table
  □ Retrieval routing rule suggestions
```

### Phase 4 Checklist: Quality Assessment

```
□ Coverage ≥ 90%
□ Code entry precision ≥ 80%
□ Dead links = 0 (confirm by running validate_kb.py)
□ RAG retrieval accuracy ≥ 85%
□ Core document update lag ≤ 30 days
□ Terminology consistency check passed
```
