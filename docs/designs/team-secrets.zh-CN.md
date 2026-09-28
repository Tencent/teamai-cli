# 团队密钥

[English](team-secrets.md)

提案：[#875](https://github.com/Tencent/teamai-cli/issues/875)。实施计划：[#879](https://github.com/Tencent/teamai-cli/issues/879)。

团队在团队仓库中声明成员需要哪些密钥，但不写值。每个成员在自己的机器上提供值。密钥的值不会写入团队仓库。

本文档随实现逐步补充，只描述当前版本已有的行为。目前包括声明密钥、成员为每个团队设置的值，以及 MCP server 中的 `${VAR}`。对本机所有团队生效的值和 `env exec` 会在后续版本加入。

## 声明密钥

密钥与 env 变量放在一起，但使用单独的文件：

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope, for the github MCP server and gh   # 可选
    url: https://github.com/settings/tokens                                      # 可选：成员获取 token 的地址
  - key: GITLAB_TOKEN
```

- `key` 必填，且必须是 shell 变量名（字母、数字和下划线，不以数字开头）。
- 条目带有其他任何键（包括 `value:`）时不会被声明，`pull` 和 `teamai doctor` 会指出文件、密钥和该键。值不应该写在这个文件里。
- 文件无法解析、没有顶层 `secrets:` 键，或同一个 key 定义了两次时，绝不会被当作"没有密钥"：本次不解析密钥，`env.sh` 和 env 备份保持原样，与 `env.yaml` 无法使用时相同。`pull` 会警告，`env list` 以非零状态退出，`teamai doctor` 的 `Team secrets can be resolved` 检查失败，三者都会指出文件和修复方法。
- 空文件或 `secrets: []` 表示没有声明任何密钥。

使用单独的文件，是为了让旧版 CLI（只读取 `env.yaml`）忽略它，旧版的 `teamai env add` 或 `env remove`（会重写 `env.yaml`）也不会把它丢掉。

目前由管理员直接编辑该文件，并用 `teamai push` 发布：`push` 会像 env 文件一样列出改动过的 `env/secrets.yaml` 或 `env/<ns>/secrets.yaml`，单仓库模式也一样。

## Namespace

namespace 在 `env/<ns>/secrets.yaml` 中声明自己的密钥，生效条件与 `env/<ns>/env.yaml` 相同：某个角色或项目在 `resources.env` 中列出了 `<ns>`。规则与 env 一致（见 [Env、hooks 与 MCP server 按 namespace 划分](../usage-guide.zh-CN.md#envhooks-与-mcp-server-按-namespace-划分)）：

- 生效 namespace 中的条目整体替换根文件中同 key 的条目。
- 同一个 key 出现在两个生效的 namespace 中，或在同一文件中出现两次，密钥解析失败。
- 旧模式（成员没有角色、团队也没有 `projects.yaml`）只读取 `env/secrets.yaml`，`teamai doctor` 会提示其中重复的 key。

`teamai doctor` 会把每个覆盖列为提示（`secrets: "GITHUB_TOKEN" from env/checkout/secrets.yaml replaces env/secrets.yaml`）。

## 状态

`teamai env list` 和 `teamai list env` 显示当前目录收到的每个已声明密钥、它的来源和状态。它们从不显示值，`--reveal` 也一样；`--reveal` 只显示 env 变量的明文。

| 状态 | 含义 |
|---|---|
| `team` | 成员用 `teamai env set` 为该团队设置了值。 |
| `environment` | 成员自己的环境中该 key 有非空值（见[解析顺序](#解析顺序)）。 |
| `missing` | 没有可用的值。 |

```text
Team secrets (3):

  GITHUB_TOKEN  team  (root)
  SENTRY_AUTH_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

`teamai list env` 显示相同信息，格式为 `GITHUB_TOKEN  secret, team  (root)`。加 `--verbose` 时两者都会打印 description，`env list` 还会打印 `url`。

## 设置值

成员为当前目录的团队保存某个已声明密钥的值：

```text
teamai env set GITHUB_TOKEN                               提示输入，不回显
printf '%s' "$TOKEN" | teamai env set GITHUB_TOKEN --stdin   供成员自己的脚本使用
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  每次使用时读取 WORK_GITHUB_TOKEN，不保存副本
teamai env unset GITHUB_TOKEN
```

- 值从不通过命令行参数传入，因此不会进入 shell 历史。`--stdin` 拒绝终端输入。
- `env set` 只接受该 scope 声明为密钥的 key。声明无法读取时它不做任何修改，因为无法判断。
- `--from-env` 指定的变量在当前 shell 中未设置时会警告。变量未设置期间该密钥为 `missing`：不会改用成员自己的环境，因为那可能是另一个账号的 token。
- 之后运行 `teamai pull` 更新 MCP server。

## 存储

- 每个团队仓库一个文件：`~/.teamai/secrets/teams/<team>-<hash>.json`，由 `teamai.yaml` 中的团队名和仓库标识的哈希组成，与 `teamai models configure` 为团队密钥文件命名的方式相同。使用同一团队的每个项目和 worktree 读取同一个文件，所以成员每个团队只需设置一次。
- 始终位于 `~/.teamai` 下，绝不放在 scope 的数据目录中（单仓模式下该目录在业务仓库内）。不使用 `~/.teamai/env`：它是用户 scope 的 env 备份文件。
- 以原子方式写入，权限 `0600`。这不是加密：能读取成员文件的人都能读到值。
- 每个条目恰好是 `{"value": "..."}` 或 `{"env": "VAR"}` 之一。文件无法解析或含有其他条目时，只报告路径以及行列号或条目序号，绝不输出其内容；修复之前，该团队的每个密钥都是 `missing`。
- 生命周期：卸载项目 scope 不会删除按团队保存的值，因为其他 scope 可能使用同一团队；卸载用户 scope（`teamai uninstall`）会删除 `~/.teamai`，值也随之删除。
- 模型配置的密钥保持原位（[模型配置](model-profiles.zh-CN.md)）：`env set` 不配置它们，`env/secrets.yaml` 也不能声明它们。

## 解析顺序

`mcp/mcp.yaml` 中的 `${VAR}` 按以下顺序解析已声明的密钥：

```text
成员为该团队设置的值          teamai env set KEY [--from-env VAR]
> 成员自己的环境              不包括 teamai env.sh 导出的值
> missing                     跳过该 server
```

团队值优先于环境，因为它是针对该团队的明确选择：否则 `.zshrc` 中导出的个人 `GITHUB_TOKEN` 会覆盖成员为工作团队设置的 token。未声明为密钥的变量按原有方式解析。

**成员自己的环境。** shell profile 加载最近一次 pull 的 scope 的 `env.sh`，因此环境中也带有 teamai 导出的值。对某个 key，环境中的值若等于本机任一 teamai `env.sh` 为该 key 导出的值（`~/.teamai/env.sh`、`~/.teamai/projects/*/env.sh`，以及本 scope 在 pull 重写之前的 `env.sh`），或者对已声明的密钥而言等于本 scope 的 `env.yaml` 值，则不计入。未覆盖的情况：本 scope 以外、位于非 git 目录的项目（`<dir>/.teamai/env.sh`），以及 shell 启动后被轮换的其他 scope 的值。

**同一个 key 出现两次。** 某个 key 既声明为密钥、又在 `env.yaml` 中设置为变量时，按密钥解析，仓库中的值在所有地方都被忽略：不写入 `env.sh` 和 env 备份（每次 pull 都如此，包括 `Already synced`），不出现在 `env list` 和 `list env` 中（`--reveal` 也一样），也不进入 MCP server。旧版 CLI 在团队删除该值之前继续使用该变量。

**不绑定主机。** 密钥会发往 `mcp.yaml` 中指定的任何 server，与 `${VAR}` 一贯的行为相同。与模型配置的密钥不同，它不绑定网关，因此能修改 `mcp.yaml` 或添加 namespace 的人决定成员的 token 发往哪里。能推送到团队仓库的人本来就能下发在每个成员机器上运行的 hooks。

**仍可访问。** 解析后的值仍以明文写入各工具的 MCP 配置（新文件以 `0600` 创建）。

## 轮换

曾经提交到团队仓库的 token 会保留在 git 历史中：先轮换它，再在这里声明，并让每个成员设置新值。用 `teamai env set` 设置新值后，`teamai pull` 会把它写入 MCP server。

## 声明结果分为不存在、有效和失败

成员读取的声明有三种结果，使用方必须区分：`absent`（该成员读取的密钥文件都不存在）、`valid`（可能一个都没声明）和 `failed`。失败的文件绝不会被当作"没有密钥"：否则使用方会在团队明明有密钥时按没有密钥处理。

## 工作流（#818）

工作流是未来的使用方。这里记录约定，保证两者衔接（[#818](https://github.com/Tencent/teamai-cli/issues/818)）：

- 步骤的 `requires.env` 引用这里或 `env.yaml` 中声明的 key，工作流中不再另列一份。
- 步骤只拿到它列出的密钥，而不是该 scope 声明的全部密钥。
- 缺少必需的 key 时，运行在开始前失败，并指出该 key。
- 无人值守的运行只从环境变量获取密钥，绝不通过命令行参数传入。
- 解析出的值在存储任何内容（outputs、`result.json`、运行事件）之前都会被遮盖。
- 以环境变量形式传入的 inputs 不能覆盖已声明的 key。
- 无头（headless）Agent 步骤获得该步骤的环境。
- `run-step` 不携带任何密钥值；远程执行器把 `env/secrets.yaml` 映射到它自己的密钥存储。
