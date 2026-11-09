# teamai-import-from-mr

English | [中文](README.zh-CN.md)

Turns merged MRs or PRs into team learnings. Your AI tool drafts one per MR, a person accepts, edits or skips each draft, and the accepted ones are published as `teamai contribute` publishes them.

`teamai import --from-mr` starts it, `teamai ci extract-mr` runs it through `teamai-ci-extract-mr`, and the session-start MR hint offers it.

## Files

| File | What it is |
|---|---|
| `WORKFLOW.yaml` | the steps |
| `draft.en.md` | what the AI tool is asked for each MR when `language` is `en` |
| `draft.zh.md` | the same, when `language` is `zh` |

Both drafts are templates. `{{ steps.fetch.outputs.<field> }}` reads what `teamai import fetch-mr` found for the MR: `url`, `title`, `description`, `commits`, `diff`, `threads`, `thread_count`, `author`, `date`.

## Inputs

| Input | Meaning |
|---|---|
| `mrs` | the MR or PR URLs |
| `all` | accept every draft without asking |
| `publish` | `false` writes and pushes nothing, so the drafts are only the run's outputs |
| `dir` | the team repo; with `output`, the directory each draft is written into as `learning.md` (`learning-<n>.md` for several). Default `''` |
| `output` | write the drafts as files into `dir` |
| `discussions` | read the MRs' review threads |
| `language` | `en` or `zh`: which draft file is used |

## Outputs

| Output | Meaning |
|---|---|
| `text` | the summary the command prints |
| `exit_code` | `1` when an MR failed; the others still finish |
| `learnings` | each published learning's `url`, `title`, `file` and `repo_url` |

## Related settings

- `language` in `teamai.yaml`: the commands pass `language: en` when it is `en`, and `zh` otherwise.
- `sharing.mrHint.enabled` in `teamai.yaml`: whether the session-start hint lists merged MRs and offers this workflow.
- The AI tool that writes the drafts: `workflows.tools` in your config, `TEAMAI_AI_TOOL`, or `ai.tool`.

## Replace it

Copy this folder to `workflows/teamai-import-from-mr/` in the team repo, edit it, push it, and run `teamai pull`. The team's folder replaces this one as a whole: keep every file `WORKFLOW.yaml` names, and keep the inputs and outputs, since the commands above pass those inputs and read those outputs.
