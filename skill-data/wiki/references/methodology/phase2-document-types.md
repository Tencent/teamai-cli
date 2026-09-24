# Phase 2: Generation Specs and Templates for the Nine Document Types

## Type-1: Technical Architecture Overview

**Size**: ~200KB | **Count**: 1

### Required Sections

```
Reader navigation guide (recommended reading paths by role)
Knowledge base retrieval routing guide (AI only, 4 routing rules + 4 priority levels)
1. Architecture overview (30-second quick reference table, overall ASCII architecture diagram, component relationship matrix)
2. Three-dimensional architecture views (logical/data/deployment)
3. Core call chains ⭐ (complete sequence diagram + call chain for every core API)
4. Core components in detail (overview + table per component)
5. Configuration management and service discovery
6. Data model and storage architecture ⭐
7. High availability and technical architecture
8. Architecture evolution and design decisions
9. AI development knowledge base spec ⭐ (metadata QA / global state machine / MQ topology / scheduling engine / cross-layer tracing)
Appendix: code repositories / glossary / code entry index / error codes
```

### Generation Rules
- T1-R01: must include a reader navigation guide
- T1-R02: must include AI retrieval routing rules
- T1-R03: core call chains must have sequence diagrams
- T1-R04: the component table must include a code repository column
- T1-R05: the glossary must include external-to-internal mappings
- T1-R06: must have an AI-only chapter 9
- T1-R07: architecture diagrams use ASCII Art

---

## Type-2: Business Architecture Document

**Size**: ~70KB | **Count**: 1

```
1. Product capability matrix (capability domain / sub-capability / corresponding API / billing impact)
2. Billing model in detail (mode comparison / state machine / refund and renewal rules)
3. Core entity lifecycle (complete state machine / operations allowed per state / mutual exclusion rules)
4. Core business flows (user-perspective sequence diagram + preconditions + exception handling)
5. Product specification system (naming rules / mapping from specs to underlying resources)
```

---

## Type-3: Deployment Architecture Document

**Size**: ~40KB | **Count**: 1

```
1. Layered deployment architecture diagram
2. Service deployment matrix (service name / deployment method / instance count / resource config / dependencies)
3. Environment configuration (production / test / difference comparison)
4. Deployment process and change management
```

---

## Type-4: Component Design Document (Core Output)

**Size**: 20~100KB each | **Count**: N (one per component)

### Standard Template

```
# {component} Internal Design
<!-- search-anchor: component name, aliases, core keywords -->
> Project name / version / code repository / code size
> Position in the overall architecture: [📘 link to the Technical Architecture document]

## 🤖 AI Quick Reference
(10-dimension structured summary, detailed definition in [phase3-ai-enhancement.md §1](phase3-ai-enhancement.md))

## 📋 Project Overview (core responsibilities + position in the architecture)
## 🏗️ Architecture Design (ASCII architecture diagram + core sub-modules, function signatures)
## 📊 Data Model (SQL DDL with comments + data flow diagram)
## 🔌 Interface Design (external interface table + internal interfaces + error codes)
## ⚙️ Core Flows (sequence diagram + step descriptions + exception handling)
## 🔧 Configuration (config item / default / description / impact scope)
## 📈 Monitoring and Alerting
## 🐛 Common Issues and Troubleshooting
```

### Generation Rules
- T4-R01: must have an AI Quick Reference table
- T4-R02: must have bidirectional links to the Technical Architecture document
- T4-R03: core functions must list their signatures
- T4-R04: SQL DDL must include comments
- T4-R05: config items must state their impact scope
- T4-R06: architecture diagrams use ASCII Art
- T4-R07: code entries must be precise to the function name

### Steps for Generating from Code

> The detailed execution spec is in `{SKILL_DIR}/references/agents/kb-doc-generator.md`; only the outline is listed here:
> 1. Code structure scan (three-step Glob → Grep → Read, adapted per language)
> 2. Information extraction (10 dimensions: core responsibilities / architecture layer / upstream and downstream / code entries / core mechanisms / data flow / tech stack / data model / config items / scheduled tasks)
> 3. Document assembly (in the section order of the template above)
> 4. Self-check (accuracy statistics + interface reconciliation)

---

## Type-5: Product-to-Code Mapping (Bridge Document)

### One Section per Core API

```
### N.1 User intent (one sentence)
### N.2 Product constraints (constraint / value / affected components / validation location)
### N.3 User-visible state transitions (ASCII diagram + internal state mapping)
### N.4 Internal call chain (standard format, precise to the code file)
### N.5 Must-consider items when writing code (numbered list of hard constraints)
### N.6 Error codes and internal exception mapping (external code / internal component / meaning)
```

### Generation Rules
- T5-R01: the constraint table must state the "affected components" and "validation location"
- T5-R02: call chains must be precise to the code file path
- T5-R03: state transitions must be annotated with the internal state code mapping
- T5-R04: "Must-consider items when writing code" is a mandatory section
- T5-R05: error code mappings must include the owning internal component

### Bridge Document Generation Method (3 Steps)

**Step 1: Extract product constraints**. From the product docs, extract every constraint that affects the code implementation:

```
Scan dimensions:
├── Quantity limits (batch caps, quotas, maximums)
├── Type constraints (enum values, mutual exclusion)
├── State preconditions (what state a resource must be in before an operation)
├── Billing rules (different handling per billing mode)
├── Security constraints (auth, encryption, data masking)
└── Compatibility constraints (type compatibility, version compatibility, regional limits)
```

**Step 2: Map to code locations**. For each product constraint, trace to the concrete validation location in the code:

```
Product constraint: "{API name} batch cap N"
  ↓ trace
Code location: {API gateway component} → {file path} → validate_params()
  ↓ confirm
Validation: if len(resource_ids) > N: raise InvalidParameterValue
```

**Step 3: Build the mapping table**. Assemble the information above into the standard product-to-code mapping table (see the Type-5 template).

**Bridge document quality criteria**:

| Quality dimension | Standard | Check method |
|---------|------|---------|
| **Completeness** | Every core API has a mapping | Check one by one against the API list |
| **Precision** | Code paths are precise to file and function | Open the code and verify |
| **Consistency** | Constraint values match the product docs | Cross-check against the product docs |
| **Freshness** | In sync with the latest code version | Periodic diff check |

---

## Type-6: Product Rules Cheat Sheet

```
## N. {rule category}
| Rule | Constraint value | Affected components | Validation location | Source document |

## State and Operation Mutual Exclusion Rules
| Current state | Allowed operations | Forbidden operations |
```

- T6-R01: every rule must state the "affected components"
- T6-R02: constraint values must be exact numbers
- T6-R03: must have a "source document" column
- T6-R04: state mutual exclusion rules must be a complete matrix

---

## Type-7: Business Development SOP

```
1. Why a standard code template is needed (the problem of unmanaged code)
2. Core conventions (never expose low-level errors externally / pass Context all the way down / validate parameters up front)
3. Standard Handler code template (copy-ready, annotated with "AI coding iron rules")
4. Error code mapping table (scenario described in AI reasoning terms / recommended error code / Message)
5. AI review checklist (machine-checkable)
```

- T7-R01: code templates must be directly copyable and runnable
- T7-R02: every key comment is annotated with "AI coding iron rule"
- T7-R03: the error code table uses "the AI's reasoning" as the scenario description

---

## Type-8: Knowledge Enhancement Documents

### Type-8a: Product Knowledge Library
Marked `type: bridge`; tables compare easily confused concepts and include "code parameter example" and "architecture and business impact" columns.

### Type-8b: Anti-Patterns and Pitfalls Guide
Five-part structure: **trigger scenario → faulty behavior → root cause analysis → correct approach → related components**
The overview table records number / category / severity (P0 fatal / P1 severe / P2 important) / related components.

### Type-8c: RPC Interface Contracts
Struct definitions with serialization tags + required/optional markers + AI coding contract requirements.

### Type-8d: Troubleshooting Case Records (Memorix)
Structure: symptom → investigation process (Step N) → root cause → fix → lessons learned → related documents.

---

## Type-9: Graph Document Set (Graph RAG)

**Size**: 10~30KB each | **Count**: 5~10 | **Directory**: `graph/`

> Extracts the **cross-component relationship information** scattered across N component documents into a structured index, solving the "scattered information" problem RAG retrieval hits on relationship queries.

### Graph Document Type List

| ID | Document name | Core content | Retrieval pain point solved |
|------|--------|---------|--------------|
| G1 | Component Dependency Matrix | N×N communication matrix + forward/reverse dependency index + external service dependencies | "Who depends on X?" requires traversing every document |
| G2 | Component Call Chain Overview | End-to-end core API chains + read/write separation mechanism + **complete state machine diagram** + operation-state constraint matrix | "Which modules does the API pass through?" information is scattered |
| G3 | Data Flow and Storage Dependencies | Storage dependency matrix + MQ queue topology + cache strategy | "Where is the data stored?" |
| G4 | Error Code Component Map | Error code range allocation + external → internal mapping | "Which module owns this error code?" |
| G5 | Cross-Component Interaction Scenarios | mermaid sequence diagrams for ≥10 scenarios + exception handling | "How is the quota check done?" |
| G6 | Knowledge Graph Triples | (S, P, O) triples + multi-hop dependency path index | "Who does A depend on indirectly?" |
| G7 | Architecture Risks and Impact Analysis | Blast radius + cluster analysis + critical paths/bottlenecks | "How big is the impact if X goes down?" |
| G8 | **Core Config Parameter Index** | Layered config item → behavior impact mapping + change impact surface quick lookup | "How do I change config XX?" |
| G9 | **Business Rule Constraint Matrix** | Operation preconditions + hardware/migration/billing constraints + AI reasoning decision tree | "Can XX be done?" |

### Graph Document Generation Rules

- T9-R01: every graph document must have a `🤖 AI Quick Reference` table
- T9-R02: every graph document must have a `<!-- search-anchor: ... -->` anchor
- T9-R03: the graph directory must have a `README.md` index with a "lookup by question type" table and "retrieval routing rule suggestions"
- T9-R04: state machines must use the mermaid `stateDiagram-v2` format
- T9-R05: constraint decision trees must use the mermaid `graph TD` format
- T9-R06: operation-state constraints must be in ✅/❌ matrix format
- T9-R07: config parameters must state "behavior impact", "change risk" (🟢 low / 🟡 medium / 🔴 high), and "activation" (hot reload / restart required)
- T9-R08: business rule constraints must include an AI reasoning check flow (mermaid flowchart)
- T9-R09: triples must follow the standard (Subject, Predicate, Object) format
- T9-R10: graph documents **do not replace** component documents; they provide a **structured index from the relationship perspective**

### Graph Document Generation Method

**Step 1: Relationship extraction**. Extract cross-component relationships from the N component documents:

```
Scan dimensions:
├── Call relationships (A calls B, protocol, scenario)
├── Data dependencies (A reads/writes B, data content)
├── Message topology (A publishes_to/consumes_from Queue)
├── State transitions (operation → initial state → intermediate state → final state)
├── Constraints (operation → preconditions → hardware/billing/quota constraints)
├── Config mapping (config item → behavior impact → change risk)
└── Error code ownership (error code range → component → investigation direction)
```

**Step 2: Structured modeling**. Convert the extracted relationships into standard formats:

```
Relationship matrix → N×N table
Call chains → end-to-end text chain + mermaid sequence diagram
State machine → mermaid stateDiagram-v2
Constraint rules → decision tree (mermaid graph TD) + summary table
Config index → layered table (config item / default / behavior impact / change risk / activation)
Triples → (Subject, Predicate, Object, Protocol, Scenario) table
```

**Step 3: Index weaving**. Build cross-references and retrieval routing between the graph documents:

```
README.md:
├── Document directory table (file / size / core content)
├── Lookup-by-question-type table (question type / example / document to consult)
└── Retrieval routing rule suggestions (keyword → document to search first)
```

### Key Templates

#### State Machine Diagram Template

```markdown
## Complete Instance State Machine Diagram

### Core State Transition Diagram
​```mermaid
stateDiagram-v2
    [*] --> PENDING: CreateAction
    PENDING --> RUNNING: creation succeeded (flag: 2→1)
    RUNNING --> STOPPING: StopAction (flag: 1→8)
    STOPPING --> STOPPED: shutdown succeeded (flag: 8→3)
    ...
​```

### Operation-State Constraint Quick Lookup Matrix
| Operation \ Current state | RUNNING | STOPPED | PENDING | ... |
|---------------|:-------:|:-------:|:-------:|:---:|
| **Start** | ❌ | ✅ | ❌ | ... |
| **Stop** | ✅ | ❌ | ❌ | ... |
```

#### Business Rule Constraint Matrix Template

```markdown
## Operation Precondition Matrix
| Operation | State requirement | Hardware constraint | Billing constraint | Quota constraint | Other constraints |

## Migration Constraint Decision Tree
​```mermaid
graph TD
    A[Migration request] --> B{Hardware constraint 1?}
    B -->|Yes| C["❌ Forbidden"]
    B -->|No| D{Hardware constraint 2?}
    ...
​```

## AI Reasoning Rules Quick Lookup
​```mermaid
graph TD
    A["User asks: can XX be executed?"] --> B["Step 1: state check"]
    B --> B1{"Look up the operation-state constraint matrix"}
    B1 -->|❌| Z1["No, the state does not allow it"]
    B1 -->|✅| C["Step 2: type check"]
    ...
​```
```

#### Config Parameter Index Template

```markdown
## {component layer} Config Parameters
| Config item | Default | Behavior impact | Change risk | Activation |
|--------|--------|---------|---------|---------|
| `config.key` | value | description | 🟢 low / 🟡 medium / 🔴 high | hot reload / restart required |

## Config Change Impact Surface Quick Lookup
| Change type | Impact scope | Activation | Rollback strategy | Change risk |
```
