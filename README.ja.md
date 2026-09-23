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

**チームが AI とともに働き、学び、改善し続けるための共通基盤。**

TeamAI は個人の AI 能力をチーム共有の能力へと変え、Agent・マシン・メンバーをまたいで活用できるようにします。

## なぜ TeamAI なのか

<p align="center">
  <img src="assets/use-cases.png" alt="8 つの日常シーン：TeamAI 導入前と導入後" width="100%">
</p>

## クイックスタート

次の一文を AI ツールに送るだけ:

```text
teamai skill をインストールして: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , teamai skill を読み込み、チームの TeamAI をゼロから構築して。
```

TeamAI をセットアップしたら、AI ツールで `/teamai` skill に話しかけるだけ:

**チームをゼロから構築**

```text
/teamai チームの TeamAI をゼロから構築して
```

**チームに参加**

```text
/teamai チームの TeamAI に参加したい、リポジトリ URL は https://github.com/your-org/your-repo
```

**チームに共有する**

Skills、Rules、MCP など、Agent が使えるリソースはすべて共有できます:

```text
/teamai xxx skill をチームに共有して
```

**ダッシュボードを開く**

```text
/teamai TeamAI ダッシュボードを開いて
```

<details>
<summary>コマンドラインでインストール</summary>

### インストール

```bash
npm install -g teamai-cli
```

### チーム管理者 / 個人利用

Git ホスト（GitHub、GitLab、GitCode、CNB、TGit、またはプライベート Git サービス）に共有リポジトリを作成し、**チームメンバーに書き込み権限を付与**してから、`teamai init https://github.com/your-org/your-repo` を実行します。

> **まだチームリポジトリがない場合は？** 本番向けの skills、rules、review agents が入ったテンプレートから始められます。[teamai-hub](https://github.com/teamai-hub) org を開き、**Fork** してから、新しいリポジトリに対して `teamai init` を実行してください。

### チームメンバー

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/your-org/your-repo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/your-org/your-repo --scope user
```

初期化後は、管理者が公開した最新の skills / rules などの Harness 更新が、AI セッション開始時に自動で取り込まれます。手動同期は不要です。

</details>

## 詳細情報

- [Usage Guide](docs/usage-guide.md) — setup, onboarding, daily workflows, and commands
- [Product Overview](docs/product-overview.md) — architecture, capabilities, and agent support
- [Git Providers](docs/providers.md) — supported repository providers
- [Windows Setup](docs/windows-hooks.md) — hooks and shell configuration
- [Technical Designs](docs/designs/) — design documents and proposals

## コントリビューター

TeamAI に貢献してくださったみなさんに感謝します。

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

[contrib.rocks](https://contrib.rocks) で生成しています。

## コントリビュート

コミュニティでの交流、Issue、PR を歓迎します。開発の進め方は [CONTRIBUTING.md](.github/CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](LICENSE)
