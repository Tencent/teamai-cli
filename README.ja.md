<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

# TeamAI — Make Every Team AI Native

> [English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [ไทย](README.th.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamAI は、チームの Skills、Rules、MCP、ナレッジを Claude Code、Codex、CodeBuddy、WorkBuddy、OpenCode、Cursor などの AI Agents 横断で管理します。

## コントリビューター

TeamAI に貢献してくださったみなさんに感謝します。

<a href="https://trendshift.io/repositories/123184?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-123184" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/123184" alt="Tencent%2Fteamai-cli | Trendshift" width="250" height="55"/></a>

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

[contrib.rocks](https://contrib.rocks) で生成しています。

## クイックスタート

### インストール

```bash
npm install -g teamai-cli
```

### チーム管理者 / 個人利用

Git ホスト（GitHub、GitLab、GitCode、CNB、TGit、またはプライベート Git サービス）に共有リポジトリを作成し、**チームメンバーに書き込み権限を付与**してから、`teamai init https://github.com/yourorg/yourrepo` を実行します。

> **まだチームリポジトリがない場合は？** 本番向けの skills、rules、review agents が入ったテンプレートから始められます。[teamai-hub](https://github.com/teamai-hub) org を開き、**Fork** してから、新しいリポジトリに対して `teamai init` を実行してください。

### チームメンバー

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/yourorg/yourrepo --scope user
```

初期化後は、管理者が公開した最新の skills / rules などの Harness 更新が、AI セッション開始時に自動で取り込まれます。手動同期は不要です。

> **完全な利用ガイド:** [docs/usage-guide.md](docs/usage-guide.md)（[中文版](docs/usage-guide.zh-CN.md)）— チーム作成から日常利用までをカバーします。

## プロダクトアーキテクチャ

**Team Execution × Team Context (beta) × Team Improvement (beta)**:

| レイヤー | 役割 | 本 CLI での現状 |
|----------|------|-----------------|
| **Team Execution** | どの Agent もチームのやり方で動かす | `init` / `pull` / `push`、skills、rules、agents、hooks、MCP、env |
| **Team Context** (beta) | どの Agent もチームを理解する | recall、learnings、codebase graph、teamwiki... |
| **Team Improvement** (beta) | 毎回の実行がチームを強くする | 摩擦ベースの share-learnings、sessions、digest、dashboard... |

## 概要

<table>
  <thead>
    <tr>
      <th rowspan="2">Agent</th>
      <th colspan="7">Team Execution</th>
      <th colspan="3">Team Context (beta)</th>
      <th colspan="3">Team Improvement (beta)</th>
    </tr>
    <tr>
      <th>skills</th><th>rules</th><th>docs</th><th>env</th><th>agents</th><th>hooks</th><th>mcp</th>
      <th>learnings</th><th>codebase</th><th>teamwiki</th>
      <th>usage</th><th>sessions</th><th>dashboard</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Claude Code</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Codex</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Cursor</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Kiro</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
  </tbody>
</table>

**Git プロバイダー** — GitHub · GitLab · GitCode · CNB · TGit · プライベート Git サービス。

### 配布コントロール

管理者が一度設定すれば、`teamai pull` 時に全メンバーへ届くチーム共通の設定です。

| 機能 | コマンド | 内容 |
|------|----------|------|
| **Projects** | `teamai projects` | 作業ディレクトリを 1 つ以上の論理プロジェクトに紐づけ、そのプロジェクトの skills、ナレッジ、隔離された learnings を同期します。Roles とは直交します。 |
| **Roles** | `teamai roles` | ロール → 名前空間の対応を定義し、各メンバーが自分のロール向け skills だけを同期するようにします。 |
| **Tags** | `teamai tags` | skills / rules にタグを付け、メンバーは必要なタグだけを購読します。 |
| **Sources** | `teamai source` | 追加の skill リポジトリを購読します。他チームの公開リポジトリや、自組織内の共有/公開リポジトリが対象です。購読した skills は pull 時に自動同期されます。 |

learnings の隔離: リポジトリ直下の `learnings/` は全員で共有、`learnings/<project-id>/` はプロジェクト専用です。詳細は [usage guide](docs/usage-guide.md#multi-project-project-as-a-dimension-orthogonal-to-role) を参照してください。

## Team Execution

> One Team. One Harness. Every Agent.

TeamAI は skills、rules、docs、hooks を共有 Git リポジトリに置き、「push → レビューしてマージ → pull」の流れで各メンバーのローカル AI ツールへ配布します。他チームや共有リポジトリの Harness 購読にも対応します。

### 仕組み

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

### 共有されるもの

各リソースはすべての Agent に届けられます。

| リソース | チームリポジトリ内 | 備考 |
|----------|-------------------|------|
| **Skills** | `skills/<name>/SKILL.md` | |
| **Rules** | `rules/*.md` | |
| **Docs** | `docs/` | プロジェクトの基礎ドキュメント。デフォルトでは全件読み込みません（progressive disclosure） |
| **Agents** | `agents/<name>.yaml` | |
| **Culture** | `culture.md` | チームのミッション、価値観、働き方の原則。各 Agent の CLAUDE.md / AGENTS.md に注入され、すべてのセッションに引き継がれます |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | チーム共通の環境変数とスイッチ。secrets は置かないでください |
| **Hooks** | `hooks/hooks.yaml` | 各 hook に `roles:` を付け、該当ロールを持つメンバーにだけ届けることができます |
| **MCP** | `mcp/mcp.yaml` | 各 server に `roles:` を付け、該当ロールを持つメンバーにだけ届けることができます |
| **Packages** | `teamai.yaml` | 現時点では npm パッケージと Claude Code plugins のみ |
| **Models** | — | まだすべての provider には未対応です |

ファイル形式と一連のワークフローは [Usage Guide](docs/usage-guide.md) を参照してください。

## Team Context (beta)

> Every agent understands how the team works.

Harness の配布に加え、TeamAI は蓄積したチーム経験とコード構造を検索可能なナレッジベースに整理し、必要に応じて AI が自動で recall します。

### 経験の自動共有

セッション終了時、Stop hook は **friction**（摩擦）でスコアします。これは「覚えておく価値がある」兆候です。AI を中断・訂正した、ツール呼び出しを拒否した、失敗したツールを AI が何度も再試行した、などです。長くても順調なセッション（ツール呼び出しは多いが摩擦がない）では発火しません。本当に問題と向き合ったセッションだけが対象です。スコアが十分高いと、AI は次のように提案します。

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

ヒントには、発火のきっかけになった非ゼロの friction シグナルが入ります。取得できる場合は、最初のタスクをマスクした 1 行要約も付きます。`/teamai-share-learnings` skill はセッションを要約し、learning ドキュメントをチームリポジトリへ直接 push します。各セッションへの提示は最大 1 回です。チームは `teamai.yaml` の `sharing.contributeHint.enabled: false` でヒントだけをオフにできます（メンバー側はローカル設定の `contributeHintEnabled`）。Stop hook のほかの処理はそのまま残ります。

### Team Knowledge Recall

タスクの前に、蓄積したチームナレッジを AI が自動検索できるようにします。この機能は **デフォルトオフ** で、明示的に有効化する必要があります。チームは `teamai.yaml` で `sharing.recall.enabled: true` をデフォルトにでき、メンバーはローカルで上書きできます。

```bash
teamai recall enable     # on: deploy the teamai-recall subagent + inject guidance rules
teamai recall disable    # off: remove the subagent and rules
teamai recall status     # show effective state (team default + user override)
```

**検索は subagent 経由**です。有効化後、`teamai pull` は組み込みの `teamai-recall` subagent を各 AI ツールの `agents/` に配備します。AI はタスク前にこれを呼び出します。subagent がキーワードを抽出し、検索を実行し、ヒットしたソースファイルを読んで、チームナレッジの構造化サマリーを返します。先に関連性の事前チェック（`teamai recall --check`）を行い、タスクがチームナレッジと無関係なら検索自体をスキップします。内部では `teamai recall` コマンドをシェル実行しており、手動でも同じコマンドを使えます。

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
Matched: conflict | Missing: port
```

### Codebase Knowledge Graph

`teamai import` はソースリポジトリを解析し、`teamwiki/` 配下の構造化グラフにします。構造を意識した検索が可能になります。

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --extract /path/to/repo     # local extract into teamwiki/
teamai codebase --deep-enrich --project my-service --output /path/to/repo # generate deep knowledge docs
teamai codebase --reconcile --output /path/to/repo # map product docs to code pages
teamai codebase --lint --output /path/to/repo # check the locally extracted graph
```

extract は、AI enrichment をスキップした場合や成果が空でも、`teamwiki/evidence/code/<project>/_manifest.json` を書き出すので、`--deep-enrich` から始められます。

グラフにはコンポーネント、インターフェース、設定、リポジトリ間の import エッジが入ります。`teamai recall` はこれを graph-boost の再ランキングに使います。
recall のヒットが codebase ページ由来のときは、結果に関連ソースパスを列挙する `Sources:` 行が付きます。Agent はリポジトリを最初から探索し直さず、コード変更の起点にできます。

エッジは 2 本のトラックが同時に走り、重複時は AST 側が優先されます。

- **AST track**（TypeScript/JavaScript、Python、Go）: WASM の [tree-sitter](https://tree-sitter.github.io/) パーサーが `import`/`require`、呼び出し箇所、TS の `implements` 句を、ファイル間の正確な `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` エッジに解決します（タグは `code-ast`、信頼度の重み付き）。
- **Heuristic track**（Java/Rust を含む全言語）: 正規表現ベースの抽出（タグは `code-heuristic`）。AST track が対象にしない言語もカバーします。

WASM パーサーは純粋な JavaScript 依存で、ネイティブのツールチェーンは不要です。何らかの理由で読み込めない場合、抽出は heuristic track にフォールバックし、`AST_UNAVAILABLE` の gap を記録します。`TEAMAI_SKIP_AST=1` を設定すると、heuristic のみの抽出を強制できます。

## Team Improvement (beta)

> Every execution makes the entire team smarter.

### Maintenance

skills とナレッジが増えたら、チームが使わなくなったものを整理します。`teamai recall maintenance` は信頼度の低い learnings をアーカイブし、古い skills、rules、docs をクリーンアップまたは更新候補として印付けします。

```bash
teamai recall maintenance --prune --dry-run      # preview
teamai recall maintenance --prune --archive      # archive unused learnings
teamai recall maintenance --update-quality       # draft updates for stale skills / docs
```

チームが AI ツールを実際にどう使っているかの洞察と、セッションの摩擦を共有の skills、rules、ナレッジへ変える出発点です。

| 機能 | コマンド | 表示内容 |
|------|----------|----------|
| **Usage** | `teamai digest` | チームの週次 digest — 直近 7 日の成功率、prompt、アクティブ時間、推定コスト、cache、訂正の傾向と、累計値。 |
| **Sessions** | `teamai session save` | プライバシーを除去したセッション要約（ツール列、prompt ターン、介入）。digest の Session Highlights の入力になります。 |
| **Dashboard** | `teamai dashboard` | ライブセッションと、直近 7 日をその前の 7 日と比較したローカルトレンドを示す Web dashboard。 |
| **KB Health** | `teamai dashboard` → KB Health | 組み込みの dashboard ページ。ナレッジベースの利用と健全性（タイプ別カバレッジ、よく recall されるエントリ、沈黙エントリ、recall トレンド、作者の貢献、メンテナンスコンソール）を報告します。 |

## コマンド

| コマンド | 説明 |
|----------|------|
| `teamai init` | 初期化: OAuth ログイン、リポジトリ連携、メンバー登録、hooks 注入 |
| `teamai pull` | チームリソースを取得し、ローカル AI ツールへ注入 |
| `teamai push` | ローカルリソースをブランチへ push し、Merge Request を開く |
| `teamai packages [install] [target]` | 宣言済みの npm パッケージと Claude plugins をインストール。target 指定時は `teamai.yaml` も更新。引数なしの `teamai packages` はすべてインストール、`teamai packages install <target>` は 1 件追加 |
| `teamai status` | ローカルとチームリポジトリの差分とリソース件数を表示。名前空間付き skills と入れ子の docs も含む |
| `teamai contribute` | セッション経験をチームリポジトリの `teamai-learnings` ブランチへ共有 |
| `teamai recall <query>` | チームナレッジベースを検索（BM25 + graph-boost） |
| `teamai recall enable/disable/status` | recall のオン/オフ、または状態確認 |
| `teamai recall promote [learningId]` | 信頼度の高い learning を正式ナレッジ（skills/rules/docs）へ昇格 |
| `teamai recall maintenance` | ナレッジベースの健全性を維持: 低信頼度 learnings の整理、信頼度スコアの書き戻し、古いエントリの印付け |
| `teamai import` | ナレッジを import（`--dir`、`--from-repo`、`--from-org`、`--from-repo-list`、`--from-mr`） |
| `teamai codebase --extract [path]` | コード事実を抽出し、`teamwiki/` 配下にローカルグラフを構築 |
| `teamai codebase --deep-enrich` | 抽出した evidence から深いナレッジドキュメントを生成 |
| `teamai codebase --reconcile` | プロダクトドキュメントと抽出したコードナレッジを突き合わせ |
| `teamai codebase --lint` | Knowledge graph の健全性チェック |
| `teamai ci extract-mr --url <url>` | CI: MR からナレッジを抽出、コメント投稿、マージ後に書き込み |
| `teamai members` | チームメンバー一覧 |
| `teamai projects` | 作業ディレクトリを 1 つ以上の論理プロジェクトに紐づけ |
| `teamai roles` | チームの roles と名前空間を管理 |
| `teamai tags` | タグベースの skill/rule フィルタを管理 |
| `teamai skill exclude add/remove/list` | ローカル同期から除外する skills を管理（[usage guide](docs/usage-guide.md#excluding-skills-you-dont-need)） |
| `teamai source` | skill 購読ソースを管理（他チーム、または自組織の共有リポジトリ） |
| `teamai remove <type> <name>` | リソースを削除し、MR を開く |
| `teamai session save` | プライバシー除去済みのセッション要約を月次ログへ記録（`--push` は `digest` へ供給） |
| `teamai digest` | チーム利用の週次 digest を生成 |
| `teamai doctor` | 設定の問題を診断（`--json` で JSON 出力、CI・hook・agent 向け）|
| `teamai uninstall` | すべての teamai リソースと hooks を削除 |

## ライセンス

[MIT](LICENSE)

## コントリビュート

PR を歓迎します。先に [CONTRIBUTING.md](.github/CONTRIBUTING.md) を読んでください。
