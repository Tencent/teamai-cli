## Phase K4: Knowledge Base Quality Assessment and Report

**Methodology**: `{SKILL_DIR}/references/methodology/phase4-quality.md`

### Step 1: Automated validation

```bash
python3 "{SKILL_DIR}/scripts/validate_kb.py" <output_dir> --verbose
```

`--verbose` prints the details of every item (missing anchors, the exact location of dead links). This is exactly the full output required below.

Output (**must be shown in full, not only the passing items**):
```
Link integrity:          ✅/❌  N dead links
search-anchor:           ✅/⚠️  coverage N/M (X%)
AI Quick Reference table: ✅/⚠️  coverage N/M (X%)
Bidirectional links:     ✅/⚠️  coverage N/M (X%)
README index:            ✅/⚠️  inclusion rate N/M (X%)
```

### Step 2: Accuracy audit

Aggregate the credibility of the whole knowledge base from `accuracy_stats`, and the interface coverage from `interface_coverage`:

```
[Content accuracy]
Total claims:                 N (business rules + interface descriptions + relationships)
Verified (with code reference): N (X%)
[UNVERIFIED]:                 N (X%)
AMBIGUOUS relationships:      N (X%)

[Interface coverage] (only HTTP/MQ/RPC type components are counted, NONE type is excluded)
HTTP interfaces: documented M / scan baseline N = X%
MQ Topics:       documented M / scan baseline N = X%
RPC Methods:     documented M / scan baseline N = X%
Overall coverage: X%    target ≥ 90%

⚠️ Interface gap list (components where documented < scan baseline):
  - ComponentA: documented 8, scan baseline 13, gap 5 → recommend adding
```

⚠️ Manual confirmation list: (documents with [UNVERIFIED] > 20% + components with interface gaps + AMBIGUOUS relationships)

### Step 3: RAG retrieval spot check

Following `phase4-quality.md §RAG Retrieval Test Cases`, test 1 question from each of the 7 question types (see the methodology for details) and record the hit rate.

### Step 4: AI end-to-end validation (E2E Validation)

**Core idea**: answer a set of standardised questions using the knowledge base, then **trace back to the code to verify the answers**, to detect whether the knowledge base enables the AI to give correct answers.

```
Step 4A: Generate the standard validation question set (automatic, based on existing documents)

  **Prefer an external validation set provided by the user**:
  IF the user provided a list of validation questions (3~10 real business questions) in Phase 0 or now:
    → use the user's questions as the validation set first (source: USER)
    → top up automatically to 10~15 questions (source: AUTO)
  ELSE:
    → generate all automatically (source: AUTO)
  
  > User-provided questions are more valuable, because when the AI writes its own questions it tends to test areas it already knows,
  > and the real blind spots (things the AI did not understand and is unaware of) can only be found by external questions.

  Automatically generate 10~15 validation questions from k1-architecture-map.md and k2-doc-list.md:

  Question type distribution (cover at least the following 5 types):

  ┌────────────────────────────────────────────────────────────────────┐
  │ Type 1: component responsibility (3 questions)                     │
  │   Pattern: "What is the core responsibility of <component>? Where is the code entry point?" │
  │   Verification: the function / file names in the answer must exist in the code │
  │                                                                    │
  │ Type 2: call relationships (3 questions)                           │
  │   Pattern: "What is the relationship between <component A> and <component B>? How do they communicate?" │
  │   Verification: the answer matches the G1 matrix + the actual imports / calls in the code │
  │                                                                    │
  │ Type 3: operation constraints (2 questions)                        │
  │   Pattern: "Can <operation Y> be executed in <state X>?"           │
  │   Verification: the answer matches the G9 constraint matrix + the state checks in the code │
  │                                                                    │
  │ Type 4: data flow (2 questions)                                    │
  │   Pattern: "Which tables / queues does <operation Z> ultimately write to?" │
  │   Verification: the answer matches the G3 data flow + the actual SQL / MQ operations in the code │
  │                                                                    │
  │ Type 5: error troubleshooting (2 questions)                        │
  │   Pattern: "What does error code <XXX> mean? Which component produces it?" │
  │   Verification: the answer matches the G4 error code map + the error definitions in the code │
  │                                                                    │
  │ Type 6 (optional): knowledge boundary test (2 questions)           │
  │   Pattern: deliberately ask about content the knowledge base does not cover (e.g. third-party SDK internals, historical architecture changes) │
  │   Verification: the AI should answer "outside the knowledge base coverage" rather than hallucinate │
  └────────────────────────────────────────────────────────────────────┘

Step 4B: Answer using the knowledge base (simulating the AI usage scenario)

  FOR each validation question:
    1. Assume only the knowledge base documents can be read, not the code directly
    2. Find the relevant document following the retrieval routing rules
    3. Extract the answer from the document

Step 4C: Code trace-back verification

  FOR each answer:
    1. Verify the key claims directly in the code with Grep/Read
    2. Judge the result:
       ✅ CORRECT       : the answer matches the code
       ⚠️ PARTIAL       : the answer is partially correct, with omissions or imprecision
       ❌ INCORRECT     : the answer contradicts the code
       🔇 BOUNDARY_OK   : knowledge boundary question, correctly declined to answer (type 6 only)
       🔇 BOUNDARY_FAIL : knowledge boundary question, wrongly gave an answer (type 6 only)

Step 4D: Write the validation report

  Append to the ## AI End-to-End Validation section of k4-quality-report.md:

  | Question | Type | Retrieved Document | AI Answer Summary | Code Verification | Result |
  |------|------|---------|-----------|---------|------|
  | Core responsibility of Aurora? | Component responsibility | 03_Aurora_Design.md | Scheduling orchestration... | scheduler.go:42 | ✅ |
  | A→B communication method? | Call relationship | G1 matrix | RPC | import rpc_client | ✅ |
  | Can operation Y run in state X? | Operation constraint | G9 matrix | No | check_state.go:88 | ✅ |
  | Third-party SDK internals? | Knowledge boundary | — | Out of scope | — | 🔇 OK |

  Statistics:
    CORRECT: N/M (X%)
    PARTIAL: N/M (X%)
    INCORRECT: N/M (X%), ❌ every INCORRECT must list the specific contradiction
    BOUNDARY_OK: N/N
    BOUNDARY_FAIL: N/N

    E2E accuracy = (CORRECT + BOUNDARY_OK) / total questions
    Target: ≥ 80%
```

**If E2E accuracy < 80%**: list the documents that need improvement and the specific problems in the "Recommendations" section of the quality report.

### Step 5: Generate the quality report

Write to `_review/k4-quality-report.md`:

```markdown
# Knowledge Base Quality Report

## Overview
- Code baseline: <commit SHA> (<tag>)
- Generated at: <ISO8601>
- Total documents: N (Type-1~8: N, graph G1~G9: 9)

## Accuracy
| Metric | Value | Status |
| Total claims | N | — |
| With code reference | N (X%) | ✅/❌ |
| [UNVERIFIED] | N (X%) | ✅/<15% / ⚠️15~25% / ❌>25% |
| AMBIGUOUS relationships | N | ✅/⚠️ |

## Structural Quality (validate_kb.py output)
(shown in full, no numbers hidden)

## Cross-Document Consistency (summary of k3-consistency-check.md)
| Metric | Value | Status |
| Contradictions | N | ✅=0 / ❌>0 |
| Missing references | N | ⚠️ |
| G1 deviations | N | ⚠️ |
| Consistency rate | X% | target ≥95% |

## RAG Retrieval Spot Check
| Test Question | Expected Hit | Actual Hit | Result |

## AI End-to-End Validation
| Metric | Value | Status |
| CORRECT | N/M (X%) | — |
| PARTIAL | N/M (X%) | ⚠️ |
| INCORRECT | N/M (X%) | ❌ |
| BOUNDARY_OK | N/N | ✅ |
| E2E accuracy | X% | target ≥80% |

INCORRECT details:
(the specific contradiction and improvement suggestion for every INCORRECT)

## Manual Confirmation List
([UNVERIFIED] over-threshold documents + AMBIGUOUS relationships + contradictions + dead links)

## Recommendations
(improvement directions based on the consistency check + E2E validation)
```

**When done**: update `current_phase` to `"completed"`. The workflow ends.

---
