# teamai-codebase-deep-enrich

English | [中文](README.zh-CN.md)

Writes the deep knowledge docs of a codebase `teamai import` extracted into a teamwiki, beside its evidence: a design doc for each component, the architecture overview, the graph docs and the cross-component scenarios.

`teamai codebase --deep-enrich` starts it, and `teamai-import-from-repo` runs it for each repository it imports.

## Files

| File | What it is | What it reads |
|---|---|---|
| `WORKFLOW.yaml` | the steps | |
| `component.md` | what the AI tool is asked for each component's design doc | `inputs.project`, and `item.slug`, `item.responsibilities`, `item.facts`, `item.call_chains`, `item.deps` |
| `architecture.md` | what it is asked for the architecture overview | `inputs.project`, `steps.plan.outputs.architecture.modules`, `.edges`, `.interfaces` |
| `scenarios.md` | what it is asked for the scenario sequence diagrams | `inputs.project`, `steps.graph.outputs.scenarios.architecture`, `.call_chains`, `.modules` |

## Inputs

| Input | Meaning |
|---|---|
| `wiki_root` | the teamwiki directory |
| `project` | the codebase under `evidence/code/` |
| `max_modules` | how many components get a doc; `0` takes every component |
| `concurrency` | how many component docs are written at once; `teamai codebase --deep-enrich` passes `5` |
| `publish` | commit and push the docs to the team repo that holds `wiki_root`. Default `false` |

## Outputs

| Output | Meaning |
|---|---|
| `text` | the summary the command prints |
| `exit_code` | `1` when a doc is missing |
| `complete` | every doc was written |
| `missing_components` | the components with no doc, written by the next run |
| `missing_architecture` | the architecture overview is missing |

## Related settings

- The AI tool that writes the docs: `workflows.tools` in your config, `TEAMAI_AI_TOOL`, or `ai.tool`. A tool named there that cannot run fails the run.

## Replace it

Copy this folder to `workflows/teamai-codebase-deep-enrich/` in the team repo, edit it, push it, and run `teamai pull`. The team's folder replaces this one as a whole: keep every file `WORKFLOW.yaml` names, and keep the inputs and outputs, since the callers above pass those inputs and read those outputs.
