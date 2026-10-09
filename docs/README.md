# TeamAI CLI documentation

> [English](README.md) | [简体中文](README.zh-CN.md)

Index of everything under `docs/`. The `/teamai` skill (`skills/teamai/` and `skill-data/`) is written for AI agents, so it is not listed here.

## For users

New to TeamAI? Start with [Getting Started](guide/getting-started.md).

| Document | Languages | What it covers |
| --- | --- | --- |
| [Usage Guide](usage-guide.md) — eleven pages under [`guide/`](guide/) (Chinese in [`guide/zh-CN/`](guide/zh-CN/)) | [en](usage-guide.md) · [zh-CN](usage-guide.zh-CN.md) | Installation, admin setup, Git providers, member onboarding, daily workflows, command and configuration reference, Windows, FAQ |
| [Product Overview](product-overview.md) | [en](product-overview.md) · [zh-CN](product-overview.zh-CN.md) | Product architecture, the three capability layers, supported agents |
| [CI examples](../examples/ci/README.md) | zh-CN only | Sample pipelines for MR knowledge extraction and teamwiki lint |

## For maintainers

| Document | Languages | What it covers |
| --- | --- | --- |
| [Contributing](../.github/CONTRIBUTING.md) | en | Development setup, project layout, coding style, testing guidelines |
| [CI E2E Setup](dev/ci-e2e-setup.md) | en | Secrets and fixture repos the `e2e` job needs on GitHub Actions |
| [CI Code Erosion](dev/ci-code-erosion.md) | en | The informational SlopCodeBench report posted on every PR |
| [Adding a Git provider](dev/adding-a-provider.md) | en | Provider layer internals, CLI resolution on Windows, steps for a new provider |
| [Changelog](../CHANGELOG.md) | en | Release notes |

## Design documents

[`designs/`](designs/README.md) holds one document per feature design, in English. Its index states, for each one, whether the design is implemented, in progress, or still a proposal.

## Conventions

- User-facing documents come in English (`name.md`) and Simplified Chinese (`name.zh-CN.md`; guide pages use `guide/<page>.md` and `guide/zh-CN/<page>.md`), each with a language switcher at the top. Keep both in sync when behavior changes; documents marked "zh-CN only" above are the ones still missing an English version.
- Maintainer-only documents live in `dev/` and design documents in `designs/`. Both are English only.
- Command and flag usage comes from the CLI's own `--help` and the generated `skill-data/core/references/commands.md`. Documents link there instead of copying.
