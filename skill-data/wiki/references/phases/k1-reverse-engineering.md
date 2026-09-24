## Phase K1: Architecture Reverse-Engineering and Source Material Collection

**Methodology**: `{SKILL_DIR}/references/methodology/phase0-collection.md` + `{SKILL_DIR}/references/methodology/phase1-reverse-engineering.md`

### Step 1: Optionally run the scan script (recommended)

```bash
python3 "{SKILL_DIR}/scripts/scan_repo.py" <project_root> --depth 2 --top 10
```
Output: file statistics + key file discovery report + language distribution.

### Step 2: Key file extraction

Scan by priority (see phase0-collection.md for details):
- **P0 required**: entry files, routes/handlers, workflow orchestration config, Proto/IDL
- **P1 important**: database schema (DDL), constant / error code definitions
- **P2 enhancement**: config files, test files (to understand expected behaviour)

### Step 3: Architecture reverse-engineering (see phase1-reverse-engineering.md for details)

- Bottom-up layering: leaf nodes (DB/MQ) → intermediate nodes (orchestration/scheduling) → root nodes (API entry points)
- Three-layer penetration tracing: for ≥5 core APIs, complete the full call chain trace API entry → orchestration layer → service execution layer
- Build the N×N component relationship matrix (annotate the communication method: RPC/MQ/DB)

### Step 4: Generate the architecture analysis report

Write to `_review/k1-architecture-map.md`:

```markdown
## Architecture Layers (≥4 layers)
| Layer | Components | Core Responsibility | Code Repository |

## Component Inventory
| Component | Architecture Layer | **Repository** | Language | Criticality (P0/P1/P2) | Entry File | **Interface Check Type** |

Interface check type values (ask the user to verify this column at confirmation point ①):
  - `HTTP`    → API access layer, has HTTP/gRPC route registrations, requires interface count reconciliation
  - `MQ`      → message processing layer, has MQ Consumer/Exchange declarations, Topic count is the baseline
  - `RPC`     → internal service layer, has .proto / .thrift / IDL files, Method count is the baseline
  - `NONE`    → scheduling / execution / data layer, no external interface, no interface count check

## N×N Component Communication Matrix
(values: RPC/MQ/DB/—, annotated with confidence [E]EXTRACTED/[I]INFERRED/[A]AMBIGUOUS)

## Core Call Chains (≥5)
(format: API(file:line) → orchestration layer(config:line) → service layer(handler:line) → DB(table))

## Glossary
| Internal Term | External / Product Term | Notes |

## Uncertain Items (for manual confirmation)
(relationships and inferences marked [A], with the reason for the uncertainty)
(components whose interface check type is uncertain, marked [?], to be clarified by the user at confirmation point ①)
```

### Step 5: Interface inventory scan (run separately per check type)

**Run only for components whose interface check type in k1-architecture-map.md is ≠ NONE**:

```
FOR each component with interface check type = HTTP:
  Run a grep scan:
    Go:   grep -rn "\.GET\|\.POST\|\.PUT\|\.DELETE\|router\.Handle\|@handler" <component_dir>
    Python: grep -rn "@app\.route\|@router\.\|APIRouter\|include_router" <component_dir>
  Record: component → HTTP interface count N (SCAN_CONFIDENCE: HIGH/MEDIUM)

FOR each component with interface check type = MQ:
  Run a grep scan:
    grep -rn "Exchange\|Queue\|Topic\|consumer\|subscribe\|@KafkaListener" <component_dir>
  Record: component → MQ Topic/Queue count N

FOR each component with interface check type = RPC:
  Parse the .proto / .thrift files:
    find <component_dir> -name "*.proto" -o -name "*.thrift" | xargs grep "^rpc\|^service"
  Record: component → RPC Method count N
```

Write the results to `_review/interface-inventory.json`:
```json
{
  "ComponentA": {"type": "HTTP", "count": 13, "confidence": "HIGH"},
  "ComponentB": {"type": "MQ",   "count": 5,  "confidence": "MEDIUM"},
  "ComponentC": {"type": "RPC",  "count": 8,  "confidence": "HIGH"},
  "ComponentD": {"type": "NONE", "count": 0,  "confidence": "—"}
}
```

**When done**: update `current_phase` to `"phasek1_waiting_confirm"`.

**⛔ Confirmation point ①**: wait for an explicit reply from the user. Do not proceed to the next phase automatically.

Show the user:
```
Architecture analysis complete.

Component inventory (N in total):
  P0 core: [list]
  P1 important: [list]
  P2 auxiliary: [list]

Interface scan results (for verification):
  HTTP interfaces: ComponentA 13, ComponentB 7
  MQ Topics:       ComponentC 5
  RPC Methods:     ComponentD 8
  Components without interfaces: ComponentE, ComponentF, ...

AMBIGUOUS relationships (please clarify):
  - The communication method of ComponentX → ComponentY is uncertain

Please confirm (edit k1-architecture-map.md directly, then reply "continue"):
  1. Are the architecture layers and P0/P1/P2 annotations correct?
  2. Is the interface check type (HTTP/MQ/RPC/NONE) of every component accurate?
  3. Are the interface scan counts reasonable? Clearly too few means something was missed; too many may mean test files were scanned.
```

After confirmation: update to `"phasek1_confirmed"` → Phase K2.

---
