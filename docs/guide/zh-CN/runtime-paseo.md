# Paseo 运行时

> 本文是 [工作流](workflow.md) 的一部分。

`teamai-runtime-paseo` 把每个提示词步骤作为 [Paseo](https://github.com/getpaseo/paseo) 守护进程的智能体运行，放在 teamai 交给该步骤的目录上的一个 Paseo 工作区里：只读步骤用你的检出目录，其余步骤用 teamai 准备的 worktree、克隆或团队仓库克隆。你在 Paseo 应用里查看智能体、回答它的权限请求。读取结果、提交、交付、评分和恢复仍由 teamai 负责。

它只运行提示词步骤。命令交给定义里的下一个运行时，或留在本机。带 `setup` 的提示词步骤交给下一个能运行它的运行时；`teamai-paseo` 没有列出这样的运行时，所以在那里它以 `requirement_unmet` 失败。需要 `permissions: unattended` 的提示词步骤，交给下一个能运行它的运行时。带 `role` 的步骤在这里运行，使用 teamai 交付到其副本中的角色：运行时只在 Paseo 里打开这个副本，而 Paseo 只在它自己创建的 worktree 里运行项目的 worktree setup，所以不会有别的东西把你自己的资源交付进去。它也以 best-effort 评判被评分的轮次，见[评判被评分的轮次](#评判被评分的轮次)。

## 快速开始

Paseo 是前置条件：teamai 不附带它的任何代码。在运行工作流的机器上安装 Paseo（0.14.0 或更高版本），并启动它的守护进程：

```sh
npm install -g @getpaseo/cli
paseo start
paseo status    # listen: 127.0.0.1:6767
```

运行时启动时从这次安装加载 Paseo 的客户端：它顺着 `PATH` 上的 `paseo` 找到其所在的包，所以客户端始终与你的守护进程一致。teamai 运行时的 `PATH` 里没有 `paseo` 时，自己指定客户端。安装在单独前缀下时：

```sh
npm install -g --prefix ~/.paseo-cli @getpaseo/cli
export PASEO_CLIENT_PATH=~/.paseo-cli/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/client
```

改用 Paseo 桌面应用时，从应用里安装它的命令行工具，它会把 `paseo` 链接到 `~/.local/bin`。即使 teamai 的 `PATH` 里没有 `~/.local/bin`，运行时也会在那里找到它。应用把客户端放在自己的归档文件里，所以运行时按应用构建把客户端解包一次到 `~/.teamai/runtime-state/paseo-client`，并按应用记录的 SHA-256 校验每个文件。

teamai 自带一个定义，把提示词步骤交给本机的守护进程，其余步骤留在本机。`--driver paseo` 用的就是它：

```yaml
# drivers/teamai-paseo.yaml，随 teamai 提供
schemaVersion: v1alpha1
name: teamai-paseo
description: Run each prompt step as an agent of the Paseo daemon on this machine, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: paseo
    options: { max_parallel: 4 }
```

它连接你的 Paseo 配置所指的守护进程，读法与 `paseo start` 相同：`$PASEO_HOME/config.json`（默认 `~/.paseo/config.json`）中的 `daemon.listen`，没有时为 `127.0.0.1:6767`。守护进程在其他地址，或需要其他选项时，在团队仓库或 `~/.teamai/drivers/` 里添加你自己的定义，如下面的示例所示。

工作流不需要任何 Paseo 专用字段：

```yaml
# workflows/paseo-review.yaml
schemaVersion: v1alpha1
name: paseo-review
description: Count the files, then ask a Claude agent in Paseo whether the README has a title.
steps:
  - id: count
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('fs').readdirSync('.').length}))"
    output:
      files: number
  - id: classify
    needs: [count]
    workspace: new
    tool: claude
    model: { name: claude-sonnet-5-5 }
    prompt: |
      Read README.md and say whether it starts with a Markdown title.
      Answer with the output {"has_title": true} or {"has_title": false}.
    output:
      has_title: boolean
```

```sh
teamai workflow start paseo-review --driver paseo
```

```text
ℹ Run r0769801107010602 started. If it stops before it ends, continue it here with: teamai workflow resume r0769801107010602, or hand it to another machine with: teamai workflow publish r0769801107010602
{"data":{"done":{"run":"r0769801107010602","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`count` 在本机运行。`classify` 在 Paseo 里、在 teamai 的 worktree 中运行：

```text
$ paseo inspect 9b38e203
Name      teamai classify · r0769801107010602
Provider  claude
Model     claude-sonnet-5-5
Mode      auto
Cwd       /repo/.teamai/workflow-worktrees/teamai-r0769801107010602-classify-p1-4e57d9b3cff1
```

每个智能体都带有 `teamai-run` 和 `teamai-step` 标签，可以这样列出一次运行的智能体：

```sh
paseo ls --all --label teamai-run=r0769801107010602
```

从 Paseo 智能体内部启动的运行（Paseo 会在每个智能体的 shell 中设置 `PASEO_AGENT_ID`），还会给每个步骤智能体和评判智能体加上 `teamai-parent=<agent>` 标签，步骤提示词的第一行会链接回该智能体：

```text
This agent runs step "classify" of teamai workflow run r0769801107010602, started from the Paseo agent paseo://h/srv_vL5abcnfKUWY/agent/1f78c282-039d-452f-9621-bb6677c76eec.
```

```sh
paseo ls --all --label teamai-parent=1f78c282-039d-452f-9621-bb6677c76eec
```

智能体工作时，仪表盘的运行详情会显示它，并附带在 Paseo 中打开它的链接：

```json
{ "label": "teamai classify · r7f54a1690b9ae0ce", "url": "paseo://h/srv_vL5abcnfKUWY/agent/5f95baae-9117-42b7-9e3d-47891dd3e84d", "fields": { "agent": "5f95baae-9117-42b7-9e3d-47891dd3e84d", "workspace": "wks_f55e98406bad64bd", "model": "claude/claude-sonnet-5-5" } }
```

步骤记录里有它的输出和 Claude 的会话 id：

```json
{ "id": "classify", "outcome": "success", "outputs": { "has_title": true }, "tool": "claude", "session": "35ab4949-21d9-40df-9444-652e96607b7b" }
```

## 评判被评分的轮次

带 `scorers` 的步骤由 `teamai-score` 工作流评判：它的记账命令在本机运行，评判则是一个受限提示词，只读一个证据目录，别的都不读。Paseo 回答这个提示词，所以只有 `paseo` 的定义在 teamai 自己不启动任何工具的机器上也能运行并评判被评分的步骤：

```yaml
# drivers/paseo-only.yaml
schemaVersion: v1alpha1
name: paseo-only
tool: claude
runtimes:
  - use: paseo
```

该步骤由 [`review-quality`](scorers.md) 评判，每个轮次都评判：

```yaml
# workflows/fix-add.yaml
schemaVersion: v1alpha1
name: fix-add
description: Fix add in math.js, and judge the change.
steps:
  - id: fix
    workspace: new
    prompt: |
      add in math.js returns a - b. Make it return a + b, and add math.test.js that checks add(2, 3) is 5 with node:test.
      Edit the files only, and run no command.
    scorers: { names: [review-quality], sampling: all }
    output:
      fixed: boolean
```

```text
$ command -v claude codex opencode
$ teamai workflow start fix-add --driver paseo-only
ℹ Run rd573bcff8eef4e10 started. If it stops before it ends, continue it here with: teamai workflow resume rd573bcff8eef4e10, or hand it to another machine with: teamai workflow publish rd573bcff8eef4e10
ℹ run:rd573bcff8eef4e10:fix:1: review-quality good (teamai-score run re02e01c9b0e36c69).
{"data":{"done":{"run":"rd573bcff8eef4e10","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

在这次有人值守的运行里，fix 智能体在两次编辑前各询问一次，用 `paseo permit allow <agent> --all` 回答。评判什么都没问：它只用 `Read` 读了那个目录。

两个智能体都在 Paseo 里运行。评判智能体的 cwd 是 teamai 写好的证据目录：

```text
$ paseo ls --all
NAME                                       PROVIDER                STATUS  CWD
teamai score[0].judge · re02e01c9b0e36c69  claude/claude-opus-5-5  closed  ~/.teamai/projects/…/runs/re02e01c9b0e36c69/scratch/a47d92bbe
teamai fix · rd573bcff8eef4e10             claude/claude-opus-5-5  closed  /repo/.teamai/workflow-worktrees/teamai-rd573bcff8eef4e10-fix-p1-a04485788cc1
```

评判步骤记录运行时保持的级别：

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The step asked for two things: change add in math.js from a - b to a + b, and add math.test.js that uses node:test to check add(2, 3) is 5… The diff does both…" } }, "confined": { "tool": "claude", "isolation": "best-effort", "access": "read" } }
```

评判以 `best-effort` 运行，从不是 `verified`：

| 内容 | 是否强制 |
| --- | --- |
| 一个全新的智能体，cwd 是证据目录，并被告知只读这个目录 | 是 |
| 不编辑，也不运行工具自身规则未允许的命令：评判所用模式会先询问，而任何权限请求都会结束评判，无论有无人值守 | 是 |
| 它的回答是最后一条消息，按 JSON 解析；它什么都不写 | 是 |
| 不读目录之外的文件 | 否：没有什么能阻止智能体读取别处的文件 |
| 不访问网络 | 否 |

`confined.json` 要求 `verified` 的受限步骤从不交给 Paseo，因为 Paseo 提供的是 `best-effort`。评判的位置在其智能体启动前，在运行详情里显示为 `Paseo confined prompt, best-effort`。

Codex 评判以 `auto` 模式启动，并把 Codex 的沙箱设为 `read-only`，因为 Paseo 列出的每种 Codex 模式都会不经询问就写入。Codex 用 shell 命令读文件，所以它的说明要求只用只读命令；沙箱不经询问就运行这些命令，其他任何操作都会询问并结束评判。`tool` 为 `codex` 的定义会让步骤和它的评判都在 Codex 上运行：

```yaml
# drivers/paseo-codex.yaml
schemaVersion: v1alpha1
name: paseo-codex
tool: codex
runtimes:
  - use: paseo
```

下面是 Codex 评判在产生这一轮的同一次运行中为它打标签：

```text
$ teamai workflow start fix-add --driver paseo-codex
ℹ run:r0cec7811f0b8ad80:fix:1: review-quality good (teamai-score run r6f8bb28e533b1c3b).
$ paseo logs 94f534b --filter tools
[Shell] ls -la
[Shell] ls -la transcripts
[Shell] cat 'transcripts/fix#1.md'
[Shell] cat 'diff.patch'
[Shell] cat 'evidence.json'
```

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The diff changes add to return a + b and adds a node:test assertion that add(2, 3) equals 5. The session shows no commands were run, as requested; the test was added but not executed." } }, "confined": { "tool": "codex", "isolation": "best-effort", "access": "read" } }
```

评分从守护进程的智能体写入会话的地方读取步骤的会话：守护进程所属用户的工具主目录。对 Claude，运行时从 Paseo 读取这个主目录（`claude auth status` 中的 `configDirectory`，Claude Code 2.1 起提供），所以守护进程以其他 `HOME` 或 `CLAUDE_CONFIG_DIR` 启动时，只要 teamai 能读取该目录，它的会话照样会被归档和评分。下面这次运行中，teamai 用的是自己的 `HOME`，守护进程则在成员的 `HOME` 里运行 Claude：

```text
$ teamai workflow start fix --driver paseo-only
✔ Archived 1 step session of r2fa599b2abbe0d09 to teamai-reports (scrubbed)
{"data":{"done":{"run":"r2fa599b2abbe0d09","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

较旧的 Claude 不报告自己的主目录；对它，或对以其他用户运行的守护进程，请让守护进程以运行 teamai 的成员身份、在同一台机器上运行。否则这一轮不会被打标签，评分运行的 `evidence` 步骤会说明原因：

```text
evidence_missing: Pass 1 of step fix in run r080799f10648b1ed cannot be scored: no longer on this machine: claude-code session 346fd0be-1a5a-474b-aedf-24c305d5c1a6 of fix#1. Restore what is missing, or score another pass.
```

Codex 步骤的一轮也以同样方式评分。Paseo 不报告 Codex 的主目录，所以守护进程在本机时，运行时按会话 id 依次在你的 `CODEX_HOME`、你账户主目录下的 `.codex`、`$HOME` 下的 `.codex` 中查找该步骤的会话，并报告存有它的那个主目录：teamai 在那里读取会话，即使它用自己的 `HOME` 运行也一样。teamai 关闭尝试时，Paseo 归档该智能体，Codex 把会话移到 `archived_sessions/`，teamai 仍能在那里找到它。守护进程的 Codex 写入其他根目录，或守护进程在另一台机器上时，除非 teamai 在 `teamai init` 时记录的 Codex 根目录中有这个会话，否则这一轮不会被打标签：

```text
evidence_missing: Pass 1 of step fix in run ra429df3ad473c7b3 cannot be scored: no longer on this machine: codex session 01a1a731-9053-7cf2-9884-68058745044a of fix#1. Restore what is missing, or score another pass.
```

OpenCode 步骤的一轮也以同样方式评分。OpenCode 把所有会话存放在其数据目录（`XDG_DATA_HOME`，默认为 `~/.local/share`）下的一个数据库中，所以守护进程在本机时，运行时报告存有 `opencode/opencode.db` 的那个数据目录：依次是其 Paseo 提供方 `env` 所设的目录、你的 `XDG_DATA_HOME`、`$HOME` 下的 `.local/share`、你账户主目录下的 `.local/share`。teamai 在那里读取会话，即使它用自己的 `HOME` 运行也一样。守护进程在另一台机器上时，teamai 在它自己的数据目录中读取。

## 选项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | `$PASEO_HOME/config.json` 中 `daemon.listen` 所指的地址，没有时为 `ws://127.0.0.1:6767/ws` | Paseo 守护进程的 WebSocket 地址：`ws://`、`wss://`，Unix 套接字则为 `ws+unix://<套接字路径>:/ws`。 |
| `mode` | 每个工具在 Paseo 中的默认模式，但从不是一个从不询问的模式 | 每个工具的智能体启动时所用的 Paseo 模式，例如 `{ claude: plan }`。它必须是 Paseo 为该工具列出的模式。指定一个从不询问的模式，就是你主动选择完全访问（见 [工具、模型和模式](#工具模型和模式)）。 |
| `providers` | 运行每个团队实例的自定义提供方，没有时为 teamai 添加的那个 | 工具或团队实例所用的 Paseo 提供方 id，例如 `{ acme-claude: claude-acme }`（见 [团队工具实例](#团队工具实例)）。 |

`max_parallel` 是 teamai 自己的键，见 [运行时选项](workflow-advanced.md#运行时选项)。Paseo 本身没有并发上限。

```yaml
# drivers/paseo-7070.yaml
schemaVersion: v1alpha1
name: paseo-7070
description: Run prompt steps as agents of the Paseo daemon on port 7070, and the rest here.
runtimes:
  - use: paseo
    options:
      url: ws://127.0.0.1:7070/ws
  - use: tools
```

## 工具、模型和模式

只要工具的可执行文件在守护进程的 `PATH` 上，Paseo 就称它可用，不论是否已登录。运行时只在 Paseo 表明工具能在那里运行时才提供它；否则，使用该工具的步骤交给下一个运行时。步骤的智能体以 Paseo 为该工具设定的默认模式启动（`paseo provider ls` 中的 `DEFAULT MODE`），从不使用从不询问的绕过权限模式：默认模式是这种模式时，智能体改用 Paseo 列表中排在它前面、最接近它的模式，运行开始时会说明一次：

```text
⚠ Step runtime "paseo": Paseo starts claude in mode bypassPermissions by default, which never asks before it acts; teamai starts its claude steps in mode auto, the nearest one before it in Paseo's list that asks.
```

`mode` 选项让你自己选择模式，覆盖 Paseo 的默认模式。指定一个从不询问的模式，例如 Claude 的 `bypassPermissions` 或 Codex 的 `full-access`，就是明确选择完全访问，例如用于运行在独立虚拟机中的守护进程。teamai 会在启动时警告一次，并把这些步骤的隔离级别记为 `none`。设置了 `permissions: unattended` 的步骤仍然不会在 Paseo 上运行：

```yaml
# drivers/paseo-in-vm.yaml
schemaVersion: v1alpha1
name: paseo-in-vm
runtimes:
  - use: paseo
    options:
      mode: { claude: bypassPermissions }
  - use: tools
```

```text
$ teamai workflow start fix --driver paseo-in-vm
⚠ Runtime paseo of driver paseo-in-vm runs steps in full access on this machine, as drivers/paseo-in-vm.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

Paseo 设定的默认模式或 `mode` 指定的模式不在它为该工具列出的模式中时，不提供该工具。评判以一个在编辑或运行任何东西前先询问的模式启动：

| 工具 | 何时提供 | 步骤模式 | 评判模式 |
| --- | --- | --- | --- |
| `claude` | 守护进程主机上的 `claude auth status` 显示 `"loggedIn": true`：账号登录或 API key 均可 | Paseo 的默认模式：Paseo 0.14.0 上为 `auto` | `default` |
| `codex` | 守护进程在本机运行（`url` 是回环地址，如 `127.0.0.1` 或 `localhost`，或是 Unix 套接字），且 `codex login status` 显示 `Logged in` | Paseo 的默认模式：Paseo 0.14.0 上为 `auto-review` | `auto`，沙箱为 `read-only` |
| `opencode` | Paseo 为它列出了模型：OpenCode 连上了模型提供方，包括它的免费模型。Paseo 在 OpenCode 自己的后台服务器上运行它时不提供（其主机上运行着该服务器时，Paseo 0.15 就会这样做），因为该服务器不给智能体任何环境变量；用 `opencode service stop` 停掉该服务器，然后运行 `paseo restart` | OpenCode 自己的默认模式 `build`：Paseo 没有为它设定 | `plan` |

Paseo 不报告 Codex 是否已登录，所以运行时自己用你的环境（`CODEX_HOME` 或 `~/.codex`）运行 `codex login status`。它运行的是 Paseo 诊断中 `Resolved path` 所指的 `codex`，即守护进程在它自己的 `PATH` 上找到的那个，而不是 teamai 的 `PATH` 上的。守护进程在其他任何地址上时（例如在另一台机器上），从不提供 Codex。这项检查看不到守护进程自己的环境，回环地址一律算作本机：请用你平时的 `CODEX_HOME` 启动守护进程，也不要让 `url` 指向通往另一台机器的隧道（`ssh -L`）。

即使守护进程一个工具都运行不了，运行时也会启动，所以运行中的命令步骤照样交给下一个运行时。驱动的任何运行时都运行不了的工具的步骤不启动智能体就失败，并说明要在守护进程主机上做什么：

```text
$ teamai workflow start fix-codex --driver paseo-only
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on codex, which the driver of this run cannot launch here: paseo: The Paseo daemon at ws://127.0.0.1:6767/ws cannot run codex: signed out; run `codex login` on the daemon's host. Or remove tool from the step.
```

想自己检查某个工具，就问守护进程或 Codex，看 `Auth` 和 `Resolved path` 这两行：

```text
$ paseo provider diagnostic claude | grep -A2 Auth
  Auth: {
  "loggedIn": true,
  "authMethod": "oauth_token",
$ paseo provider diagnostic codex | grep 'Resolved path'
  Resolved path: ~/.nvm/versions/node/v24.21.0/bin/codex
$ ~/.nvm/versions/node/v24.21.0/bin/codex login status
Logged in using ChatGPT
```

步骤的 `model` 必须是守护进程提供的模型，`effort` 必须是该模型支持的。不写 `model` 时，智能体使用守护进程的默认模型。

对 OpenCode 来说，这个默认模型可能是 OpenCode 的免费模型之一，它们不需要登录。OpenCode 没有标出默认模型时，智能体使用守护进程列出的第一个模型：

```text
$ paseo provider models opencode
ID                                    MODEL
opencode/crouton-alpha-free           Crouton Alpha Free
opencode/pulse-alpha-free             Pulse Alpha Free
github-copilot/gpt-6.1-terra          GPT-6.1 Terra
…
github-copilot/claude-sonnet-5.5      Claude Sonnet 5.5
```

这样，不写 `model` 的步骤或评判会把它的提示词，或它要评判的证据，发给 OpenCode 的免费提供方。固定模型，让它们留在你选定的提供方：

```yaml
# workflows/review-opencode.yaml
schemaVersion: v1alpha1
name: review-opencode
description: Review the branch on OpenCode, on a model the team chose.
steps:
  - id: review
    tool: opencode
    model: { name: github-copilot/claude-sonnet-5.5 }
    prompt: Review the change on this branch, and list what it gets wrong.
```

```markdown
<!-- scorers/review-quality.md -->
---
model: github-copilot/claude-sonnet-5.5
labels:
  - value: good
    score: 1
    description: The change does what the step asked, with tests.
  - value: bad
    score: 0
    description: The change does not do what the step asked.
passingScore: 1
---
Judge whether the change does what the step asked. Read the diff and the session.
```

守护进程没有的模型会在任何智能体启动前失败：

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

智能体拿到步骤的提示词。延续前面某个步骤会话的步骤，能延续时会在那个步骤的智能体里继续，见[延续步骤的对话](#延续步骤的对话)。守护进程在本机时，Claude 或 Codex 步骤会报告其会话记录的 token 数，在评分读取该会话的地方读取。只有守护进程提供的每个工具都报告 token 数时，有 token 预算的步骤才在这里运行：守护进程提供 OpenCode、在其他机器上运行、运行 Claude 却没有说明它的 home，或者把某个工具的会话保存在 teamai 无法读取的目录里（以其他用户身份运行的守护进程可能如此）时都不行。这时该步骤交给下一个运行时。teamai 仍然读不到 token 数的有预算步骤（例如会话记录超过 50 MiB）以 `budget_unmeasured` 失败，消息会说明原因和下一步。

## 团队工具实例

团队工具实例上的步骤，在 Paseo 中运行于它自己的 Paseo 自定义提供方上。守护进程在本机时，teamai 在第一个运行该实例的步骤开始时添加这个提供方，无论是否有人值守。该提供方以实例命名，扩展实例所属的工具，从你的 `PATH` 运行实例的命令；实例有自己的主目录时，还会把该工具的主目录变量设为它；实例命名了自己的变量时，也会设置那个变量。它会保留供以后的运行使用，运行会提示一次如何删除它：

```text
⚠ Step runtime "paseo", operation op-2b7e91c4d0a3: teamai added the Paseo provider acme-claude to the daemon at ws://127.0.0.1:6767/ws for its acme-claude steps: it extends claude and runs /Users/ana/.local/bin/acme-claude, with CLAUDE_CONFIG_DIR=/Users/ana/.claude-acme. It stays for later runs; to remove it, choose Remove provider on acme-claude in the Paseo app's provider settings, or delete agents.providers.acme-claude from /Users/ana/.paseo/config.json, then run `paseo daemon reload`. Paseo cannot show its agents' logs once it is gone, so read them first.
```

之后 `paseo daemon config get agents.providers --json` 会显示它添加的这一项，守护进程原有的每一项都保持不变：

```json
{ "acme-claude": { "extends": "claude", "label": "acme-claude", "command": ["/Users/ana/.local/bin/acme-claude"], "env": { "CLAUDE_CONFIG_DIR": "/Users/ana/.claude-acme" } } }
```

只有自己主目录的实例，例如 `claude-work`（`extends: claude`，`home: { dir: .claude-work, env: CLAUDE_CONFIG_DIR }`），会得到一个在该主目录中运行 Claude 自身命令的提供方，所以第二个 Claude 账户无需任何设置即可运行：

```json
{ "claude-work": { "extends": "claude", "label": "claude-work", "env": { "CLAUDE_CONFIG_DIR": "/Users/ana/.claude-work" } } }
```

守护进程已有合适的提供方时，就用那个：扩展实例所属工具、并运行其命令（按名称或指向它的绝对路径；守护进程所在主机运行 Windows 时，例如 `C:\Tools\acme-claude.exe`，teamai 从路径本身判断）的那个；对只有主目录的实例，则是运行该工具自身命令、且 `env` 中把该工具的变量（实例命名了自己的变量时也包括那个变量）设为该主目录的那个。它的步骤和评判沿用该工具的模式、授权和登录检查，它们的会话以实例命名。实例的登录和会话在其提供方 `env` 所设的主目录中查找，没有时在实例自己的主目录中查找；该提供方的主目录不是 teamai 为该实例使用的主目录时，运行会提示一次。未登录的实例会给出它自己的命令，例如 `CODEX_HOME=~/.codex-acme acme-codex login`；该 Codex 主目录尚不存在时，前面还会加上 `mkdir -p ~/.codex-acme && `，因为 Codex 拒绝不存在的主目录。

实例无法在 teamai 刚添加的提供方上运行时（例如未登录），teamai 会再次删除该提供方，所以失败的步骤不会在 Paseo 的配置中留下任何东西，之后的步骤会重新添加它。如果删除失败，步骤的失败信息会说明这一点，提供方可能保留，并给出上面的提示。

守护进程在另一台主机上、命令不在你的 `PATH` 上、实例名称不是合法的 Paseo 提供方 id（小写字母、数字和连字符），或同名提供方已运行别的东西时，teamai 不会添加提供方。此时不提供该实例，该实例上的步骤会说明该怎么做：

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: paseo: The Paseo daemon at ws://10.0.0.5:6767/ws cannot run acme-claude: no Paseo provider runs its command acme-claude, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends claude with command ["acme-claude"] (`paseo daemon config set agents.providers …`, then `paseo daemon reload`), or name one in the runtime's providers option. Or remove tool from the step.
```

有两个提供方都能运行该实例时，用 `providers` 选项指定要用的那个：

```yaml
# drivers/paseo-acme.yaml
schemaVersion: v1alpha1
name: paseo-acme
tool: acme-claude
runtimes:
  - use: paseo
    options:
      providers: { acme-claude: claude-acme }
  - use: tools
```

## 通过沙箱运行

`use: paseo` 的 runtime 条目加上 `through: sandbox` 后，每个 prompt step 的工具在 attempt 的沙箱里运行，agent 仍留在 Paseo 应用中。只有提供 attempt socket 的沙箱可用：`sbx`，或 Docker Desktop 上、这台 Linux 机器上 26.0.0 或更高（25.0.5、23.0.11）且镜像里有 `node` 的 `docker`，它们让工具连不到这台机器的端口（[步骤能连到什么](runtime-sandbox.md#步骤能连到这台机器的什么)）。使用其他沙箱时，open 会在任何 agent 启动前失败。Paseo 通过一个 Paseo 自定义 provider，把工具作为 teamai 的包装器 [`teamai-sandbox-<tool>`](runtime-sandbox.md#通过应用运行teamai-sandbox-tool) 来运行。当 daemon 运行在本机、且没有任何 provider 运行该包装器时，teamai 在第一次 open 时添加一个以包装器命名的 provider，并像团队实例那样在运行中提示一次：

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/paseo-sandboxed.yaml
schemaVersion: v1alpha1
name: paseo-sandboxed
runtimes:
  - use: paseo
    through: sandbox
    sandbox: containers
  - use: tools
```

```json
{ "teamai-sandbox-claude": { "extends": "claude", "label": "teamai-sandbox-claude", "command": ["/usr/local/bin/teamai-sandbox-claude"] } }
```

step 的 agent 创建时不带 prompt。teamai 先在 attempt 的 socket 上登记该 agent，再启动它的工具，直到沙箱确认该 agent 的包装器已连接才发送 prompt。若沙箱拒绝包装器，或包装器 30 秒内未连接，teamai 删除该 agent，step 以 `runtime_failed` 失败并注明 `isolation_unproven`，prompt 不会到达沙箱外的工具。崩溃后重新启动的 runtime 会再次登记该 agent。step 的会话从 attempt 的工具主目录读取。

包装器在 daemon 启动它时所用的 `HOME` 下查找 attempt，因此 daemon 必须使用与 teamai 相同的 `HOME`，由你自己启动两者时即是如此。若 daemon 以其他 `HOME` 启动，每个 step 都会以 `runtime_failed` 失败并注明 `isolation_unproven`；请在该 provider 的 `env` 中把 `HOME` 设为 teamai 的。

在 Paseo 上，OpenCode 不能通过沙箱运行：Paseo 可能让多个 agent 共用一个 OpenCode 服务，沙箱无法区分 step 的 agent 与其他 agent。

## 凭据

Paseo 以明文把智能体的环境变量存在它的 home 下，所以这个运行时不接受 `credentials`，给它凭据的定义会被 teamai 拒绝：

```text
{"error":{"code":"bad_option","message":"Runtime \"paseo\" of driver definition ~/.teamai/drivers/paseo.yaml refused option \"credentials\": paseo does not offer can.env, so it cannot keep a credential to the processes it is for. Fix the option and start again."}}
```

删掉这一项，改为在守护进程所在的机器上给工具它需要的东西：在那里登录该工具，或者把变量设在守护进程启动时的环境里，然后 `paseo restart`。智能体拿到的是守护进程的环境。

## 权限

Claude 智能体可以不经询问写两样东西：teamai 结果文件所在的目录（步骤也把证据留在这里），以及运行的临时目录，即运行的命令中 `$TEAMAI_RUN_DIR` 所指的目录。运行时允许 `Edit(/<结果目录>/**)` 和 `Edit(/<运行目录>/**)`，模式是 Paseo 启动它时的模式。Codex 智能体可以写同样两处：它在 `auto-review` 下的沙箱可写工作树，运行时再把结果文件所在目录和运行的临时目录加为可写根目录：

```json
{ "provider": "codex", "modeId": "auto-review", "providerOptions": { "sandbox_workspace_write": { "writable_roots": ["~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch"] } } }
```

OpenCode 智能体也可以写这两处：运行时通过 OpenCode 的 `external_directory` 权限放行它们，所以它只在碰工作树之外的其他东西前询问：

```json
{ "provider": "opencode", "providerOptions": { "permission": { "external_directory": { "~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out/*": "allow", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch/*": "allow" } } } }
```

步骤的环境变量里，智能体只拿到 `TEAMAI_RUN_DIR`，工作流目录的步骤还拿到 `TEAMAI_WORKFLOW_DIR`，所以提示词写明这两个目录中的某个文件时，它的效果与在本机相同。

智能体以其 daemon 运行所用的用户身份写结果文件。运行 teamai 的用户无法读取这个文件时，步骤失败，并写明是哪个文件：

```text
✖ Step "review" failed with tool_failed: claude wrote the result file <result file>, which teamai cannot read because it has no permission to read it. Let the user teamai runs as read <result file>, then retry the step
```

让运行 teamai 的用户可以读取该文件，然后运行 `teamai workflow retry <run> <step>`。

有人值守的运行里，其他权限请求在 Paseo 应用里等你回答，也可以在命令行回答：

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

无人值守的运行（`TEAMAI_MODE=unattended` 或 `CI`）里没人能回答，所以步骤失败，智能体停止。下面是一个提示词步骤 `count`，它让智能体运行 `ls -1 | wc -l`：

```text
✖ Step "count" failed with tool_failed: The claude agent asked for permission (Bash) in Paseo mode auto, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
```

智能体因工具的用量上限，或模型 API 返回的速率限制而停止时，步骤停下，消息带上工具的原话（包括重置时间）。步骤不会失败：额度重置前 teamai 不再用这个工具启动步骤，重置后再运行该步骤：

```text
⚠ Step "fix" stopped: The claude agent hit its usage limit in Paseo: You've hit your limit · resets 3pm (Europe/Madrid). teamai launches no more steps on claude until its limit resets, then runs the step again.
```

## 交互式步骤

在有人值守的运行中，`interactive: true` 的步骤作为一个 Paseo 智能体运行，你在 Paseo 应用里与它一起完成。它的提示词开头告诉智能体与你一起完成这个步骤，并且只在你说步骤完成后才写 teamai 的结果。智能体在你两次发言之间空闲时，步骤一直等待；结果写入后步骤结束。无人值守的运行中没有人可以协作，所以该步骤交给提供 HITL 的运行时，见 [HITL](workflow-advanced.md#hitl人在回路中)。

## 延续步骤的对话

带 `session.from` 或 `session: continue` 的提示词步骤，会在前面那个步骤的 Paseo 智能体里继续。teamai 把这个步骤作为该智能体的新一轮对话发送，所以它记得自己读过和说过的内容，运行记录把会话记为已恢复（resumed），只计这一轮的 token 数。满足以下条件时才这样做：

- 该智能体仍在 Paseo 中、没有被归档，它的那一轮已经结束，且没有其他步骤的一轮正在其中运行；
- 这个步骤在同一个 Paseo 工作区中工作，例如在外层步骤打开的副本里、带 `workspace: continue` 的步骤；
- 这个步骤使用相同的 provider、模型、effort 和 Paseo 模式；
- 两个步骤都不通过沙箱运行。

这个步骤无法在那个智能体里继续，或者前面的步骤不是在这个运行时的智能体里运行的（例如它在另一个驱动或另一台机器上运行）时，如果这个步骤不通过沙箱运行，且 Paseo 在这个步骤的 worktree 里列出了那个会话，teamai 会把会话导入到一个新智能体中。这个智能体随后按步骤的要求运行，并被告知运行的临时目录和工作流目录在哪里，因为导入的智能体拿不到 `TEAMAI_RUN_DIR` 和 `TEAMAI_WORKFLOW_DIR`。

否则步骤会启动一个新智能体，并说明原因：

```text
⚠ Step runtime "paseo", operation op-6e0c41d2b7a9: teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-5781c58b81a1: agent 4ee42432-b44e-4cca-a6b2-c793f387d266 runs claude/claude-haiku-5-5, and this step runs claude/claude-opus-5-5.
```

后面的步骤可能会延续的智能体会一直留在 Paseo 中，直到 teamai 关闭前面那个步骤的位置。取消后面的步骤或关闭它的位置，只会停止它自己的那一轮：智能体和前面步骤的工作都会保留。

## 在其他 daemon 上唤醒 fleet 成员

`wake` 使用 `paseo` 的 [fleet](workflow-advanced.md#在其他成员的机器上运行步骤fleet) 条目，会在它提供的尝试无人领取时启动一个成员。Paseo daemon 在你保存在它上面的另一个 daemon 上启动该成员的智能体。

设置方法：

1. 把另一台机器的 daemon 保存到这台的 daemon 上：`paseo host add <host:port> --label gpu-box`。这台 daemon 连上它之后，`paseo host ls` 会显示它为 `online`。
2. 在那台机器上，用 Paseo 打开仓库的一个检出。teamai 按其 git `origin` 指向的仓库来匹配，所以没有 `origin` 的检出不算。和任何 fleet 成员一样，那台机器需要装好 teamai 并设置好团队。

teamai 选择第一个在线、且有该仓库工作区的已保存主机。智能体出现在那台主机的 Paseo 里、那个工作区中，标题包含运行和池，例如 `teamai: step review of run r70d31098c8884803, fleet pool gpu`，并带有标签 `teamai-pool`。它使用该主机运行的 Claude、Codex 或 OpenCode 中第一个的默认模型，处于该 provider 的默认模式。在该模式下，它可以不经询问运行 `teamai workflow resume`，其他命令则不行：teamai 只给这个智能体加上 Claude 的规则 `Bash(teamai workflow resume:*)`，或同样的 OpenCode `bash` 规则。Codex 不接受只针对一条命令的规则，并且在自己的沙箱里运行命令：没有网络，也不能写 `~/.teamai`，所以 `teamai workflow resume` 在那里会失败。因此 Codex 智能体的第一条提示词开头会告诉它以提升的权限、在沙箱之外运行这条命令，Codex 会为此询问：请在那台主机的 Paseo 中批准。如果那台机器的 Codex 设置了 `approvals_reviewer = "auto_review"`，则由 Codex 的审核者回应，Paseo 中不会出现请求；在那台机器上项目的 `.codex/config.toml` 中把它设为 `"user"`，请求就会出现在 Paseo 中。智能体在执行命令前询问时，会在那台主机的 Paseo 中等待，直到有人在那里回应。它的第一条提示词是 teamai 领取该池一个尝试的命令，结尾告诉它在这个尝试完成后结束。运行详情中会链接该智能体。唤醒成员会消耗那台机器的账号。

Paseo 启动智能体后，teamai 不再跟踪它。要停止被唤醒的成员，在 Paseo 应用中打开它的智能体并停止，或运行 `paseo stop <agent> --host <host:port>`。`teamai workflow cancel <run>` 会撤回该尝试；尚未领取的成员会发现无可领取，然后结束。

没有任何已保存主机有该仓库时，尝试会继续等待成员，运行会说明每台主机缺少什么，例如：

```text
No Paseo host saved on this machine has a workspace of https://github.com/acme/acme-app.git (lost-box is offline; build-box has no workspace of it). Add the machine with `paseo host add <host:port>`, and open a checkout of the repository in Paseo there.
```

## 取消、崩溃和重启

`teamai workflow cancel` 会停止智能体，步骤以 `cancelled` 结束：

```sh
teamai workflow cancel r144a3913136e7b62
```

Paseo 可能在智能体的这一轮结束之前就答复取消，所以只有当 Paseo 报告智能体不再运行时，取消才算停止了智能体。取消 10 秒后仍在运行的智能体，或者 Paseo 在这段时间内没有答复的取消，会让这次停止无法确认（`cancel_failed`），teamai 会保留这次尝试和登录：

```text
Paseo cancelled the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, but it still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

等智能体能够停止后，再运行一次 `teamai workflow cancel`：运行时会重新尝试停止，并关闭这次尝试的位置。

智能体工作时 teamai 被杀掉，智能体会继续运行。`resume` 重新连上同一个智能体，不会再启动第二个：

```sh
kill -9 <teamai pid>
teamai workflow resume rffcaabe1e1852479 --driver paseo
```

守护进程在步骤中途重启会关闭它的智能体。它停着的时候，步骤等它恢复；恢复后步骤失败，已做的改动留在 worktree 里：

```text
✖ Step "classify" failed with runtime_failed: The step runtime could not run the prompt (daemon_restarted): The Paseo daemon at ws://127.0.0.1:6767/ws stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree. Then run: teamai workflow retry r3ad62eacc3c191eb classify
```

```sh
teamai workflow retry r3ad62eacc3c191eb classify
teamai workflow resume r3ad62eacc3c191eb --driver paseo
```

teamai 关闭这次尝试时，运行时会归档它的 Paseo 工作区，这会停止那里仍在运行的一切。Paseo 只删除它自己创建的 worktree，所以 teamai 的 worktree 和分支会保留。Paseo 拒绝归档时，运行详情会说明这个位置没有关闭，以及原因：

```text
Paseo did not archive workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79): <Paseo's error>. Its agents may still run; archive it in the Paseo app.
```

只有当 Paseo 报告这次尝试的每个智能体都不再运行时，这个位置才算关闭。归档 10 秒后仍在运行的智能体会让它保持打开：

```text
Paseo archived workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79), but agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

Paseo 以错误回答的创建请求（例如连接中断时）仍可能启动它的智能体。在 Paseo 显示这个智能体之前，这次尝试保持打开。智能体出现后，下一次 `teamai workflow cancel` 会停止它。teamai 无法判断 Paseo 是否拒绝了这个创建请求，所以如果智能体一直没有出现，请先确认这次尝试在工作树中没有任何东西还在运行，然后释放这次尝试。之后运行时会忘记它，即使它的关闭仍然失败，因此它不再妨碍另一次尝试归档它们共用的工作区：

```text
Paseo does not show the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel r3ad62eacc3c191eb again, which stops it. If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel r3ad62eacc3c191eb --release a5c1e9d07.
```

同一个 worktree 上的两次尝试共用它的 Paseo 工作区，只有最后关闭的那次尝试会归档它。先关闭的尝试改为取消它自己的智能体（包括失败步骤的智能体），另一次尝试的智能体继续运行。Paseo 不肯取消的智能体会让这次尝试保持打开，teamai 可以再次关闭它：

```text
Paseo did not cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f: Agent is busy. It may still run in the worktree; stop it in the Paseo app.
```

你在 Paseo 里已经打开的、同一目录上的工作区（例如只读步骤在你的检出目录中运行时）从不被归档：这次尝试改为取消它自己的智能体，你的工作区保持打开。步骤运行期间你在 Paseo 中打开该目录（得到的是这次尝试的工作区）并在其中启动了智能体时，也是如此。

打开时向 Paseo 提出的问题在 20 秒内没有得到回答时（例如守护进程卡住），步骤以 `runtime_failed` 失败并注明 `workspace_failed`，之后对该工作树的打开可以继续。Paseo 之后仍可能打开该工作区；失败信息会提示届时在 Paseo 应用中归档它。

运行时在步骤中途被杀掉就无法归档；步骤以 `runtime_lost` 失败，它的工作区会留在 Paseo 里，直到之后的 `teamai workflow cancel` 关闭这次尝试，或你归档它（`paseo workspace archive <id>`）。

崩溃后的 `teamai workflow cancel` 会以 recover 模式打开运行时。它不检查登录，所以之后退出登录的工具不会妨碍它停止智能体；它只为取消智能体和关闭这次尝试而连接守护进程。守护进程停着时，取消会保留这次尝试和登录，并说明原因：

```text
No Paseo daemon answered at ws://127.0.0.1:6767/ws within 10 s. Start it with `paseo start`, or set the runtime's url option to the daemon's address. Until then teamai-runtime-paseo cannot cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, which may still run in the worktree; cancel the run again.
```

启动守护进程，然后再运行一次 `teamai workflow cancel`。

## 启动时的错误

| 代码 | 何时出现 |
| --- | --- |
| `client_missing` | 找不到 Paseo 客户端：`PATH` 上和 `~/.local/bin` 里都没有 `paseo`，或 `PASEO_CLIENT_PATH` 指向的不是 `@getpaseo/client` 包。从 Paseo 桌面应用的设置中或用 `npm install -g @getpaseo/cli` 安装 Paseo CLI，或设置 `PASEO_CLIENT_PATH`。Paseo 应用的客户端中有文件与应用记录的 SHA-256 不符时也是此错误：重新安装应用。 |
| `client_version` | 找到的 Paseo 客户端早于 0.14.0。升级 Paseo，或把 `PASEO_CLIENT_PATH` 指向更新的 `@getpaseo/client` 包。 |
| `daemon_unreachable` | `url` 上没有守护进程应答。用 `paseo start` 启动它。 |
| `daemon_version` | 守护进程早于 0.14.0。升级 Paseo 并重启它。 |
| `paseo_config` | 没有 `url` 时，无法从 Paseo 的配置读出守护进程地址：`$PASEO_HOME/config.json` 不是 JSON，它的 `daemon` 部分不是 Paseo 写出的样子，或 `daemon.listen` 指向 Windows 命名管道。修好该文件，或设置 `url`。 |
| `bad_option` | `url`、`mode` 和 `providers` 以外的选项；或 `mode` 指定了 `claude`、`codex`、`opencode` 以外的工具。`providers` 中的一项既不是这些工具，也不是 teamai 传入的团队实例时，改为在 `unavailable` 中列出，其他工具照常运行。 |
