# 团队密钥

[English](team-secrets.md)

提案：[#875](https://github.com/Tencent/teamai-cli/issues/875)。实施计划：[#879](https://github.com/Tencent/teamai-cli/issues/879)。

团队在团队仓库中声明成员需要哪些密钥，但不写值。每个成员在自己的机器上提供值。密钥的值不会写入团队仓库。

本文档随实现逐步补充，只描述当前版本已有的行为。目前包括声明密钥、成员为每个团队或为本机所有团队设置的值、MCP server 中的 `${VAR}`，pull 找不到已声明的密钥时保留 MCP 条目，告诉成员该运行什么命令，通过 `teamai env exec` 用团队的 env 和密钥运行 CLI，以及告诉 agent 有哪些密钥。团队普通的 `env.yaml` 变量也按同样的顺序解析：先取成员为该团队设置的值，再取 `env.yaml`；环境不再覆盖二者（见[变量](#变量)）。

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
- 文件无法解析、没有顶层 `secrets:` 键，或同一个 key 定义了两次时，绝不会被当作"没有密钥"：本次不解析密钥，`env.sh`、env 备份和 MCP server 保持原样，与 `env.yaml` 无法使用时相同；`env exec` 不应用任何变量和密钥，因为 `env.yaml` 中的任何 key 都可能是该文件声明的密钥。`pull` 会警告，`env list` 和 `mcp list` 以非零状态退出（`mcp list` 把 server 的变量显示为 `not resolved`），`teamai doctor` 的 `Team secrets can be resolved` 检查失败，它们都会指出文件和修复方法。
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
- 文件中声明了两次的 key 会让该文件每次读取都失败：`env add KEY --secret` 更新第一个声明并只保留它，`env remove` 删除它的全部声明；两者都会说明删除了几个重复声明。
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
| `team` | 成员用 `teamai env set` 为该团队设置了值。 |
| `global` | 成员用 `teamai env set --global` 为本机所有团队设置了值，且没有为该团队设置值。 |
| `environment` | 成员自己的环境中该 key 有非空值（见[解析顺序](#解析顺序)）。 |
| `missing` | 没有可用的值。 |
| `unreadable` | 成员为该团队或本机保存值的文件无法读取，因此无从判断。 |

```text
Team env variables (2):

  GITLAB_HOST=gi****  team  (root)
  API_URL=ht****  env.yaml  (checkout)

Team secrets (3):

  GITHUB_TOKEN  team  (root)
  SENTRY_AUTH_TOKEN  environment  (root)
  GITLAB_TOKEN  missing  (checkout)
```

两个命令打印同一份列表。每个变量显示它解析出的值（不加 `--reveal` 时打码）及其来源：`team` 表示成员自己的值（见[变量](#变量)），`env.yaml` 表示团队的值。声明无法使用时，变量只列出名字、不显示值，`--reveal` 也一样，因为其中任何一个都可能是 repo 值被忽略的密钥；值文件无法读取时，变量同样显示 `unreadable`。加 `--verbose` 时两者都会打印 description 和 `url`。

## 设置值

成员为当前目录的团队保存某个已声明密钥的值，或它收到的某个 env 变量的值（见[变量](#变量)）：

```text
teamai env set GITHUB_TOKEN                               提示输入，不回显
printf '%s' "$TOKEN" | teamai env set GITHUB_TOKEN --stdin   供成员自己的脚本使用
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  每次使用时读取 WORK_GITHUB_TOKEN，不保存副本
teamai env set GITHUB_TOKEN --global                      对本机所有团队生效；为某个团队设置的值仍然优先
teamai env unset GITHUB_TOKEN [--global]
```

- 值从不通过命令行参数传入，因此不会进入 shell 历史。`--stdin` 拒绝终端输入。
- `env set` 接受该 scope 声明为密钥的 key，不加 `--global` 时也接受它收到的 `env.yaml` 变量；`--global` 只用于密钥。在 Windows 上 key 可以用任意大小写输入：`env set` 和 `env unset` 使用该 scope 声明的名字，`env add --secret` 和 `env remove --secret` 使用已声明的名字，以其他大小写保存的值也属于该 key。声明或 `env.yaml` 无法读取时它不做任何修改，因为无法判断。项目配置存在但无法读取时，`env set`、`env unset` 和 `env list` 会报出该文件路径和原因并失败，而不是改用用户 scope，因为用户 scope 的团队未必是这个项目的团队。
- 不在任何 scope 中时（当前目录没有项目，也没有用户 scope），`env set --global` 接受任何合法的 key 名，并提示目前还没有团队声明它，方便成员提前设置在多个团队间复用的 token。`env unset` 接受任何已有值的 key。
- `--from-env` 指定的变量在当前 shell 中未设置时会警告。变量未设置期间该密钥为 `missing`：不会改用[解析顺序](#解析顺序)中的下一个来源，因为那可能是另一个账号的 token。
- 之后运行 `teamai pull` 更新 MCP server，变量还会更新 `env.sh`。

## 存储

- 每个团队仓库一个文件：`~/.teamai/secrets/teams/<hash>.json`，只由成员自己 `~/.teamai/config.yaml` 中团队仓库 URL 的 SHA-256 十六进制摘要（完整 64 个字符）命名，所以修改 `teamai.yaml` 中的 `team:` 不会丢失成员的值。不使用 `teamai.yaml` 的 `repo:`：复制来的或恶意的团队仓库可以声称另一个团队的 `repo:`，从而拿到那个团队的值；摘要也不截短，因为截短后恶意团队可以搜索出另一个文件名相同的 URL。使用同一团队的每个项目和 worktree 读取同一个文件，所以成员每个团队只需设置一次。
- 文件由 URL 中标识仓库的部分命名：协议（ssh 的各种写法 `ssh://`、`git+ssh://`、`ssh+git://` 和 scp 形式算同一个；`https` 与 `http` 是两个）、ssh 用户名、不区分大小写的主机、非协议默认值（22、443、80）的端口，以及原样的路径、查询串（query）和片段（fragment）。scp 形式中既不以 `/` 也不以 `~` 开头的路径位于 ssh 用户的主目录下，因此按 `~/` 加该路径计算，即 `ssh://host/~/…` 所指的路径；以 `/` 开头的 scp 路径以及其他所有 `ssh://` 路径都从根目录算起。只有 http(s) 凭据、路径结尾的斜杠，以及通过 ssh 或 http(s) 提供的仓库路径结尾的 `.git` 会被去掉（`file:///srv/team` 与 `file:///srv/team.git` 是两个目录，因此是两个文件），所以 `git@host:acme/team.git` 与 `ssh://git@host:22/~/acme/team` 共用一个文件，`git@host:/acme/team` 与 `ssh://git@host/acme/team` 也共用一个文件，而 `git@host:acme/team` 与 `ssh://git@host/acme/team`（一个在用户主目录下，一个从根目录算起）、`alice@host:team.git` 与 `bob@host:team.git`（各自是该用户主目录下的路径），`ssh://host:2222/acme/team` 与 `ssh://host:2223/acme/team`，以及 `https://host/team?tenant=a` 与 `https://host/team?tenant=b`，都绝不共享值。同一仓库的 ssh、https 和 http URL 对应不同的文件，因此同一主机上的 http 与 https 端点绝不共享值。
- 本机一个文件：`~/.teamai/secrets/machine.json`，格式相同。每个 scope 都从中读取自己声明的密钥。
- 始终位于 `~/.teamai` 下，绝不放在 scope 的数据目录中（单仓模式下该目录在业务仓库内）。不使用 `~/.teamai/env`：它是用户 scope 的 env 备份文件。
- 以原子方式写入，权限 `0600`。这不是加密：能读取成员文件的人都能读到值。
- 每个条目恰好是 `{"value": "..."}` 或 `{"env": "VAR"}` 之一，并带有 `kind`（`secret` 或 `variable`）：`env set` 写入时该 scope 把这个 key 声明为什么。没有 `kind` 的条目按密钥的值处理。条目只按它的 `kind` 使用：团队不再把某个 key 声明为密钥、而 `env.yaml` 仍设置它时，密钥的值绝不会作为变量导出；成员为变量设置的值也绝不会成为密钥的值。`env list` 会在该 key 下把另一种 `kind` 的条目显示为未使用，并给出修复方法：`teamai env unset KEY`，然后 `teamai env set KEY`。文件无法解析时只报告路径，含有其他条目时报告路径和条目序号，绝不输出其内容；修复之前，该团队的每个密钥（对 `machine.json` 而言是所有团队的每个密钥）都是 `unreadable`。
- 生命周期：卸载项目 scope 不会删除按团队保存的值和本机的值，因为其他 scope 可能使用它们；卸载用户 scope（`teamai uninstall`）会删除 `~/.teamai`，值也随之删除。
- 模型配置的密钥保持原位（[模型配置](model-profiles.zh-CN.md)）：`env set` 不配置它们，`env/secrets.yaml` 也不能声明它们。

## 解析顺序

`mcp/mcp.yaml` 中的 `${VAR}` 和 [`env exec`](#用-env-exec-运行-cli) 按以下顺序解析已声明的密钥：

```text
成员为该团队设置的值          teamai env set KEY [--from-env VAR]
> 成员为本机设置的值          teamai env set KEY --global
> 成员自己的环境              不包括 teamai env.sh 导出的值
> missing                     跳过该 server；env exec 不带它运行命令
```

团队值优先于环境，因为它是针对该团队的明确选择：否则 `.zshrc` 中导出的个人 `GITHUB_TOKEN` 会覆盖成员为工作团队设置的 token。本机值适合成员在所有团队中都使用的 token；需要另一个账号的团队设置自己的值，该值优先。

**成员自己的环境。** shell profile 加载最近一次 pull 的 scope 的 `env.sh`，因此环境中也带有 teamai 导出的值。对某个 key，环境中的值若等于本机任一 teamai `env.sh`（`~/.teamai/env.sh`、`~/.teamai/projects/*/env.sh`）当前或以前为该 key 导出的值，或者对已声明的密钥而言等于本 scope 的 `env.yaml` 值，则不计入。Windows 的环境变量名不区分大小写，一个 scope 导出的 `token` 就是另一个 scope 的 `TOKEN`，因此在 Windows 上这些比较以及下文标记和记录所哈希的 `KEY` 都忽略 key 的大小写。非 git 项目的 `env.sh` 位于 `<dir>/.teamai/env.sh`，扫描已知路径找不到它，因此每个 `env.sh` 还会导出一个标记变量 `TEAMAI_ENV_SH_<其 data home 的 SHA-256，64 位十六进制>`，其值列出它每个导出以及下文记录中保留的每个值的 `KEY=VALUE` SHA-256 前 12 位十六进制，从不包含值本身，因此重新 source 改写后的 `env.sh` 的 shell 仍会标记旧 `env.sh` 导出过的值；环境中某个标记列出的值同样不计入。在 pull 之前打开的 shell 在之后运行的每条命令中都带着旧值，因此每个 `env.sh` 旁边都有一份记录 `env.sh.exports.json`：对每个 key，记录它最近导出的 20 个值各自的 `KEY=VALUE` SHA-256，从不记录值本身，因此这份记录不会在本机多存一份团队的值或令牌（权限 `0600`）。在 `env exec` 下运行的命令保留这些标记，因此嵌套运行的 teamai 读到相同的来源信息；MCP 服务器永远拿不到标记。未覆盖的情况：shell 从扫描找不到、且由不写标记的 CLI 生成的 `env.sh` 得到的值，早于该 key 最近 20 个值的值，以及由不保留记录的 CLI 从 `env.sh` 中去掉的值。

### 变量

未声明为密钥的 `env.yaml` 变量在 MCP server、`env exec` 和 `env.sh` 中按同一顺序解析：

```text
成员为该团队设置的值   teamai env set KEY [--from-env VAR]
> env.yaml             根文件，或替换它的活动 namespace 文件
```

- 环境不再覆盖它，因此为一个团队导出的值不会进入另一个团队的 server。这会改变现有团队的行为：原先通过导出变量来覆盖 `env.yaml` 的成员，改用 `teamai env set KEY`。本机值不适用于变量。
- 当成员自己的环境（见下文）中有不同的值时，交互式 `pull` 和 `teamai doctor`（作为备注）会指出：`` GITLAB_HOST in your environment differs from the value in env/env.yaml, which this team uses. To use yours for this team, run `teamai env set GITLAB_HOST`. `` `doctor` 列出它，因为它在成员的 shell 中运行，可以解释 MCP server 为什么没有使用成员导出的值。`mcp list` 和 `env list` 不列出，静默 pull 什么也不输出。成员为该 key 设置了值之后不再输出。
- `env.sh` 导出成员设置的字面值，因此新 shell 遵循同一顺序。用 `--from-env` 保存的值不写入 `env.sh`，`env.sh` 中不保存它的副本，因此新 shell 中该 key 完全没有值，既没有成员的值也没有团队的值：shell 里有的是该条目读取的那个变量，而不是这个 key。MCP server 和 `env exec` 仍会解析它。该变量未设置期间使用 `env.yaml` 的值：与密钥的下一个来源不同，这是其他每个成员都拿到的值。
- 团队没有设置的 `${VAR}` 仍从环境解析。
- 成员的值文件无法读取时，MCP server 保留上一次 pull 写入的值，`pull` 保持 `env.sh` 不变，`teamai doctor` 的 `Your team secret values can be read` 检查失败并给出原因。

**同一个 key 出现两次。** 某个 key 既声明为密钥、又在 `env.yaml` 中设置为变量时（在 Windows 上不区分大小写，`token` 和 `TOKEN` 是同一个变量），按密钥解析，仓库中的值在所有地方都被忽略：不写入 `env.sh` 和 env 备份（每次 pull 都如此，包括 `Already synced`），不出现在 `env list` 和 `list env` 中（`--reveal` 也一样），也不进入 MCP server。旧版 CLI 在团队删除该值之前继续使用该变量。

**不绑定主机。** 密钥会发往 `mcp.yaml` 中指定的任何 server，与 `${VAR}` 一贯的行为相同。与模型配置的密钥不同，它不绑定网关，因此能修改 `mcp.yaml` 或添加 namespace 的人决定成员的 token 发往哪里。能推送到团队仓库的人本来就能下发在每个成员机器上运行的 hooks。

**仍可访问。** 解析后的值仍以明文写入各工具的 MCP 配置。含有已解析 `${VAR}` 值的配置以 `0600` 写入，已有的更宽权限文件（`.mcp.json` 常为 `0644`）也会收紧，即使 pull 没有改动其中任何内容，也会在不重写文件的情况下收紧为 `0600`，teamai 因含有这类值而排除在 git 之外的任何项目配置（包括已禁用或已移动的工具的配置）也一样；不含这类值的配置保持原权限，新文件以 `0600` 创建。在 `env exec` 下运行的命令会在环境变量中拿到它，它启动的每个进程也一样：agent 运行 `teamai env exec -- env` 就能读到。agent skill 禁止这样做，但没有任何机制强制。这让密钥不进入 git，而不是让它远离成员的机器或在上面运行的 agent。

**不进入 git。** 只有在本地克隆的 `.git/info/exclude` 列出某个项目级 MCP 配置之后，解析后的值才会写入该文件（#882）。exclude 规则挡不住 git 已跟踪的文件，因此无论是否为已声明密钥，解析后的值都不会写入 `git ls-files` 已跟踪的项目配置：pull 保持该文件原样（之前 pull 写入的条目保留），`pull`（警告）、`teamai mcp list`（`withheld:`）和 `teamai doctor`（`MCP servers delivered to <tool>` 失败）会指出该文件和修复方法：`git rm --cached <file>`，如果它曾随 token 一起提交过，还要轮换 token。因其他原因无法排除时（`.git/info` 或 exclude 文件不可写、另一个 teamai 命令占用它、git 出错），同样保持该文件原样，并给出对应的原因与修复方法。

## 缺少密钥时保留 MCP 条目

`mcp/mcp.yaml` 中的 `${VAR}` 可以引用已声明的密钥。会话开始时的 pull 运行在 agent 的环境里，而这个环境常常没有成员 shell 中导出的变量（从图形界面启动的工具，或在 `bash -lc` 下读不到的 zsh export），所以一个密钥可能这次 pull 能找到、下次就找不到。pull 找不到某个 server 所需的已声明密钥时：

- 之前某次 pull 写入过的 server 会在每个工具的配置中原样保留，并仍由 teamai 管理：之后某次 pull 找到值时会更新它。
- 还没有任何 pull 写入过的 server 照旧跳过。
- 该 server 从 `mcp.yaml` 中移除时，条目随之删除；`teamai mcp remove`、`teamai uninstall`，以及 `teamai init` 迁移 Claude Code 根目录时，也会删除它。
- 同时缺少某个未声明为密钥的变量的 server 照旧删除。未声明为密钥的变量保持现有行为。

保留下来的条目里是之前那次 pull 写入的值。密钥轮换或吊销后，server 会一直使用旧值，直到某次 pull 找到新值。

声明解析失败期间，`pull` 与 `teamai mcp inject` 不会改动任何 MCP server：不新增、不更新、不删除，`mcp inject` 以 1 退出。`mcp remove` 与 uninstall 仍会删除所有受管理的 server。

## 缺少密钥时告诉成员该运行什么

交互式 `pull`、`teamai mcp list`、`teamai env list`、`teamai doctor` 和 `teamai env exec`（输出到 stderr）会为每个没有值的已声明密钥打印一行：用到它的 MCP server（如果有）、设置它的命令，以及声明中的 `url`。

```text
github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (https://github.com/settings/tokens).
GITLAB_TOKEN is not set. Run `teamai env set GITLAB_TOKEN`.
```

- 这一行来自声明本身，所以没有 MCP server 用到的密钥、没有 `mcp.yaml`、没有可写入的工具、`sharing.mcp.autoApply` 关闭时也会打印。
- `doctor` 把它作为备注打印（`doctor --json` 中的 `notes`），退出码与没有这个缺失密钥时相同：只因已声明的密钥没有值而跳过的 server 不会让 `MCP servers delivered to <tool>` 失败。该工具的 server 有其他问题时仍会失败。
- 会话开始时的静默 pull 不打印任何内容。
- `pull` 和 `doctor` 还会在条目被保留、可能含有旧值时说明（`github: the entry an earlier pull wrote stays in claude and may hold an old GITHUB_TOKEN until a pull finds its value.`），并在某个 key 既声明为密钥、又在 `env.yaml` 中设置时发出警告：该值被忽略，并指出应从哪个文件删除它。
- 用 `--from-env` 保存、但对应变量未设置的密钥同样视为缺失，提示行会说明这一点：``GITHUB_TOKEN reads WORK_GITHUB_TOKEN, which is not set. Set WORK_GITHUB_TOKEN, or run `teamai env set GITHUB_TOKEN` to replace the reference.``（机器级的值在命令中带 `--global`）。
- 声明或成员的值文件无法读取时不打印这一行：命令会改为报告该失败。

## 用 `env exec` 运行 CLI

`gh`、`glab` 或公司发布的 CLI 从自己的环境变量读取 token。`teamai env exec` 用当前目录的团队 env 运行它：

```text
teamai env exec -- gh pr create
teamai env exec -- glab mr list     GITLAB_HOST 来自 env.yaml，GITLAB_TOKEN 来自成员，都按当前目录的团队
```

- **Scope。** 当前目录的 scope：teamai 在此处配置的项目（通过 git 查找，因此项目的每个 worktree 都解析到该项目），否则是用户 scope。
- **环境。** 命令继承 teamai 的环境，先按[变量顺序](#变量)叠加该 scope 的变量（scope 变量覆盖继承的同名变量），再按[解析顺序](#解析顺序)叠加它的密钥。声明为密钥、但在该 scope 下没有值的 key 会从命令的环境中移除，因此命令永远拿不到 `teamai env list` 不会显示为该 scope 的值：另一个团队导出的值，或者该团队的值用 `--from-env` 指向另一个变量时成员自己导出的值。Windows 上环境变量名不区分大小写，任意大小写的 key 都是同一个变量：叠加时替换继承的 `api_url` 或 `API_URL`，而不是再加一个同名变量；移除时移除它的所有大小写形式。
- **缺少密钥。** 那一[行提示](#缺少密钥时告诉成员该运行什么)输出到 stderr，命令照常运行：`gh` 和 `glab` 仍可以使用它们自己的登录。
- **失败。** 声明失败时，不应用任何变量和密钥，命令以继承的环境运行：`env.yaml` 中的任何 key 都可能是该文件声明的密钥，因此不传递它在仓库中的值，并移除继承环境中每个不属于成员自己的值（teamai `env.sh` 导出或曾经导出的值，按文件、记录或标记判断），在 stderr 上只列出 key 名；`env.yaml` 失败时，只应用密钥，不应用任何变量；值文件无法读取时，移除所有已声明的 key，也不应用任何变量。这两种情况下，每个不属于成员自己的继承值也会被移除，并在 stderr 上只列出 key 名，否则 sourced 过另一个团队 `env.sh` 的 shell 会把该团队的变量传下去。每种情况都会在 stderr 上说明。项目配置存在但无法读取时，会在 stderr 上指出该文件，并以继承的环境运行命令，与声明失败时一样移除每个不属于成员自己的值（包括该配置旁 `env.sh` 导出的值），只列出 key 名：既不当作"没有 scope"，也不回退到用户 scope。
- **没有 scope。** 既没有项目配置也没有用户配置时，命令以继承的环境运行，并在 stderr 上给出提示。这里不应用本机值，因为没有团队声明命令需要哪些 key。HTTP 团队仓库在这里同样不提供 env。这两种情况下，与声明失败时一样，每个不属于成员自己的继承值都会被移除，并在 stderr 上只按 key 名列出：sourced 过另一个团队 `env.sh` 的 shell 不会把该团队的值传下去。
- **输出。** teamai 打印的所有内容都输出到 stderr，因此命令的 stdout 可以直接接管道。退出码就是命令的退出码；命令被信号终止时，teamai 以同一信号结束；对于 Node 不会因之退出的信号（SIGPIPE、SIGUSR1），则以 128 + 信号编号退出。发给 teamai 的 SIGTERM 或 SIGHUP 会转发给命令。`Ctrl-C` 和 `Ctrl-\` 不转发：终端已经把它们发给了命令，第二个 SIGINT 会让 terraform 等工具强制退出，因此当 teamai 运行在其终端的前台进程组中时，它忽略 SIGINT 和 SIGQUIT 并等待命令结束。它在启动命令之前检查一次（`ps -o pgid=,tpgid=`）。在其他情况下（后台作业、没有终端的进程），SIGINT 或 SIGQUIT（`kill -INT <pid>`）是只发给 teamai 的，会转发给命令；`ps` 无法判断时也一样转发。在 Windows 上，控制台会把 `Ctrl-C` 发给所有附着在它上面的进程，因此 teamai 忽略它。Node 无法得知信号的发送者，因此当 teamai 运行在其终端的前台时，只发给 teamai PID 的 SIGINT 或 SIGQUIT（例如从另一个 shell 执行 `kill -INT <pid>`）同样不会转发，命令会继续运行：请向 teamai 发送 SIGTERM（会转发），或直接向命令的 PID 发信号。无法启动的命令以 127 退出。
- **不写入值。** 不会把任何值写入磁盘或 `debug.log`。查找 scope 的行为与其他查找 scope 的命令相同：可能接管项目分区、保存用户 scope 的角色迁移，或为刚克隆的单仓项目完成配置；这些写入都不包含值。
- **原样继承，有三个例外。** 没有终端时（所有 agent 都是这种情况），teamai 会在 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo` 和 `GCM_INTERACTIVE=never` 未设置时设置它们，让 git 子进程不会等待凭据提示。命令会继承它们。
- **不用于启动 agent。** 与模型配置写入的变量同名的变量或密钥（`ANTHROPIC_*`）会为该命令覆盖那个模型配置。`env exec` 用于 CLI，而不是用来启动 agent。
- 在命令前加 `--`：否则 teamai 会把命令自己的选项当作 teamai 的选项（`teamai env exec gh pr list --dry-run` 什么也不会运行），因此它会输出 `Put -- before the command: teamai env exec -- <command>` 并以退出码 2 结束。teamai 自己的选项可以放在 `--` 之前。

## 告诉 agent

不经过 `env exec` 运行 `gh` 的 agent 会悄无声息地使用它环境里恰好有的账号。scope 声明了密钥时，session-start hook 会在 agent 的上下文中加一行（`additionalContext`，与 MR 提示和 package 提示并列）：

```text
Team secrets in this scope: GITHUB_TOKEN (gh and the github MCP server), SENTRY_AUTH_TOKEN. Run the CLIs that need them through `teamai env exec -- <command>` so they get this team's values. Never ask for, read or print a secret value; if one is missing, ask the member to run `teamai env set KEY` in their own terminal.
```

- 这一行列出每个已声明的 key 及其 `description`，因此 description 应写明哪个工具或 server 使用该 key。它不含任何值，也不含状态。
- scope 没有声明密钥、密钥文件无法使用（`pull` 和 `doctor` 会报告）或目录中没有 teamai 时，不加这一行。
- 运行 SessionStart 但丢弃其输出的宿主（Hermes、Pi、OpenCode、OpenClaw），以及没有 hook 的 JoyCode，从 teamai core skill 获得同样的规则。
- skill 规定 agent 从不在对话中索要密钥值，从不通过 `--stdin` 传入值，从不读取值文件，也从不打印密钥（包括 `teamai env exec -- env`）。缺少密钥时，它请成员在自己的终端运行 `teamai env set KEY`。用 `env add --secret` 声明密钥不带值，因此 agent 可以运行它。

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
