<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

<h1 align="center">TeamAI — Make Every Team AI Native</h1>

<p align="center">
  <a href="https://trendshift.io/repositories/123184?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-123184" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/123184" alt="Tencent%2Fteamai-cli | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.th.md">ไทย</a>
</p>

<p align="center">
  <a href="https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml"><img src="https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/teamai-cli"><img src="https://img.shields.io/npm/v/teamai-cli.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/teamai-cli"><img src="https://img.shields.io/npm/dm/teamai-cli.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

**The shared foundation for how your team works, learns, and improves with AI.**

TeamAI turns individual AI capabilities into shared team capabilities — across agents, machines, and team members.

## Why TeamAI

<p align="center">
  <img src="assets/use-cases.png" alt="Eight everyday scenarios, before and after TeamAI" width="100%">
</p>

## Quick Start

Send this one line to your AI tool:

```text
Install the teamai skill: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , load the teamai skill, then set up TeamAI for my team from scratch.
```

Once TeamAI is set up, just talk to the `/teamai` skill in your AI tool:

**Set up a team from scratch**

```text
/teamai Help me set up TeamAI for my team from scratch
```

**Join a team**

```text
/teamai Help me join my team's TeamAI, repo URL is https://github.com/your-org/your-repo
```

**Share with the team**

Skills, rules, MCP servers, and other agent resources can all be shared:

```text
/teamai Share my xxx skill with the team
```

**Open the dashboard**

```text
/teamai Open the TeamAI dashboard
```

<details>
<summary>Command-line install</summary>

### Install

```bash
npm install -g teamai-cli
```

### Team admin / solo user

Create a shared-experience repo on your git host (GitHub, GitLab, GitCode, CNB, TGit, or a private Git service), **grant write access to team members**, then run `teamai init https://github.com/your-org/your-repo`.

> **No team repo yet?** Start from a template pre-loaded with production-ready skills, rules, and review agents. Browse the [teamai-hub](https://github.com/teamai-hub) org, click **Fork**, then `teamai init` against your new repo.

### Team members

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/your-org/your-repo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/your-org/your-repo --scope user
```

Once initialized, every AI session automatically pulls the latest skills / rules and other Harness updates published by admins — no manual sync needed.

</details>

## Learn More

- [Usage Guide](docs/usage-guide.md) ([中文版](docs/usage-guide.zh-CN.md)) — setup, onboarding, daily workflows, and commands
- [Product Overview](docs/product-overview.md) ([中文版](docs/product-overview.zh-CN.md)) — architecture, capabilities, and agent support
- [Git Providers](docs/providers.md) — supported repository providers
- [Windows Setup](docs/windows-hooks.md) ([中文版](docs/windows-hooks.zh-CN.md)) — hooks and shell configuration
- [Technical Designs](docs/designs/) — design documents and proposals

## Contributors

Thanks to everyone who has contributed to TeamAI!

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

## Contributing

Join the conversation, or open an issue or PR. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to contribute.

## License

[MIT](LICENSE)
