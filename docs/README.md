# TeamAI CLI documentation

> [English](README.md) | [简体中文](README.zh-CN.md)

Index of everything under `docs/`. The `/teamai` skill (`skills/teamai/` and `skill-data/`) is written for AI agents, so it is not listed here.

## For users

New to TeamAI? Start with [Getting Started](guide/getting-started.md).

| Document | What it covers |
| --- | --- |
| [Usage Guide](usage-guide.md) | Installation, setup demos, Git providers, member onboarding, daily workflows, command and configuration reference, Windows, FAQ |
| [Product Overview](product-overview.md) | Product architecture, core concepts, the three capability layers, supported agents |
| [CI examples](../examples/ci/README.md) | Sample pipelines for MR knowledge extraction and teamwiki lint |

## For maintainers

| Document | What it covers |
| --- | --- |
| [Contributing](../.github/CONTRIBUTING.md) | Development setup, project layout, coding style, testing guidelines |
| [CI E2E Setup](dev/ci-e2e-setup.md) | Secrets and fixture repos the `e2e` job needs on GitHub Actions |
| [CI Code Erosion](dev/ci-code-erosion.md) | The informational SlopCodeBench report posted on every PR |
| [Adding a Git provider](dev/adding-a-provider.md) | Provider layer internals, CLI resolution on Windows, steps for a new provider |
| [Changelog](../CHANGELOG.md) | Release notes |

## Design documents

[`designs/`](designs/README.md) holds one document per feature design. Its index states, for each one, whether the design is implemented, in progress, or still a proposal.
