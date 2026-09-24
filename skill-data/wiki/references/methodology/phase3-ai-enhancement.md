# Phase 3: AI-Native Enhancement, Making the Knowledge Base Understandable to AI

## 1. AI Quick Reference Table (required in every component document)

The chunk returned by RAG retrieval is usually a fragment of a document. The AI Quick Reference table ensures that no matter which part of the document is retrieved, the AI gets the component's global context from the table at the top.

```markdown
## 🤖 AI Quick Reference

| Dimension | Key Information |
|------|---------|
| **Core Responsibility** | {one sentence, no more than 30 words} |
| **Architecture Layer** | {layer it belongs to} → {role within that layer} |
| **Upstream Components** | {component (communication method)} |
| **Downstream Components** | {component (communication method)} |
| **Code Entry Point** | {entry file} → {core function} |
| **Core Mechanism** | {the 1-2 most important technical mechanisms} |
| **Mutual Exclusion** | {concurrency control method} |
| **Data Flow** | {where it comes from → what it passes through → where it goes} |
| **Tech Stack** | {language + framework + middleware} |
| **Scheduled Jobs** | {N scheduled jobs (brief description of the core ones)} |
```

Rules:
- Every dimension must be **concrete**, never a generic description
- "Code Entry Point" is precise down to `file name → function name`
- "Upstream/Downstream Components" must state the communication method (RPC/MQ/DB)
- The table goes at the very top of the document (immediately after the title)

## 2. Retrieval Routing Rules (required in the main architecture document)

Prevents RAG retrieval from "cross-talk" between internal and external documents:

```markdown
## Knowledge Base Retrieval Routing Guide (AI only)

### Document Category Overview
| Category | Directory | Document Count | Content Nature |
| [Internal, Bridge] Product-Code Mapping | ... | N docs | Core API intent → constraints → call chain |
| [Internal] Component Design Documents | ... | N docs | Architecture design, code entry points |
| [External] Product API Documentation | ... | N docs | Official API reference |

### Retrieval Routing Rules
Rule 1, internal architecture first: involves component names / internal concepts → search internal documents only
Rule 2, external documents apply: involves API parameters / product limits → search external documents
Rule 3, mixed queries: involves both → internal first, supplemented by external
Rule 4, check constraints before writing code: the bridge documents must be searched first

### Document Priority
| Level 1 (core) | Product-Code Mapping + Rules Cheat Sheet | Must check before writing code |
| Level 2 (architecture) | Component Design Documents + main architecture document | Understand internal implementation |
| Level 3 (business) | Business architecture + core call chains | Understand business flows |
| Level 4 (reference) | Raw external API documentation | Only when the above cannot answer |
```

## 3. Search Anchor (semantic retrieval anchor)

Add below the title of every document:

```html
<!-- search-anchor: keyword1, keyword2, synonym, English term, Chinese term -->
```

- Include: Chinese name, English name, abbreviations, synonyms, common search terms
- Count: 5~15
- Example: `<!-- search-anchor: RPC contract, Schema, interface contract, Protobuf, IDL -->`

## 4. Bidirectional Link Weaving

```markdown
# Component document → main architecture document
> Position in the overall architecture: [📘 Technical Architecture - 4.5 {component}](./{project_name} Technical Architecture.md#45-component)

# Main architecture document → component document
See [{component} Design](./XX_{component}_Design.md)

# Bridge document → component document
| [{component}](./XX_{component}_Design.md) | Input validation layer |
```

Weaving rules:
1. Every component document has ≥ 1 link pointing to the main architecture document
2. Every mention of a component in the main architecture document links to the component document
3. Every component mentioned in a bridge document has a link
4. The "Related Components" of anti-pattern documents have links

## 5. QA Pair Generation (AI metadata layer)

Pre-populate high-frequency QA pairs (10~20) in the AI-only section of the main architecture document:

```markdown
- **Q: How is the state machine of the core entity defined?**
  A: See `3.7 Complete Entity State Machine` and `9.2.1 Global State Consistency Mapping Table`.

- **Q: Where are the workflow steps configured? How are exceptions compensated and rolled back?**
  A: N-level orchestration is used. Macro flows are in {config file 1}, fine-grained steps in {config file 2}.

- **Q: What are the message queue topology and routing rules?**
  A: See `9.3.1 MQ Routing Topology`. Core Exchanges/Topics include {list}.

- **Q: What is the resource mutual exclusion (locking) convention?**
  A: See `9.4.4 Distributed Locking and Idempotency Conventions`. {lock scheme} is used.
```

Every A must include a concrete section / document reference.

## 6. Graph Document AI Enhancement Spec

Graph documents are the **relationship index layer** of an AI-Native knowledge base. They specifically solve retrieval failures of RAG in "cross-component relationship query" scenarios.

### 6.1 Required Structure of the Graph Document README

```markdown
# Graph Document Set (Graph RAG)
## Relationship to the Main Document System (three-layer positioning table)
## Document Index (file / size / core content)
## Lookup by Question Type (question type / example / document to consult)
## Suggested Retrieval Routing Rules (keyword → document to search first)
## Maintenance Notes
```

### 6.2 Graph Document AI Quick Reference Table

Every graph document must have this immediately after the title:

```markdown
## 🤖 AI Quick Reference
| Dimension | Key Information |
|------|---------|
| **Document Positioning** | {one-sentence positioning} |
| **Core Value** | {what the AI can do with this document} |
| **Coverage** | {which entities / relationships are covered} |
| **Usage Scenarios** | {typical example questions} |
| **Relationship to the State Machine** | {if applicable: the state machine solves X, this document solves Y} |
```

### 6.3 Embedded AI Reasoning Rules

Constraint-type graph documents must embed the AI reasoning decision flow:

```markdown
## AI Reasoning Rules Quick Reference
> When the AI decides "whether an operation can be executed", check layer by layer in this priority order:

1. **State check** → consult the operation-state constraint matrix
2. **Type check** → consult the special instance type constraint summary
3. **Hardware check** → consult the detailed hardware constraint table
4. **Billing check** → consult the detailed billing constraint table
5. **Quota check** → consult the product rules cheat sheet
6. **Mutual exclusion check** → is there an operation in progress
```

### 6.4 Configuration Change Checklist

For configuration-type graph documents, when the AI answers "how do I change configuration XX" it must also state:

```
1. Config file location: which file / repository it lives in
2. Impact scope: all regions, or a single region / single machine
3. Activation method: hot reload, or restart required
4. Rollback strategy: how to roll back quickly
5. Change risk: 🟢 low / 🟡 medium / 🔴 high
6. Canary recommendation: whether a canary release is needed
```
