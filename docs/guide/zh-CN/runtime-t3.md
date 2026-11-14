# T3 运行时

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

`t3` [步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)把工作流的每个提示词步骤作为一个独立的 [T3 Code](https://t3.codes) 线程运行。你可以在应用里看 agent 工作，回应它的审批请求，发消息引导它，或者停止它。teamai 仍然在你的机器上准备步骤的 worktree、读取结果、提交并推送。命令步骤在本机运行，和 `--driver local` 一样。T3 无法运行的工具上的提示词步骤以 `tool_unavailable` 失败，并给出 T3 的原因。

它作为可执行文件 `teamai-runtime-t3` 随 teamai 一起发布。`--driver t3` 使用 teamai 自带的定义：

```yaml
# drivers/teamai-t3.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-t3
description: Run each prompt step as a T3 Code thread of its own, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: t3
    options:
      environment: local
      max_parallel: 4
```

## 快速开始

**1. 在这台机器上打开 T3 Code**，或运行 `t3 serve`。如果仓库还不是 T3 项目，第一次运行会添加它，和 `t3 project add ~/src/acme-app` 一样，并给出提示：

```text
⚠ Step runtime "t3", operation op-7110631d3e39: Adding /Users/you/src/acme-app to T3 Code as a project, so its steps can run there.
```

**2. 写一个 `workspace: new` 的提示词步骤，并在提示词里写清结果的样子。** agent 读的是提示词，不是 `output` 块：只说“把数量放进 output.sections”时，Claude 写成了 `markdown_sections`，步骤以 `invalid_output` 失败。

```yaml
# workflows/readme-review.yaml
schemaVersion: v1alpha1
name: readme-review
description: Count the README's sections and suggest one improvement
steps:
  - id: inventory
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('node:fs').readdirSync('.').length}))"
    output:
      files: number
  - id: review
    needs: [inventory]
    workspace: new
    tool: claude
    model: { name: claude-haiku-5-5 }
    prompt: >-
      Read README.md. Count its markdown sections (lines that start with "#") and suggest one short improvement.
      Do not change any file. The result file must be exactly
      {"output": {"sections": <the count>, "suggestion": "<the improvement>"}}, with those two key names.
    output:
      sections: number
      suggestion: string
```

**3. 启动它**，在这台机器的终端里或在一个 T3 线程里：

```sh
teamai pull
teamai workflow start readme-review --driver t3
```

第一次运行会让 teamai 登录 T3 Code，不打开页面，也不问你。teamai 让这台机器上的 `t3` 命令创建一个两分钟内有效的配对码，再用它以 Auto 权限批准自己的登录，即使你[收紧了 `runtime_mode`](#步骤线程会问你多少)：每个线程仍按自己的模式运行，一次登录可供所有运行使用。只有 [`runtime_mode: full-access`](#在可以丢弃的机器上运行-full-access) 会让它以 Full access 登录。它运行的命令：

```sh
t3 auth pairing create --json --base-dir ~/.t3 --scope orchestration:read --scope orchestration:operate --ttl 2m --label "teamai workflow"
```

T3 把这次登录列为一个单独的会话：

```text
$ t3 auth session list
af508185-8908-4575-a1d0-f3c6f67cddec
  scopes: orchestration:read orchestration:operate
  method: bearer-access-token
  subject: mcp-client
  client: teamai workflow | bot | 127.0.0.1
  expires: 2026-12-05T18:57:31.647Z
```

teamai 把凭据保存在 `~/.teamai/runtime-state/t3/credentials.json`（权限 0600），之后的运行复用它。T3 在 30 天后让它过期，下一次运行会用同样的方式重新登录。要撤销它，运行 `t3 auth session revoke <id>`。`teamai uninstall` 会删除这个文件，但不会撤销 T3 中的会话，所以也要在 T3 中撤销它。

teamai 运行它找到的第一个 `t3`：`$T3CODE_CLI_PATH`（T3 在自己的线程里设置它），然后是 PATH 上的 `t3`，然后是 T3 数据目录里的 `bin/t3`（`~/.t3/bin/t3`，或 `$T3CODE_HOME` 下的）。如果一个都找不到，或者 T3 拒绝了配对码，运行会改为打开 T3 的登录页面，并打印页面链接，以防浏览器没有打开。在 T3 Code 里创建一个配对码，选 **Auto** 权限（`runtime_mode` 为 `full-access` 时选 **Full access**），输入配对码并批准。你选的权限是步骤线程能运行的最宽模式。

**4. 在 T3 里看步骤运行。** `inventory` 在你的机器上运行。`review` 以 `review · teamai r928e2fc23ab9bd62` 出现在项目的线程列表里。它的第一条消息说明它属于哪个运行：

```text
This thread runs step "review" of teamai workflow run r928e2fc23ab9bd62 (attempt a96c8bc03). It was started from
the T3 thread <t3-thread://v2/88e28b29-…/thread-…>. Its shell has no TEAMAI_RUN_DIR: the run's scratch directory is ~/.teamai/projects/…/scratch. Work only in this worktree. Do not run teamai workflow commands:
teamai commits, pushes and reports the step itself.

Read README.md. Count its markdown sections …

Write the workflow result as JSON to ~/.teamai/projects/…/attempts/a96c8bc03/out/result.json. …
```

在这次运行里，Claude 读了 README，运行了 `grep -c '^#' README.md`，创建了结果目录并写入结果文件，全程没有询问。大约 20 秒后步骤结束：

```text
{"data":{"done":{"run":"r928e2fc23ab9bd62","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

步骤运行时，`teamai dashboard` 的运行详情会链接它的线程，并显示线程 id 和模型。这个链接会在 T3 Code 桌面应用里打开线程，从仪表盘或终端都可以：

```sh
open 't3code://threads/88e28b29-…/mcp%3Alaunch%3A3891149…'
```

步骤结束后，teamai 会把它的线程标记为已处理（settle）。线程离开你的活动线程列表，进入 T3 折叠起来的 **Settled** 分组，链接仍然能打开它：

| 步骤 | 它的线程 |
| --- | --- |
| 成功、失败，或在结果里报告了失败 | teamai 关闭步骤的位置后标记为已处理 |
| 被取消（`teamai workflow cancel`） | 先停止，再标记为已处理 |
| 仍在运行，或是在等你的交互式步骤 | 留在活动列表里 |
| 步骤在 teamai 看到线程停止之前就结束了（T3 没有停止它，或 teamai 失去了对它的跟踪） | 留在活动列表里，方便你停止它；关闭步骤的位置时会先停止它 |

teamai 只处理它自己启动的线程，以及这些线程委派的任务的线程。如果 T3 拒绝把某个线程标记为已处理，步骤照样有效，线程留在活动列表里。

## 步骤线程会问你多少

步骤线程是独立的线程，所以只有你能回应它的请求。它以你在 T3 Code 里设置的默认模式启动：项目自己的设置优先，其次是全局设置，都没有时是 Auto。它从不沿用你启动运行时所在线程的模式；除非 `runtime_mode` 指定，也从不以 Full access 运行。你的默认模式是 Full access 时，它以 Auto 运行，并给出提示。

| 模式 | 你在线程里看到什么 |
| --- | --- |
| Auto | 提供方自己的审查会批准常规操作，比如读文件、在 worktree 里编辑和普通命令；其余的会问你。没有自动审查的提供方什么都会问，和 Supervised 一样。 |
| Auto-accept edits | worktree 内的编辑直接通过。每条命令都等你批准，写结果文件也是。 |
| Supervised | 每条命令和每次编辑都等你批准，包括写结果文件。 |

在你的机器上，teamai 允许 Claude 不经询问写入步骤的结果文件。T3 线程得不到这样的授权，因为 T3 没有办法传递它。结果文件在 worktree 之外，步骤写在它旁边 `out/` 里的其他文件（例如证据）也一样。在 Auto-accept edits 和 Supervised 下，线程会为每一次这样的写入询问（"Path is outside allowed working directories"）。批准这些写入，步骤就会结束。

同一个 README 评审在 Auto 下什么都没问。在 Supervised 下问了两次，一次是创建结果目录，一次是写结果文件，步骤用了 9 分钟，因为请求一直在等人批准。

要指定这台机器上每个步骤线程的模式，不管 T3 的默认模式是什么，设置 `runtime_mode`：

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          runtime_mode: approval-required   # or auto-accept-edits
```

它接受 `auto`、`auto-accept-edits`、`approval-required` 或 `full-access`。其他值在调用 T3 之前就会失败：

```text
{"error":{"code":"bad_option","message":"Runtime \"t3\" of driver definition teamai's drivers/teamai-t3.yaml refused option \"runtime_mode\": runtime_mode \"yolo\" is not one runtime t3 takes. A step thread runs in the member's T3 default mode, or auto, never full access unless runtime_mode says so; runtime_mode sets it to auto, auto-accept-edits, approval-required or full-access. Remove it, or set one of those four. Fix the option and start again."}}
```

teamai 的登录限定了模式的上限。如果它允许的比本次运行的模式窄，T3 会拒绝创建线程，步骤失败。例如，有人在 T3 的登录页面里以 Supervised 权限批准了 teamai，而这次运行用 Auto：

```text
✖ Step "review" failed with runtime_failed: The step runtime could not run the prompt (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode, because teamai's sign-in does not allow it (Child runtime mode auto is broader than parent mode approval-required.). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.
```

### 在可以丢弃的机器上运行 Full access

当 T3 Code 运行在步骤造成不了损害的地方，比如一台专用的虚拟机，`runtime_mode: full-access` 让每个步骤线程都以 Full access 运行，不再问你任何事：

```yaml
# .teamai/drivers/t3-vm.yaml
schemaVersion: v1alpha1
name: t3-vm
description: T3 threads in full access, for a T3 that runs inside its own VM.
runtimes:
  - use: t3
    options: { environment: local, runtime_mode: full-access }
  - use: tools
```

运行开始时会提示一次，并把这些步骤的隔离级别记为 `none`：

```text
⚠ Runtime t3 of driver t3-vm runs steps in full access on this machine, as drivers/t3-vm.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

teamai 会重新登录，这次以 Full access 登录（配对码还会申请 `settings:write` 和 `source-control:write`）。评审的线程仍以 Auto 运行。仍不提供 `permissions: unattended` 步骤。

## 选择提供方实例和模型

可用的工具是此刻能运行的 T3 提供方实例，不包括你为这个项目关掉的实例。没有指定工具的步骤，在同样没有指定工具的定义里，会在你的 T3 默认模型（项目的，否则是全局的）所属的工具上运行。一个提供方有多个实例时，`claude` 和 `codex` 在你的 T3 默认模型所在的实例上运行，前提是它运行提供方自己的二进制文件（没有 Binary path，或者 Binary path 名为 `claude` 或 `codex`）；否则在以提供方命名的实例上运行（Claude 是 `claudeAgent`，Codex 是 `codex`），不论它的 Binary path 是什么；再否则在第一个运行提供方自己二进制文件的实例上运行。Binary path 是包装命令（比如团队工具的命令）的实例只运行那个团队工具，即使它是你的 T3 默认实例；这时没有指定工具的步骤在那个团队工具上运行，没有团队工具在它上面运行时，以提供方自己的工具（`claude` 或 `codex`）在上面选出的实例上运行。要让所有提示词都在某一个实例上运行，比如第二个 Claude 账号，在你机器的配置里写上它：

```yaml
# ~/.teamai/config.yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          instance: claude-work      # the id in T3 Settings → Providers
          max_parallel: 2
```

只想改一个工具的实例时，在 `instances` 下映射它，例如 `instances: { claude: claude-work }`：Claude 步骤在 `claude-work` 上运行，Codex 步骤仍用原来的实例。映射到 T3 无法运行的实例时，T3 不提供这个工具：它的步骤在定义中下一个拥有它的运行时上运行，没有这样的运行时（如 `teamai-t3`）则在调用 T3 之前失败并说明要设置什么。这里的名字既不是 `claude`、`codex`，也不是你拥有的[团队工具](reference.md#团队工具tools)时，它不映射任何东西，运行开始时会说明。其他工具照常运行：

```text
⚠ Step runtime "t3": instances names acme-cluade, which is neither claude, codex nor a tool instance teamai has here. Remove instances.acme-cluade, or name the instance as its tool definition does.
```

步骤的 `model: { name, effort }` 选择模型，`effort` 会变成该实例对应的选项（Claude 是 `effort`，Codex 是 `reasoningEffort`）。没有写模型的步骤，在你的 T3 默认模型（项目的，否则是全局的）位于该步骤的实例上时使用它，由 T3 选择，和你自己开的线程一样；否则使用实例列出的第一个模型。实例无法运行的内容会在任何线程启动之前失败：

```text
✖ Step "review" failed with model_unavailable: T3 Code provider instance "claudeAgent" (Claude) has no model claude-opus-9. Its models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
```

从 T3 线程启动时（例如由线程的智能体启动），没有写工具和模型的步骤会像那个线程一样运行：用它的提供方实例和模型，代替你的 T3 默认值。例如，从运行在 `claude-work`、使用 `claude-sonnet-5-5` 的线程启动，没有写工具的步骤会在 `claude-work` 上用 `claude-sonnet-5-5` 运行 `claude`。T3 不报告线程的模型选项，所以模型使用它自己的默认 effort。模式从不取自线程，而是按[步骤线程会问你多少](#步骤线程会问你多少)决定。线程运行在这里不能运行步骤的实例上时，运行使用你的 T3 默认值。T3 读不到这个线程时也一样，并在开始时说明：

```text
⚠ Step runtime "t3": teamai could not read the T3 thread thread-7f3a… this run was started from (Thread thread-7f3a… is no longer available), so a step that names no tool or model runs on your T3 Code default instead.
```

### 团队工具

`acme-claude`（`extends: claude`，`command: acme-claude`）这样的[团队工具](reference.md#团队工具tools)，在 Binary path（T3 Code 的 Settings → Providers）是 `acme-claude` 或指向它的路径的 T3 提供方实例上运行，或者在 `instances: { acme-claude: <its id> }` 映射的实例上运行。有自己的 home 而没有命令的工具，比如 `claude-work`（`extends: claude`，`home: { dir: .claude-work, env: CLAUDE_CONFIG_DIR }`），在运行 Claude 自己的二进制文件、Home path 为该 home 的实例上运行。它的会话在该实例的 Home path 中读取。`home.env` 指定的变量不是基础工具的变量（比如 `ACME_CLAUDE_CONFIG_DIR`）的工具不在 T3 上运行，因为 T3 只设置基础工具的变量：去掉它的 `home.env`，让 teamai 设置 `CLAUDE_CONFIG_DIR`，或者让它的步骤在其他运行时上运行。

没有实例运行它时，teamai 会在第一次有步骤用它时添加一个，并说明：

```text
⚠ Step runtime "t3", operation op-5781c58b81a1: Added the T3 Code provider instance "acme-claude" (driver Claude, Binary path /opt/acme/bin/acme-claude), so acme-claude runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.
```

实例以工具命名。它的 Binary path 是你的 PATH 找到的工具命令（`claude-work` 则是 Claude 自己的二进制文件），工具有自己的 home 且不是基础工具的 home（`~/.claude`、`~/.codex`）时，Home path 就是那个 home，否则 teamai 不设置它。teamai 把它写进 T3 的设置，其他设置保持不变，T3 Code 会立即读取。两个运行只会添加一次，之后的运行直接使用它，不再改动。运行进行中你删除了它时，该运行下一个使用这个工具的步骤会再次添加它，并再次告诉你。从不用到这个工具的运行不会添加任何东西。

teamai 以你的身份写入 T3 的设置文件，有人值守和无人值守的运行都一样，就像它用 `t3` 命令添加项目那样。它不会向 T3 申请更大的登录权限：每个线程仍按原来的模式启动。如果 T3 Code 同时也在写这个文件，teamai 会重新读取，并保留 T3 写入的内容。

T3 不提供这个工具时（命令不在你的 PATH 上、有两个实例都运行它、运行它的实例被关掉了，或者 T3 已有一个同名实例），它的步骤在定义中下一个拥有它的运行时上运行；在没有其他运行时能运行它的定义上（如 `teamai-t3`），会在任何线程启动之前失败，并给出原因：

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: t3: No T3 Code provider instance runs acme-claude, and teamai cannot add one: acme-claude is not on PATH here. Install acme-claude, or add one in T3 Code under Settings → Providers, with driver Claude and Binary path the absolute path of acme-claude (command -v acme-claude), or map one with instances: { acme-claude: <its id> } in the definition's t3 options. Or remove tool from the step.
```

运行团队工具的实例的 home 与 teamai 给这个工具的 home 不同时，工具会在实例的 home 中登录并保存会话，运行开始时会说明。没有自己 home 的工具（例如 `acme-claude`）使用基础工具的 home，`CLAUDE_CONFIG_DIR` 或 `CODEX_HOME` 会移动它；从 T3 线程启动的运行里 teamai 不看这两个变量，因为 T3 在线程里把它们设为线程自己实例的 home：

```text
⚠ Step runtime "t3": T3 Code provider instance "acme-claude-t3" runs acme-claude in ~/.claude, while teamai gives acme-claude the home ~/.acme-claude: on T3 it signs in and keeps its sessions there. To use the same home, set the instance's Home path in T3 Code under Settings → Providers to ~/.acme-claude.
```

## 通过沙箱运行

`use: t3, through: sandbox` 的条目照上文在 T3 Code 中运行每个步骤的线程，而线程的工具在这次尝试的沙箱里运行。条目的写法和沙箱做的事见 [通过应用运行](runtime-sandbox.md#通过应用运行teamai-sandbox-tool)。沙箱必须提供这次尝试的套接字：`sbx`，或 Docker Desktop 上、这台 Linux 机器上 26.0.0 或更高（25.0.5、23.0.11）且镜像里有 `node` 的 `docker`，它们让工具连不到这台机器的端口（[步骤能连到什么](runtime-sandbox.md#步骤能连到这台机器的什么)）。目前只有 Claude 能这样运行；通过沙箱的 Codex 步骤会在打开时失败。

每个步骤开始前，运行时在这个套接字上登记步骤的工具，T3 启动 teamai 的包装程序 `teamai-sandbox-<tool>` 代替工具本身。第一次时，teamai 会添加运行这个包装程序的 T3 提供方实例，和为团队工具添加实例一样：

```text
⚠ Step runtime "t3", operation op-08bf92d32391: Added the T3 Code provider instance "teamai-sandbox-claude" (driver Claude, Binary path /usr/local/bin/teamai-sandbox-claude), so teamai-sandbox-claude runs on T3 Code. It stays for later runs; remove it in T3 Code under Settings → Providers.
```

步骤的会话从这次尝试的工具主目录读取，沙箱就在那里运行工具。如果沙箱不提供套接字（其他任何沙箱），步骤会在任何线程启动之前失败，teamai 也不会添加实例：

```text
✖ Step "count" failed with runtime_failed: Step runtime "t3 through sandbox" could not open attempt abf6c98bd (open_failed): Runtime t3 runs a tool through another runtime only on that runtime's attempt socket, and teamai could not register this step's tool on it (its handle names no attempt socket), so the sandbox would refuse the tool. Run T3 through a sandbox provider that serves one: sbx, or docker 26.0.0 or later (25.0.5, 23.0.11) on Docker Desktop or on this Linux machine, on an image that holds node.
```

## 项目脚本

T3 在线程打开的每个 worktree 里运行项目的 **setup** 脚本（“Run on worktree creation”），在线程被标为已处理（settle）时运行它的 **settle** 脚本。步骤的 worktree 由 teamai 自己准备，所以这两个脚本都不会为步骤运行：

- 项目有 setup 脚本时，teamai 把步骤的 worktree 作为一个独立项目添加到 T3 Code，标题为 `acme-app · teamai <run>`，线程在那里运行。teamai 删除步骤的 worktree 后，会从 T3 Code 删除这个项目及其线程。它从不重命名或删除你运行时所在的项目。
- 项目有 settle 脚本时，teamai 不会把步骤的线程标为已处理：它留在你的活动线程里。

## 只用 T3 为一次 pass 评分

T3 也能当评审。只通过 T3 运行工具的成员，也能运行带[评分器](scorers.md#为步骤评分)的工作流并给每次 pass 打标签，只要驱动定义里只列出 `t3`：

```yaml
# .teamai/drivers/t3only.yaml
schemaVersion: v1alpha1
name: t3only
tool: claude
runtimes:
  - use: t3
    options: { environment: local }
```

```yaml
# .teamai/workflows/readme-test-section.yaml
schemaVersion: v1alpha1
name: readme-test-section
description: Add a Test section to the README.
steps:
  - id: write
    workspace: new
    model: claude-haiku-5-5
    prompt: Add a "## Test" section to README.md that says to run `npm test` before opening a pull request. Change no other file.
    scorers: { names: [review-quality], sampling: all }
```

`review-quality` 是[评分器](scorers.md)页面里的评分器。`sampling: all` 会评审每次 pass，不管它的 `samplingRate` 是多少。

```text
$ command -v claude codex codebuddy opencode
[exit 1: none found]
$ teamai workflow start readme-test-section --driver t3only
ℹ run:r943880abc4705751:write:1: review-quality good (teamai-score run rdecc208adbba4b79).
{"data":{"done":{"run":"r943880abc4705751","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`write` 和上文一样作为项目里的线程运行。teamai 自己的评分命令（evidence、label、write）在这台机器上运行，不需要 agent。评审作为第二个线程 `score[0].judge · teamai rdecc208adbba4b79` 运行，出现在 T3 的 **No project** 下：

- 它是一个独立的新线程，在一个新的 scratch 文件夹（`~/.t3/scratch/…`）里。teamai 把评审要读的证据（会话记录、diff、`evidence.json`）复制进这个文件夹，并把副本设为只读。
- 它的第一条消息要求它只读这个文件夹，给出回复的 JSON Schema，并把 teamai 提示词里每处提到证据目录的地方都指向副本。
- 它的最后一条消息就是回复：`{"answer":{"label":"good","reasoning":"The step asked for a \"## Test\" section … diff.patch adds exactly that …"}}`。
- 它以 `runtime_mode` 运行（`full-access` 时以 Auto 运行），否则以你的全局 T3 默认模式运行，都没有时是 Auto；从不以 Full access 运行。评审的位置关闭时，teamai 会把线程标为已处理（settle）并删除副本。

T3 评审的[隔离级别](scorers.md#隔离)是 **best-effort**：

| 它能保证的 | 它不能保证的 |
| --- | --- |
| agent 在副本里工作，所以改不了 teamai 用来打标签的证据。 | agent 的工具仍然在你的机器上、用你的文件运行。只有第一条消息的要求让它不去读文件夹之外的内容，而 Auto 会批准常规的读取。 |
| 副本是只读的，也不包含可能指向外部的符号链接。 | 它不切断网络。 |
| teamai 会在标签的运行里记录 `best-effort` 和 `read` 访问权限。 | 带 `isolation: verified` 的评分器会等待能达到该级别的运行时（比如 sandbox 运行时），不会在这里被评审。 |

## 无人值守运行

在 CI 中，或在 `TEAMAI_MODE=unattended` 的运行中，没人能批准登录或工具请求。无人值守运行和其他运行一样通过 `t3` 命令登录，所以凭据过期后，定时运行仍能继续。`t3` 命令无法让它登录时，它会立即失败并说明原因：

```text
{"error":{"code":"runtime_failed","message":"Runtime \"t3\" of driver \"teamai-t3\" did not start (login_required): teamai has no valid T3 Code sign-in for http://127.0.0.1:3773 and could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ~/.t3/bin/t3), and an unattended run cannot ask for one. Start any workflow with --driver t3 from a terminal on this machine once, approve teamai in the page T3 Code opens, then run this again."}}
```

无人值守运行的线程以上面的模式运行。agent 仍然请求审批，或者委派的任务请求审批的步骤会被停止，并以 `tool_failed` 失败，消息里写明线程。如果 T3 没有停止这个线程，步骤改以 `runtime_lost` 失败，并写明 `cancel_failed`，teamai 会保留步骤的位置，直到之后的 `teamai workflow cancel` 停止它。交互式步骤只在有人值守运行中运行。

## 重启、取消和重试

步骤的线程在 T3 里，不在 teamai 的进程里。如果驱动进程退出，`teamai workflow resume <run> --driver t3` 会重新连接到同一个线程，而不是再启动一个。`teamai workflow cancel <run>` 像线程的 Stop 按钮一样停止线程。线程以 interrupted 结束，它正在等待的请求会被撤回，teamai 会把它标记为已处理。取消不需要重新登录：驱动进程退出后，teamai 只为停止它记录过的内容打开运行时，使用它保存的登录凭据，并且只在停止时连接 T3 Code。

从取消开始，T3 有 10 秒来确认停止，仍在进行的启动也算在内。如果没有确认，teamai 会保留步骤的位置，不提交它的任何内容，取消命令会说明哪个线程仍在运行：

```text
⚠ Could not stop attempt a96c8bc03 of run r70d31098c8884803 on step runtime "t3" of driver "teamai-t3": its exec or prompt may still run, since the runtime did not confirm it stopped (cancel_failed): The T3 thread t3code://threads/88e28b29-…/mcp%3Alaunch%3A3891149… ("review · teamai r70d31098c8884803") still runs, and T3 Code did not stop it: T3 Code acknowledged the stop, but its run was still running 10 s later. Stop it in T3 Code with its Stop button, then run teamai workflow cancel r70d31098c8884803 again.
```

停止那个线程，然后再次运行同一个取消命令。如果你确认线程已经不在运行，T3 仍然无法确认，`teamai workflow cancel <run> --release <attempt>` 会放掉这次尝试：teamai 再尝试停止一次，然后不管 T3 怎么回答，都会忘掉这个线程。

线程的运行可能把工作交给子代理或后台任务。只有这些工作也结束后，步骤才结束；取消或关闭也要到那时才算线程已停止。

如果 T3 Code 启动了步骤的线程，但它的回复没有到达 teamai，取消或关闭会再发送一次同样的启动请求，T3 会用那个线程回答，然后 teamai 停止它。如果 T3 当时什么也没启动，第二次启动会新增一个空闲线程，teamai 会把它标记为已处理。T3 只在发出第一次启动的那次登录下回答这个请求，所以你重新登录 T3 之后，teamai 会保留这个位置，并告诉你要停止哪个线程。

```sh
teamai workflow resume r928e2fc23ab9bd62 --driver t3
teamai workflow cancel r70d31098c8884803
```

## 交互式步骤

`interactive: true` 的提示词步骤会打开一个由你在其中工作的线程。线程被告知只有在你说步骤完成后才写结果文件，所以线程在你两次发言之间空闲时，步骤不会结束。在它结束之前，运行中的其他步骤都不会开始。

## 继续一个步骤的对话

带 `session.from` 或 `session: continue` 的提示词步骤会在前一个步骤的 T3 线程里继续。teamai 把这个步骤作为该线程的新一轮发送，所以 agent 保留它在那里读过和说过的内容，运行把会话记为 resumed。和每个 T3 步骤一样，它报告其 Claude 或 Codex 会话记录的 token 数，这里只算它自己这一轮的。满足以下条件时才会这样：

- 前一个步骤的线程仍在 T3 Code 中，并且它的那一轮已经结束；
- 这个步骤在同一个文件夹里工作；
- 这个步骤运行在同一个提供方实例上。换成该实例的另一个模型或 effort 也可以：teamai 会先把线程切换过去。

否则步骤会开始一个新线程，并说明原因：

```text
⚠ Step runtime "t3", operation op-6e0c41d2b7a9: Runtime t3 starts a new T3 thread for step "fix" rather than continue the conversation of op-5781c58b81a1: the T3 thread t3code://threads/88e28b29-…/mcp%3Alaunch%3A3891149… ("review · teamai r70d31098c8884803") of op-5781c58b81a1 runs on T3 Code provider instance "claudeAgent", and this step asks for "codex".
```

后续步骤可能继续的线程，会一直留在活动列表里，直到 teamai 关闭前一个步骤的位置（place）。取消后续步骤或关闭它的位置，只会停止它的那一轮：线程以及前一个步骤在其中的工作都会保留。

## 在关联的机器上唤醒 fleet 成员

[fleet](workflow-advanced.md#在其他成员的机器上运行步骤fleet) 条目的 `wake` 使用 `t3` 时，它一发出还没有成员接手的 attempt，teamai 就会启动一个成员：T3 Code 在与它关联的另一台机器上启动成员的线程。

设置方法：

1. 在 T3 Code 的 Settings → Labs 中打开 Linked environments。在你打开之前它是关闭的，这时唤醒会失败并提示：`Linked environments is off in T3 Code, so it reaches no other machine. Turn on Linked environments in T3 Code's Labs settings, link the machine, and add the repository there as a project.`
2. 把另一台机器关联到这个 T3 Code。
3. 在那台机器上，把仓库的一个检出添加为 T3 项目。T3 按 git remote 指向的仓库来匹配，所以只有本地 remote 的检出不算。那台机器需要装好 teamai 并设置好团队，和任何 fleet 成员一样。

teamai 选择第一台有响应并且有该项目的关联机器。线程出现在那台机器的 T3 Code 中、该项目下，标题包含步骤、运行和池，例如 `teamai: step build of run r70d31098c8884803, fleet pool gpu`。线程使用那里项目的默认模型，否则使用那台机器运行的第一个 Claude 或 Codex 实例，模式为 `runtime_mode`，否则为 Auto，并且从不使用 Full access：`full-access` 会以 Auto 唤醒它。它的第一条消息是 teamai 让它接手该池一个 attempt 的命令，最后一句告诉它完成那个 attempt 后就结束。运行的详情会链接这个线程。唤醒成员会消耗那台机器的账号。

在 Auto 模式下，Claude 成员不经询问就运行 teamai 的命令。在 Supervised 或 Auto-accept edits 模式下，它会先询问，而那里没有人回答，所以消息的第一行说明要批准什么，并给出下面的规则。Codex 成员在任何模式下都在自己的沙箱里运行命令：没有网络，也不能写 `~/.teamai`，所以它的第一行告诉它以提升的权限、在沙箱之外运行 teamai 的命令，Codex 会为此询问：请在那台机器的 T3 Code 中批准。在 Supervised 模式下，即使那台机器的 Codex 设置了 `approvals_reviewer = "auto_review"`，T3 Code 也会显示这个请求；在其他模式下，可能由 Codex 的审核者回应，T3 Code 中不会出现请求：在那台机器上项目的 `.codex/config.toml` 中把它设为 `"user"`，就能看到请求。要让 Claude 成员不经询问就运行这一条命令，在那台机器的检出中把它加入 `.claude/settings.local.json`：

```json
{ "permissions": { "allow": ["Bash(teamai workflow resume:*)"] } }
```

T3 启动线程后，teamai 不再跟踪它。要停止被唤醒的成员，在那台机器的 T3 Code 中打开它的线程并点 Stop。`teamai workflow cancel <run>` 会撤回 attempt；还没接手的成员找不到可领取的工作，就会结束。

没有任何关联机器有该仓库时，attempt 继续等待成员，运行会说明需要添加什么，例如：

```text
No machine linked to T3 Code has https://github.com/acme/acme-app.git as a project (build-box has no project of it). Link a machine in T3 Code, and add the repository there as a project.
```

## 启动不了时

| 你看到的 | 原因 | 怎么做 |
| --- | --- | --- |
| `T3 Code is not running on this machine.` | 这里没有 T3 服务。teamai 读取 `~/.t3/userdata/server-runtime.json`，或 `$T3CODE_HOME/userdata/…` | 打开 T3 Code，或运行 `t3 serve`，然后重新运行。 |
| `T3 Code at http://127.0.0.1:3773 does not answer. Open T3 Code, or run \`t3 serve\` …` | T3 留下了服务文件，但那里没有服务应答。 | 打开 T3 Code，或运行 `t3 serve`，然后重新运行。 |
| `… (t3_version): T3 Code runs version 0.1.7…; teamai-runtime-t3 needs T3 Code 0.1.8 or later …` | 你的 T3 Code 比 teamai 测试过的版本旧。 | 更新 T3 Code，然后重新运行。 |
| `… (login_required): … could not sign in through the t3 command (found no t3 command at $T3CODE_CLI_PATH (unset), on PATH, or at ~/.t3/bin/t3) …` | 无人值守运行没有有效的登录，`t3` 命令也没能创建一个。括号里的文字说明原因。 | 确认在 teamai 运行的 shell 里 `t3 auth session list` 能正常工作，然后重新运行。或者从终端启动一次工作流，在页面里批准 teamai。 |
| `… (sign_in_too_narrow): T3 Code refused to start the step's thread in auto mode …` | teamai 的登录允许的模式比线程运行的模式窄。 | 删除 `~/.teamai/runtime-state/t3/credentials.json` 并重新运行：teamai 会重新登录；如果 T3 Code 询问，用 Auto 权限批准。或者设置 `runtime_mode`。 |
| `… (sign_in_too_narrow): teamai's T3 Code sign-in was approved without Full access, which runtime_mode full-access needs …` | 有人在 T3 的登录页面里选了比 Full access 窄的权限。 | 重新启动工作流并选 Full access，或者删掉 `runtime_mode: full-access`。 |
| `… is not a project in T3 Code <machine>, and teamai could not add it (…)` | 这个检出不是 T3 项目，`t3 project add` 也失败了。括号里的文字说明原因。 | 在 T3 Code 里添加它（Add project），或运行 `t3 project add <path>`。 |
| `T3 Code has no provider instance "claude-sandbox".` | `instance` 指向 T3 没有的实例。 | 在 T3 Code 的 Settings → Providers 里添加它，或者删掉 `instance`。 |
| `… No T3 Code provider instance runs acme-claude, and teamai cannot add one: T3 Code already has a provider instance "acme-claude" that runs another command …` | 你已有一个同名实例，运行的是别的命令。teamai 不会改动它。 | 把它的 Binary path 指向工具的命令，或者用 `instances` 映射另一个实例。 |
| `… T3 Code cannot run the provider instance "claude-work" for claude-work yet: Claude Code is not authenticated …` | 该实例已存在，但 T3 Code 对它的检查没有通过，例如工具从未在该实例的 home 中登录。 | 按 T3 Code 的提示，在消息给出的 home 中处理（Claude 用 `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`），然后重试该步骤。 |
| `… ended without writing the result file …` | agent 结束了，但没有写结果。 | 用消息里的链接打开线程，然后运行 `teamai workflow retry <run> <step>`。 |
| `… wrote the result file <file>, which teamai cannot read because it has no permission to read it …` | agent 把结果写进了运行 teamai 的用户无法读取的文件，所以 teamai 拿不到这个步骤的结果。 | 让运行 teamai 的用户可以读取消息里提到的文件，然后重试该步骤。 |
| `… (cancel_failed): The T3 thread t3code://threads/… ("review · teamai r70d…") still runs, and T3 Code did not stop it …` | teamai 取消了这个步骤，但 T3 没有在 10 秒内确认线程已停止。 | 从链接打开线程，用 Stop 按钮停止它，然后再次运行 `teamai workflow cancel <run>`。 |
| `… (cancel_failed): teamai launched the T3 thread "review · teamai r70d…", and T3 Code did not confirm the launch …`，或 `… could not be followed, so it may still run …` | 步骤失败了，但它的线程可能仍在 T3 中运行：T3 Code 没有回复启动请求，或在步骤运行期间断开了。teamai 会保留位置，不提交任何内容。 | 打开 T3 Code，然后运行 `teamai workflow cancel <run>`：它会找到线程并停止它。 |
| 运行详情里的 `Not closed: thread_still_runs …` | teamai 关闭步骤的位置时，它的线程或它委派的工作仍在运行，而 T3 没有停止它。 | 用链接打开线程，用它的 Stop 按钮停止它。 |
| `Not closed: t3_unavailable: teamai launched the T3 thread "review · teamai r70d…" and T3 Code never answered …` | 某个步骤的启动请求没有得到回复，而且无法连接 T3 Code 来查找那个线程。 | 打开 T3 Code，然后再次运行 `teamai workflow cancel <run>`。 |
| `… launch_unconfirmed: teamai launched the T3 thread "review · teamai r70d…" in the T3 project "acme-app" under an earlier T3 Code sign-in …` | 某个步骤的启动请求没有得到回复，而你之后重新登录了 T3，所以 teamai 无法查找那个线程。 | 如果消息里提到的线程还在运行，在 T3 Code 里停止它，删除消息里提到的文件，然后再次运行 `teamai workflow cancel <run>`。 |
| `… journal_unreadable: Runtime t3 cannot read its record of t3-r70d…, ~/.teamai/runtime-state/t3/places/….json …` | teamai 记录步骤线程的文件已损坏，所以它不知道该停止哪些线程，并保留这个位置。 | 在 T3 Code 里停止这次运行的线程，删除消息里提到的文件，然后再次运行 `teamai workflow cancel <run>`。 |
| `… kept no session for <worktree> in <home> …` | 工具没有在 teamai 查找的目录里为这个 worktree 保存会话记录：该目录是实例在 T3 里设置的 home path，否则是运行 T3 Code 的用户的 `~/.claude` 或 `~/.codex`。T3 服务器自身运行时带的 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`，teamai 看不到。所以步骤无法评分。 | 在 T3 Code 的 Settings → Providers 里把实例的 home path 设为工具实际使用的目录（即 T3 的 `userdata/settings.json` 中的 `providerInstances.<instance>.config.homePath`），然后重试该步骤。 |
| `… teamai cannot list <folder>, where claude keeps the step's session, because it has no permission to read it …` | 工具把会话记录写进了运行 teamai 的用户无法读取的目录，所以 teamai 找不到这个步骤的会话，步骤无法评分，也无法恢复。 | 让运行 teamai 的用户可以读取消息里提到的目录，然后重试该步骤。 |
| `… runs under a token budget, and its driver, which reports tokens, read none for it …` | 只有 teamai 能列出每个工具保存会话的目录时，T3 才提供 token 数；但这个步骤的 token 数仍然没读到，原因见冒号后面，例如会话记录超过 50 MiB。 | 按消息说的做，然后重试该步骤。 |
| `⚠ Step "review" stopped: claude reached its usage limit on T3 Code provider instance "claudeAgent" (Claude): …` | 实例达到了提供方的用量上限。T3 知道重置时间时，冒号后的 T3 消息会写明。 | 无需操作：额度重置后 teamai 会再运行该步骤。想现在继续，就换一个 `instance`。 |

## 目前还不支持

- 步骤的线程是独立的线程，不是启动运行的那个线程的子线程；被唤醒成员的线程也一样：T3 不为它们记录父线程。
- 它不接受 `credentials`。线程的工具在 T3 Code 的环境中、用 T3 Code 自己的登录运行，所以 teamai 会在任何步骤运行之前拒绝为这个运行时配置的凭据：`NAME: env:VAR` 的提示是 `t3 does not offer can.env, so it cannot keep a credential to the processes it is for`，`<tool>: login` 的提示是 `t3 launches agents its own way, in each tool's own home, so it brings no login`。
- 只读的提示词步骤在 teamai 为它保留的副本里运行，和 `new` 步骤在它的 worktree 里一样。`clone` 或 `team` 步骤在它自己的文件夹上运行，teamai 会把那个文件夹添加为 T3 Code 项目。文件夹被删除后，下一个关闭的 T3 步骤会删除这个项目。带 `role`、`env` 或 `setup` 的提示词步骤只在定义中提供它们的其他运行时（例如 `tools`）上运行；`teamai-t3` 没有这样的运行时，所以在那里以 `requirement_unmet` 失败。
- 它无法限制 `max_turns`。
- 不提供 `permissions: unattended` 的步骤。它们需要一个工具在沙箱中运行的线程，后续版本会加入。
