# Workflow step roles

> Status: Implemented — a workflow step runs with a team role's knowledge in a copy of its own, and every result names the harness it judged.

How to write `role` in a workflow is in the guide: [Run a step as a team role](../guide/workflow.md#run-a-step-as-a-team-role), [the advanced page](../guide/workflow-advanced.md#run-a-step-as-a-team-role) (worktrees, `for_each`, clones), [role arms](../guide/benchmarks.md#arms-that-run-as-a-role) and [the harness a label judged](../guide/scorers.md#the-harness-a-label-judged). This note records how it works and why. A member's own roles are [Assigned roles](assigned-roles.md); the engine's internals are in [docs/dev/workflow-engine.md](../dev/workflow-engine.md).

## Example

Alice's roles are `frontend` (skill `fe-only`, hook `fe-guard`). Her team also declares `review` (skill `rv-only`, hooks in namespace `rv-hook`). She runs:

```yaml
schemaVersion: v1alpha1
name: review
description: Review the branch as a reviewer.
steps:
  - id: review
    role: review
    workspace: new
    prompt: Review the change on this branch and write what must be fixed in REVIEW.md.
```

The step's worktree copy then holds:

| In the copy | Follows | Here |
|---|---|---|
| Knowledge: skills, rules, agents, docs, wiki, learnings | the step role, plus Alice's projects | `rv-only`, not `fe-only` |
| Channels: hooks, MCP, env, models | Alice's roles | `fe-guard`, not `rv-hook` |
| Discovery: workflows, prompts, scorers, benchmarks | Alice's roles | what Alice can run today |
| Alice's tags and skill exclusions | nothing: not applied | — |
| Alice's checkout, `config.yaml`, checkout record | unchanged | — |
| Alice's recall | Alice's knowledge: the copy's pull drops her index, which rebuilds from her selection | `fe-docs`, not `rv-docs` |

The pass records `agent.team.selection: { primaryRole: frontend, stepRole: review }`, and its label carries that observation as `agent`. The step's commit holds only `REVIEW.md`.

## The mechanism: the role is part of the copy's selection

pull's writers and the run-time hook handlers already deliver every channel of every tool from the effective config of the checkout they run in. So a copy records its role, every config load in that copy applies it, and the existing code delivers it. There is no per-tool adapter and no swap of installed files.

```text
<dataHome>/checkout-roles.json   { "<copy real path>": "review" }          checkout-roles.ts
  └─ applyRoleAssignment → withCheckoutRole, at every load and refresh      config.ts
       └─ config.stepRole = review          runtime-only; serializeLocalConfig drops it
            ├─ resolveResourceNamespaces → withStepRoleKnowledge            resource-namespaces.ts
            │    STEP_ROLE_PURPOSE: knowledge ← step role; channel, discovery ← member
            ├─ pull: every writer of every enabled tool; record selection.stepRole
            ├─ session hooks, extensions, plugins in the copy: the same config
            └─ local driver: agent, model, observation and skill credit read the copy
```

Every tool with a `step` launch profile takes role steps this way, and a tool that gains one later is covered without change.

## Lifecycle

```text
workflow next --prepare, driver.can.role                         engine.ts offerTerms → negotiate
  stepRoleOf(run, step) → { kind: 'role', role: 'review' }        workflow/workspace.ts
  lease.role = review          (held with wait.held[].missing role / prepare otherwise)
  preparePlace                                                   place/place.ts
  ├─ worktree copy: applyOverlay                                 place/overlay.ts
  │    setUpWorktreeRole                                         place/role-copy.ts
  │      project install governs the copy? roles.yaml declares the role?
  │      teamai.yaml loads? roleCopyRefusal: the step tool's knowledge inside? (D7)
  │        (a command step launches no tool: the docs only)
  │      recordCheckoutRole        (no role: clearCheckoutRole of an earlier step's)
  │    applyBaseConfig over AGENT_PATHS + copyKnowledgePaths                (D11)
  │    deliverTeamAssets → pull({ force, inline }) → PullDelivery
  │    worktreeRoleProblem: delivered or unchanged, record complete for the
  │      launched tool, record.selection.stepRole == role  else restore, role_unavailable
  │    recordConfigOverlay
  └─ clone copy, the step that opens it: installTeam             place/clone.ts
  │    roles.yaml at the clone's team revision declares the role?
  │    roleCopyRefusal for the tools that step launches (a command: the docs only)
  │    recordCheckoutRole in the clone's own partition
  │    child `teamai pull --team-ref <rev>` under HOME=<root>/h   exit ≠ 0 → role_unavailable
  │    cloneRoleProblem; removeGitHook; recordConfigOverlay
  └─ clone copy, a later step: cloneRoleProblem for the tools it launches    place/place.ts
       (roleCopyRefusal + the record's delivery)                  else role_unavailable
local driver promptReport                                        drivers/local/local-driver.ts
  worktreeRoleProblem / cloneRoleProblem again                   else role_unavailable
  launch the tool in the copy with TEAMAI_WORKFLOW_ATTEMPT
while the step runs, in the copy
  session hooks load the copy's config → the role's rules and instructions
  the tool's session-start pull: held by launchHoldsCheckout (the delivery is complete)
  `teamai pull`: same config, keeps selection.stepRole
  in a clone: preAction attemptCloneHome → useInstallHome, so teamai runs
    under the clone's install home (D12)                         index.ts
report
  agent.team from the copy: the local observation, preparedCopyTeam
  (external driver, worktree), or the clone receipt (PreparedAgentSchema)
release
  releasePlace, giveUpSetup → releaseWorktreeRole: drop the copy's index, clearCheckoutRole
  clone: removeClone deletes its root, partition and role file included
  a copy kept after a failed step keeps its entry, so resuming there keeps the role
```

## Which role a step runs with

The copy owns the role, and the step that opens it decides it. One resolver serves pull, lease and report: `resolvedRoleOf`, `copyOf`, `copyRoleConflict` and `stepRoleOf` in `src/workflow/workspace.ts`. `roleDiagnostics` in `src/workflow/parse-roles.ts` runs the same rules over a whole file at pull, across inline workflows and the files it runs by name.

| The step that opens the copy | Its role |
|---|---|
| sets `role` | that role |
| sets none, inside a `workflow` step that sets one | the nearest such step's role; it beats a `defaults.role` of a file that step runs |
| sets none, with no such step around it | the nearest file's `defaults.role` |
| none of these | the member's roles |

| A step that continues the copy | Result |
|---|---|
| names no role, or the copy's role | runs with the copy's role |
| names or inherits another role | `bad_role` at pull; `role_unavailable` at lease when pull could not see it |
| is a command | runs with the copy's role and needs `can.role` and `--prepare` like a prompt; an explicit `role` on a command is `bad_role` |
| is a top-level `workspace: continue` of a named file | continues its caller's copy: unknown at pull, checked by the caller's walk and at lease |

`role: "{{ item.role }}"` on a `for_each` step is checked only at lease. `roleLevelsOf` renders it once per item, so every copy and session rule above runs on the real id; a value that is not a non-empty string fails the item `role_unavailable`, and `stepRoleOf` answers `{ kind: 'unrenderable' }`, which each caller handles. `session.from` across two roles is `bad_session`; `session: continue` compares the `stepRole` the resumed pass recorded and fails closed when that pass recorded no team.

## Decisions

| Decision | Rule | Why |
|---|---|---|
| Role/member split (D4) | `STEP_ROLE_PURPOSE` classifies every namespaced type, with `satisfies`, so a new type fails to compile until classified. Knowledge follows the role; channels and discovery stay the member's. For a member with no role or project to filter by, discovery is every namespace on disk (`everyDiscoveryNamespace`) and channels are the root files only, as their own pull and caches read them. A role `roles.yaml` does not declare throws, never falls back, for learnings (`resolveActiveLearningsNamespaces`) too. | A role changes what the agent knows, never what it may execute or reach. An unfiltered fallback would deliver every namespace. |
| No personal filters (D2) | Member tags and skill exclusions do not filter a role copy, nor a workspace's or its children's in a workspace union; every site that applies them asks `usesMemberFilters`. Projects apply. | The same role must give every member the same knowledge. `installTeam` copies the member's filters into a clone's config, so the check keys on `stepRole`. |
| Own file for the role (D3) | `checkout-roles.json`, its own `withFileLock` and `writeJsonAtomic`; readers take no lock. A lock busy past its wait fails setup `role_unavailable`. Each write drops the entries of copies that no longer exist, such as an abandoned host-made one. | `config.yaml` is shared by every checkout of the partition, pull rebuilds checkout records from fixed fields, and several commands rewrite `state.json` whole without a lock. `.sync-lock` does not wait and every pull holds it. |
| Only teamai delivers a role | A role step requires `next --prepare` and `driver.can.role`. The local driver offers it; no skill host profile does. | A copy a driver makes itself gets the member's assets. No skill host promises its child loads what teamai delivered rather than the member's own. |
| Proof before launch (D10) | `pull` reports `delivered`, `unchanged`, `skipped` or `failed`; a clone's child pull its exit status. The step launches only after a complete delivery recorded with the requested `stepRole`, checked again before launch. | A skipped pull leaves an earlier delivery in place, which may be another role's. |
| Every copy setup pull is full | `deliverTeamAssets` passes `force`. | The base-config overlay takes back what an earlier step's pull delivered, while the copy's record still holds that delivery, so the fast path would deliver nothing. Not role-specific. |
| Containment (D7) | In a role copy, `locate` gives no knowledge place outside the copy, by resolved real path, for any tool (`Install.keepsKnowledgeInside`), so no writer or cleanup of the copy's pull touches one. `roleCopyRefusal` refuses before anything is written when the step's tool would lose a knowledge place that way, or `resolveDocsDestination` is outside the copy. A team `teamai.yaml` that does not load refuses too. Channel places keep their contract. | A knowledge place outside the copy is shared with other checkouts: they would read the role's knowledge, or the member's would reach the step. The copy's pull delivers to every tool the member enables, not only the step's. Derived from `TOOLS`, so no tool list. |
| Clean step branch (D11) | The overlay also covers `copyKnowledgePaths`: knowledge places inside the copy beyond `AGENT_PATHS`, the docs destination, and the self-mode `.teamai/.gitignore`. | A step commit carries no delivered file with `sharing.gitExclude` off or custom tool paths. Non-role steps benefit too. |
| Recall per role copy (D9) | A role copy indexes into `workspaces/<id>/search-index.json` (`getProjectSearchIndexPath`). `dropIndexesAfterRebuild`: a role copy's rebuild drops every other index, the shared one included, as its pull may have moved the team clone or learnings checkout they read; a member's drops the role copies' indexes, in any mode. `dropIndexesAfterSourceUpdate`: contribute and learnings publish drop every other index, the shared one included. | The role's knowledge is not the member's, so it cannot share an index; each dropped index rebuilds cold with its own selection. |
| Clone found from inside (D12) | A teamai command started inside a trial clone runs under that clone's install home (`attemptCloneHome`, `useInstallHome`). | Hooks and `teamai pull` in a clone then load the clone's install, and so its role. |
| Role recorded by teamai | `stepRole` in a run record comes from the copy teamai prepared. `ReportedAgentSchema` omits it; `PreparedAgentSchema` and `preparedCopyTeam` carry it. | Results, benchmark deviations and `session: continue` trust it; a driver must not be able to claim a role. |
| No run-wide asset pin (D8) | A worktree role step reads the team clone as any worktree step does; the observation records the revision it got. | `--team-ref` would move the member's shared team clone. Clones and benchmark arms keep their pins. |

## Results link to the harness

Every workflow label and session label carries the harness it judged as `agent`, outside the label key. A prompt pass gives its observation, also without a model. A `workflow` step gives the first observation of its prompt passes when all have one and agree on tool (version included), model, effort, definition and team (`judgedAgent` in `workflow/scoring.ts`, by `sameHarness` in `src/agent-observation.ts`, which compares session captures too); command passes are ignored. Sessions keep the definition through settlement. Results read `label.agent` first and the run join second, so a label keeps its harness after its run file is gone. The role dimension is `stepRole ?? primaryRole`. `agentHarnessOf` in `src/agent-observation.ts` reads a harness; `src/dashboard/agent-harness-view.ts` renders it as one line (tool · model · effort · role, step or member). The judge never sees the harness.

A benchmark arm's `role` opens its trial clone with that role: `role` is an arm dimension, an observed `stepRole` that differs is a deviation, and keys gain `role` only when set (`benchmark/agent-match.ts`, `benchmark/history.ts`).

## Git hooks and git exclude need no role code

| Concern | Why a role copy needs nothing |
|---|---|
| teamai's git hook | A config hook in the common git config, independent of selection (`git-hook.ts`). Its handlers do nothing in teamai's own checkouts, which include every workflow worktree under `.teamai/` (`ownCheckoutsDir` in `hook-handlers.ts`). A clone removes the hooks its own pull installed (`removeGitHook` in `installTeam`). Setup's pull is the only delivery into a copy. |
| A tool's session-start pull | Held by `launchHoldsCheckout` while the copy's delivery is complete, which D10 guarantees, so the harness does not change under a running step. |
| `.git/info/exclude` | The shared `delivered` block is the union of live checkouts' lists less paths foreign in another (`deliveredUnion` in `git-exclude-delivered.ts`); a role copy's list joins it. |

## Not included

- The judge seeing the harness: it would bias the judgement.
- Role steps on skill drivers: no host guarantees the child that runs the step loads the role's delivery.
- A role granting hooks, MCP, env or models: it would grant capabilities the member's roles do not.
- User-scope assets: they reach every step through the member's HOME and stay the member's.
- A second check right before a command step: a command launches no step tool whose delivery could be checked, so the setup check is its proof. `promptReport` re-checks a prompt step's delivery for the tool it launches.
