# teamai-codebase-deep-enrich

English | [中文](README.zh-CN.md)

Writes the deep knowledge docs of a codebase that `teamai import` extracted into a teamwiki. The docs go beside the codebase's evidence: a design doc for each component, the architecture overview, the graph docs and the cross-component scenarios.

| Started by | |
|---|---|
| `teamai codebase --deep-enrich --project <slug>` | One codebase |
| [`teamai-import-from-repo`](../teamai-import-from-repo/README.md) | Each repository it imports |

## How teamai's version runs

```mermaid
flowchart TD
    plan[Plan the components and the docs they need] --> comp
    subgraph comp [For each component, up to concurrency at once, each in its own worktree]
        ask[Ask the AI tool: component.md] --> write[Write the design doc]
    end
    comp --> arch["Ask the AI tool: architecture.md, when the plan needs an overview"]
    arch --> gr[Write the graph docs]
    gr --> sc["Ask the AI tool: scenarios.md, when the graph has scenarios"]
    sc --> finish(["Sum up: text, exit_code, complete, missing_components, missing_architecture"])
    finish --> pub{publish?}
    pub -- true --> publish([Commit and push the docs])
    pub -- false --> done([Done])
    classDef prompt fill:#6a4f8f,stroke:#513b6d,color:#fff;
    classDef out fill:#2f8f4f,stroke:#1f6b39,color:#fff;
    class ask,arch,sc prompt;
    class finish,publish,done out;
```

Purple marks a prompt the AI tool answers. A component whose answer fails gets no doc. The run names it, and the next run writes it. When the AI tool cannot run at all, the run fails. `WORKFLOW.yaml` holds the steps.

## Files

| File | What it is |
|---|---|
| `WORKFLOW.yaml` | The steps, and the `output:` each step declares |
| `component.md` | The prompt for each component's design doc |
| `architecture.md` | The prompt for the architecture overview |
| `scenarios.md` | The prompt for the scenario sequence diagrams |
| `params.yaml` | How many component docs `teamai codebase --deep-enrich` has the run write at once |

A prompt reads `{{ inputs.<name> }}`, `{{ item.<field> }}` inside a step that runs for each component, and the outputs of the steps it needs, as `{{ steps.<id>.outputs.<field> }}`.

## Inputs

| Input | Type | Meaning |
|---|---|---|
| `wiki_root` | `string` | The teamwiki directory |
| `project` | `string` | The codebase, its directory under `evidence/code/` |
| `max_modules` | `number` | How many components get a doc. `0` means every component |
| `concurrency` | `number` | How many component docs the run writes at once. `teamai codebase --deep-enrich` passes the `concurrency` of `params.yaml` |
| `publish` | `boolean` | Commit the docs and push them to the team repo that holds `wiki_root` |

## Outputs

| Output | Meaning |
|---|---|
| `text` | The summary the command prints |
| `exit_code` | `1` when a doc is missing |
| `complete` | `true` when the run wrote every doc |
| `missing_components` | The components with no doc. The next run writes them |
| `missing_architecture` | `true` when the architecture overview is missing |

## Parameters

| Key | Range | What it sets |
|---|---|---|
| `concurrency` | 1-20 | How many component docs `teamai codebase --deep-enrich` and `teamai deep-enrich` have the run write at once. `teamai-import-from-repo` passes its own, `5` |

## Replace it

Put only the files you change in `workflows/teamai-codebase-deep-enrich/` at the root of the team repo. Every other file, `WORKFLOW.yaml` included, stays teamai's and keeps getting teamai's updates. To add a section to each design doc, copy its prompt:

```bash
mkdir -p workflows/teamai-codebase-deep-enrich
cp "$(npm root -g)/teamai-cli/workflows/teamai-codebase-deep-enrich/component.md" workflows/teamai-codebase-deep-enrich/
```

Then add this to `component.md`:

```markdown
End each design doc with a "Failure modes" section that lists what the component does when a dependency is down.
```

To write fewer docs at once, against an AI tool's rate limit:

```yaml
# workflows/teamai-codebase-deep-enrich/params.yaml
concurrency: 2
```

Push the folder. After the next `teamai pull`, the command and `teamai-import-from-repo` run it with your files. A `workflows/teamai-codebase-deep-enrich.yaml` file replaces the folder whole, so teamai's parameters apply.

| Keep | Why |
|---|---|
| The inputs and outputs above | The callers pass those inputs and read those outputs |

## What pull refuses

| A team folder that | Pull |
|---|---|
| Sets a value out of range, or a key the table above does not list, in `params.yaml` | Names the file and the field. The version pull last took stays in force, teamai's until it took one |

`teamai review --branch` fails such a folder before you merge it.

## Requires

| Needs | Without it |
|---|---|
| An AI tool | When a tool named in the settings cannot run, the run fails |

## Settings that change it

| Setting | Team `teamai.yaml` | Member config | Environment | Effect |
|---|---|---|---|---|
| AI tool | | `workflows.tools.default`, then `ai.tool` | `TEAMAI_AI_TOOL`, before both | Picks the tool that writes each doc |
| Driver | `workflows.driver` | `workflows.driver` | | Picks the driver `teamai codebase --deep-enrich` starts its run on. Unset means this machine |
| Retention | | `workflows.retention` | | Sets how long `teamai doctor --fix` leaves the worktrees and branches of the answers |

The member config is `~/.teamai/projects/<slug>/config.yaml` in a workspace, then `~/.teamai/config.yaml`. The environment wins over the member config, and the member config wins over the team. See [member settings](https://github.com/Tencent/teamai-cli/blob/main/docs/guide/reference.md#member-settings) for the defaults.
