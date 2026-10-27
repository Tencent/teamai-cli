# CI Examples

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a>
</p>

This directory holds several CI examples: MR knowledge extraction (`*-mr-extract`) and a teamwiki consistency check (`codebase-lint.yml`).

## Files

| File | Purpose |
|------|------|
| `github-actions-mr-extract.yml` | GitHub Actions example: extracts knowledge and comments when a PR is opened or updated, and writes it to the team knowledge repo after the PR is merged |
| `coding-ci-mr-extract.yaml`     | Zhiyan / Coding CI (TGit) example: extracts knowledge and comments when an MR is opened or updated, and writes it to the team knowledge repo after the MR is merged |
| `gitlab-ci-mr-extract.yml`      | GitLab CI (self-hosted instance, API v4) example: extracts knowledge and comments when an MR is opened or updated, and writes it to the team knowledge repo after the merge into the default branch |
| `codebase-lint.yml`             | GitHub Actions example: runs a global consistency check on the teamwiki knowledge graph |

## MR knowledge extraction examples (`*-mr-extract`)

`github-actions-mr-extract.yml` / `coding-ci-mr-extract.yaml` extract knowledge automatically during the MR/PR lifecycle:

- **When an MR/PR is opened or updated**: `teamai ci extract-mr --mode comment` posts the knowledge suggestions as comments on the MR/PR
- **After an MR/PR is merged**: `teamai ci extract-mr --mode write` writes the learning and the `teamwiki/` graph to the team knowledge repo and pushes. `teamwiki/` follows the same flow as `teamai import --dir . --incremental`: it runs in the merged source checkout, re-extracts only the changed files, and writes to `teamwiki/evidence/code/<provider>__<owner>__<repo>/` (the same slug as `teamai import --from-repo`)

### Prerequisites

1. These two files are **templates**. Before use, replace the placeholders as the comments in each file describe (this repo's path, the knowledge repo's path, the default branch, the AI gateway address).
2. `teamai ci extract-mr` calls a local AI CLI to do the extraction, so you **must** install an AI CLI (`@anthropic-ai/claude-code`) and configure its credentials:
   - GitHub Actions: `ANTHROPIC_AUTH_TOKEN` (Secret) + `ANTHROPIC_BASE_URL` / model names (Variables)
   - Zhiyan / Coding CI (TGit): `ANTHROPIC_AUTH_TOKEN`, `TGIT_TOKEN` (both Secrets)
3. You need a token with push access to the team knowledge repo: `TEAMAI_SYNC_TOKEN` on GitHub, `TGIT_TOKEN` on TGit.
4. For Zhiyan / Coding CI (TGit), the MR trigger rules **must be written in the `mr:` block of the YAML**; ticking them only in the UI has no effect.
5. In write mode the working directory must be the merged source checkout, and the team knowledge repo must be cloned **outside** the checkout (the templates use a sibling directory and `/tmp/teamai-team-repo` respectively). If it is cloned inside the checkout, the CLI skips the `teamwiki/` update and writes only the learning.
6. GitLab CI (`gitlab-ci-mr-extract.yml`): the credential is `GITLAB_TOKEN` (a GitLab PAT with the `api` scope). GitLab has no native "MR merged" trigger, so the post-merge write stage runs on the default branch's push pipeline and looks the MR up from the merge/squash commit. To reject a suggestion you do not want, add a 👎 award emoji on the MR.

## teamwiki consistency check example (`codebase-lint.yml`)

`codebase-lint.yml` runs a global consistency check on the `teamwiki/` knowledge graph:

- **Triggers**: when a PR changes codebase-related files, daily at 04:37 UTC, and manually
- **Checks**: consistency issues such as unclosed anchors, orphan md files, broken sources, mismatched counts, and stale entries
- **Exit code**: non-zero when there are `high`-level issues, so it can block a PR from merging directly; the report is uploaded as an artifact
