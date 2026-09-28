# 团队密钥

[English](team-secrets.md)

提案：[#875](https://github.com/Tencent/teamai-cli/issues/875)。实施计划：[#879](https://github.com/Tencent/teamai-cli/issues/879)。

团队在团队仓库中声明成员需要哪些密钥，但不写值。每个成员在自己的机器上提供值。密钥的值不会写入团队仓库。

本文档随实现逐步补充，只描述当前版本已有的行为。目前包括声明密钥，以及按成员查看某个值是否可用。保存成员的值、MCP server 中的 `${VAR}` 以及 `env exec` 会在后续版本加入。

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
- 文件无法解析、没有顶层 `secrets:` 键，或同一个 key 定义了两次时，只有密钥失败：本次不解析密钥，env 变量照常下发。`pull` 会警告，`env list` 以非零状态退出，`teamai doctor` 的 `Team secrets can be resolved` 检查失败，三者都会指出文件和修复方法。
- 空文件或 `secrets: []` 表示没有声明任何密钥。

使用单独的文件，是为了让旧版 CLI（只读取 `env.yaml`）忽略它，旧版的 `teamai env add` 或 `env remove`（会重写 `env.yaml`）也不会把它丢掉。

管理员用 `teamai env add --secret` 声明密钥（不接受值），再用 `teamai push` 发布：`push` 会像 env 文件一样列出改动过的 `env/secrets.yaml` 或 `env/<ns>/secrets.yaml`，单仓库模式也一样。也可以直接编辑该文件。

```text
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai env add GITHUB_TOKEN --secret --role checkout     # 或 --project <id>：env/<ns>/secrets.yaml
teamai env remove GITHUB_TOKEN                          # 删除该声明（同样支持 --role / --project）
teamai push
```

- `env add KEY --secret` 声明该 key；若该文件已声明这个 key，则更新它的 `description` 和 `url`，未传的选项保留原值。key 后面带值会被拒绝且不会保存，`env add` 与 `env remove` 的任何输出都不会出现值。
- `env remove KEY` 在 `env.yaml` 设置了该 key 时删除这个变量，否则删除同目录 `secrets.yaml` 中的声明。`env remove KEY --secret` 只删除声明，用于两个文件都有该 key 的情况。
- 两个命令都不会编辑无法解析的密钥文件。`--role` 与 `--project` 选择 namespace 的方式与变量相同。

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
| `environment` | 成员的环境中该 key 有非空值。 |
| `missing` | 没有可用的值。 |

```text
Team secrets (2):

  GITHUB_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

`teamai list env` 显示相同信息，格式为 `GITHUB_TOKEN  secret, environment  (root)`。加 `--verbose` 时两者都会打印 description，`env list` 还会打印 `url`。

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
