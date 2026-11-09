# teamai-import-from-repo

English | [中文](README.zh-CN.md)

Imports repositories or local checkouts into a teamwiki. For each one it extracts the code, asks the AI tool for its narrative, runs `teamai-codebase-enrich` and `teamai-codebase-deep-enrich`, and publishes it. Then it refreshes the teamwiki indexes and publishes them once.

`teamai import --dir`, `--from-repo`, `--from-repo-list` and `--from-org` start it.

## Files

| File | What it is |
|---|---|
| `WORKFLOW.yaml` | the steps |
| `narrative.md` | what the AI tool is asked for a repository's `codebase.md`. It reads `{{ steps.stage.outputs.context }}`, the repository context the stage step gathered |

## Inputs

| Input | Meaning |
|---|---|
| `wiki_root` | the teamwiki every item lands in |
| `mode` | the command that started the run: `dir`, `repo`, `list`, `org`, `update` or `ci`. It says how the batch is published and summed up; with `update` and `ci`, the command publishes it |
| `items` | each a remote repository (`kind: repo`, `source` a URL, `auth` `token`, `ssh`, `public` or `''`) or a local checkout (`kind: dir`, `source` a directory), with `domain`, `slug` and `repo_url` (`''` when not given) and `mr_urls` |
| `settings` | `depth`, `ssh`, `incremental`, `skip_enrich`, `max_files` (`0` keeps the default) and `team_repo`, the team repo that holds `wiki_root` (`''` when none does) |
| `skipped` | how many items the command left out before the run, counted in the summary |
| `concurrency` | how many items are imported at once |

## Outputs

| Output | Meaning |
|---|---|
| `text` | the summary the command prints |
| `exit_code` | `1` when an item failed; the others still finish |
| `imported` | each item's `source`, `slug`, `updated` and `failed` |

## Related settings

- The AI tool that writes the narrative: `workflows.tools` in your config, `TEAMAI_AI_TOOL`, or `ai.tool`. A tool named there that cannot run fails the item before anything is published.

## Replace it

Copy this folder to `workflows/teamai-import-from-repo/` in the team repo, edit it, push it, and run `teamai pull`. The team's folder replaces this one as a whole: keep every file `WORKFLOW.yaml` names, and keep the inputs and outputs, since the commands above pass those inputs and read those outputs.
