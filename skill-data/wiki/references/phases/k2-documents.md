## Phase K2: Document Generation (batched parallel runs + mid-way quality confirmation)

**Methodology**: `{SKILL_DIR}/references/methodology/phase2-document-types.md`

### Generation order (dependency-chain driven, lower layers first)

```
Batch 1: data layer + basic execution layer Type-4 component documents   ← parallel
Batch 2: resource / scheduling layer Type-4 component documents          ← parallel
Batch 3: messaging / service layer Type-4 component documents            ← parallel
Batch 4: API entry layer Type-4 component documents                      ← parallel
           ⛔ Confirmation point ② ← manual spot check of component document quality
Batch 5: architecture overview layer (Type-1 + Type-2 + Type-3) ← serial (depends on all layers above being complete)
Batch 6: bridge documents (Type-5 + Type-6 + Type-7)            ← serial (depends on product documentation)
Batch 7: knowledge enhancement (Type-8: anti-patterns / RPC contracts / troubleshooting) ← serial
```

### Execution flow for each batch

Read `{SKILL_DIR}/references/agents/kb-doc-generator.md`, assemble the input package and launch:

```
component_list:    list of components / document types for this batch
architecture_map:  full content of _review/k1-architecture-map.md
repos:             repository list from _review/repo-manifest.json
service_map:       service_map from progress.json
output_dir:        <Phase 0>
project_name:      <Phase 0>
product_docs_dir:  <Phase 0, may be empty>
methodology_dir:   {SKILL_DIR}/references/methodology/
completed_docs:    kb_progress.components_done (skipped on resume from checkpoint)
parallel_mode:     true (batches 1~4) / false (batches 5~7)
```

After each batch completes:
- Append the completed components to `kb_progress.components_done`
- Accumulate `accuracy_stats` (extracted from the self-check summary returned by the Agent)
- Update `current_phase` to `"phasek2_batch_N"`
- Show the token consumption and `[UNVERIFIED]` statistics for this batch

### ⛔ Confirmation point ② (after batches 1~4 complete)

Show the user:
```
{N} component design documents generated. Accuracy statistics:
  Total claims: {N} | Verified: {N} | [UNVERIFIED]: {N} ({X}%)
  AMBIGUOUS relationships: {N}

Please spot-check 2~3 documents (the most complex components are recommended):
  Path: <output_dir>/XX_<component>_Design.md

Points to confirm:
  1. Is the code entry point in the AI Quick Reference table precise down to the function name?
  2. Does the core flow description match the actual code?
  3. Is the [UNVERIFIED] ratio acceptable? (<15% recommended)

If you find a systematic problem, describe it and I will adjust the strategy and regenerate.
```

Update `current_phase` to `"phasek2_waiting_confirm"`.
After the user confirms, update to `"phasek2_confirmed"` and continue with batches 5~7.

### After all batches complete

Write `_review/k2-doc-list.md` (document list: path + size in KB + [UNVERIFIED] count + generation time).
Update `current_phase` to `"phasek2_done"` → Phase K3.

---
