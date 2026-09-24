## Phase K3: AI-Native Enhancement + Graph Document Set

**Methodology**: `{SKILL_DIR}/references/methodology/phase3-ai-enhancement.md`

### Step 1: Inject AI-Native elements

Add to all generated documents (where the Phase K2 Agent did not add them completely):

| Element | Requirement | Scope |
|------|------|---------|
| `search-anchor` | 5~15 keywords, first line after the title | All documents |
| AI Quick Reference table | 10 dimensions, immediately after the title | All Type-4 component documents |
| Bidirectional links | component ↔ main architecture, bridge ↔ component | All documents |
| Retrieval routing rules | 4 routing rules + 4 priority levels | Technical architecture overview only |
| QA pairs | 10~20 high-frequency questions + answer references | Chapter 9 of the technical architecture overview only |

### Step 2: Graph RAG graph document set

Read `{SKILL_DIR}/references/agents/graph-rag-agent.md`, assemble the input package and launch:

```
all_kb_docs_dir:  <output_dir>
architecture_map: _review/k1-architecture-map.md
doc_list:         _review/k2-doc-list.md
project_name:     <Phase 0>
output_dir:       <output_dir>/graph/
methodology_file: {SKILL_DIR}/references/methodology/phase2-document-types.md
```

Generate G1~G9 (every relationship carries a mandatory three-state confidence annotation):

| Graph Document | Question Solved | Confidence Requirement |
|---------|---------|-----------|
| G1 Component Dependency Matrix | "Who depends on X?" | EXTRACTED from explicit document descriptions |
| G2 Call Chain Overview + state machine + constraint matrix | "Which modules does an API pass through?" | call chains EXTRACTED, inferred dependencies INFERRED |
| G3 Data Flow and Storage Dependencies | "Where is the data stored?" | read/write relationships EXTRACTED |
| G4 Error Code Component Map | "Which module does this error code belong to?" | EXTRACTED |
| G5 Cross-Component Interaction Scenarios (≥10 sequence diagrams) | "How is the quota check done?" | sequences EXTRACTED, boundaries INFERRED |
| G6 Knowledge Graph Triples (≥100) | "Who does A depend on indirectly?" | every triple marked E/I/A + score |
| G7 Architecture Risks and Impact Analysis | "How big is the impact if X goes down?" | direct dependencies EXTRACTED, indirect INFERRED |
| G8 Core Config Parameter Index | "How do I change configuration XX?" | EXTRACTED from config files |
| G9 Business Rule Constraint Matrix + AI reasoning decision tree | "Can I do XX?" | rules EXTRACTED, inferences INFERRED |

Also generate `<output_dir>/graph/README.md` (index + lookup-by-question-type table + retrieval routing suggestions).

### Step 3: Cross-document consistency check

**After the Graph RAG Agent finishes, the main agent performs this step itself (do not delegate to a sub-agent).**

Purpose: detect contradictory descriptions between component documents, preventing inconsistencies such as "A says it calls B over RPC, B says it is called by A over MQ".

```
Step 3A: Build the "claim matrix"

  For every Type-4 component document, extract relationship claims from **two levels**:
  
  Level 1: the "Upstream Components" and "Downstream Components" fields of the AI Quick Reference table
  Level 2: call descriptions in the interface design and core flow sections of the body
  
  If level 1 and level 2 describe the same relationship differently → first record it as an "intra-document contradiction" (a higher-priority problem than header vs body)
  
  Extraction example:
    ComponentX.md header claims: X→Y(RPC), X→Z(MQ)
    ComponentX.md body claims:   X→Z(HTTP)  ← contradicts the header!
    ComponentY.md header claims: Y←X(RPC), Y→Z(DB)
    ComponentZ.md header claims: Z←X(HTTP), Z←Y(DB)

Step 3B: Cross-compare

  FOR each pair of components (A, B):
    IF A.md claims "A→B over RPC" AND B.md claims "B←A over MQ":
      → record contradiction: "A→B communication method inconsistent: A says RPC, B says MQ"
    IF A.md claims "A→B" BUT B.md does not mention "called by A":
      → record omission: "A claims to call B, but B's document does not mention being called by A"
    IF a relationship in the G1 matrix differs from the component document claims:
      → record deviation: "G1 matrix says A→B(RPC), but A's document says A→B(MQ)"

Step 3C: Generate the consistency report

  Write to `_review/k3-consistency-check.md`:

  ```markdown
  # Cross-Document Consistency Check Report

  ## Contradictions (must fix)
  | Component A | Component B | A's Description | B's Description | Contradiction Type |
  |-------|-------|---------|---------|---------|
  | X | Z | X→Z(MQ) | Z←X(HTTP) | Communication method inconsistent |

  ## Omissions (recommended additions)
  | Claimant | Referenced | Claim | Omission |
  |--------|---------|---------|------|
  | A | B | A→B(RPC) | B's document does not mention being called by A |

  ## G1 Matrix Deviations (recommended alignment)
  | G1 Matrix | Component Document | Deviation |

  ## Statistics
  - Contradictions: N (❌ must fix)
  - Omissions: N (⚠️ recommended additions)
  - G1 deviations: N (⚠️ need alignment)
  - Consistent relationships: N (✅)
  - Consistency rate: X%
  ```

Step 3D: Automatic fixes (unambiguous cases only)

  IF contradictions > 0:
    FOR each contradiction:
      Trace back to the code: use Grep to find the actual call method (e.g. rpc.Call / mq.Publish)
      IF the correct side can be determined → fix the description in the wrong side's document + update the G1 matrix
      IF it cannot be determined → mark as AMBIGUOUS, leave for the user to confirm at the confirmation point
    Recompute the consistency rate after fixing

  IF contradictions = 0:
    → skip fixing, go straight to Phase K4
```

**When done**: update `current_phase` to `"phasek3_done"` → Phase K4.

---
