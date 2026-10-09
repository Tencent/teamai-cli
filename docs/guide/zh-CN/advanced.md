# 进阶功能

> [English](../advanced.md) | [简体中文](advanced.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 进阶功能

### HTTP 契约（面向后端实现者）

使用 `teamai init --http <baseUrl>` 时，端点需要提供以下接口（`Authorization: Bearer <api-key>` 鉴权）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | session 启动：upsert agent + 已装 skill |
| `{baseUrl}/api/local-agent/sync` | POST | 上报状态 + 返回待执行的 skill 命令 |
| `{baseUrl}/api/local-agent/commands/ack` | POST | 回执单条命令（`{ id, status, error }`） |

`POST /api/local-agent/sync` 返回待执行命令：

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

删除最后一个 HTTP prompt 时，若目标无法更新，回执为 `failed`。缓存中的 prompt 和 manifest 记录均予以保留，修复标记或文件权限后可重试。

后端可下发 **`apply_model_config`** 任务，其 `cmd` 为 JSON。客户端同时兼容设计文档中的候选集结构和
旧版单模型结构：`{"models":[...]}` 按完整快照处理，直接模型对象按增量 upsert 处理。
`max_tokens` 可选（对应 CodeBuddy / WorkBuddy 的 `maxOutputTokens`）；缺省或 `0` 时默认 `4096`。Claude 不使用该字段。

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

候选集只会写入当前上报任务的 agent。CodeBuddy 使用用户级 `~/.codebuddy/models.json`（`{ "models": [...] }`）；
WorkBuddy 使用 `~/.workbuddy/models.json`；当前 `{ "models": [...] }` 和旧版顶层数组两种结构都支持，
已有文件保持原结构。CodeBuddy 或 WorkBuddy 的 workspace 级任务写入
`<workspace>/.codebuddy/models.json`，与产品内嵌模型加载器一致；该含凭证文件会被加入
`<workspace>/.codebuddy/.gitignore`。仅当目标路径已存在于 reporter 的 workspace bindings 中时，
才接受 workspace 级下发。若同一模型 ID 已由用户配置，则保留用户条目。
Claude 侧会生成独立配置 `~/.claude/teamai-models.json`；仅当不存在冲突的用户 Anthropic 网关配置时，
才把网关环境变量写入默认 settings。冲突检测会**同时**检查 `~/.claude/settings.json` 的 `env` 和当前进程的
shell 环境变量（`export ANTHROPIC_*`），因此通过 shell 环境变量使用 Claude 的用户会保留自己的网关——
TeamAI 跳过写入，并把跳过的 key 记入 `~/.teamai/reporter/errors.jsonl`。受保护的 key 包括
`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`、
`ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}` 以及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`。
若某个 shell 值与 TeamAI 上次写入的值一致（Claude 会把 `settings.json` 的 `env` 回注到 hook 进程），
则识别为托管值而非用户冲突，因此后续同步仍可更新或删除托管网关。不支持的 agent 会回执失败，不会误写其他
agent 的配置。用户配置文件是符号链接时会保留链接。以上含凭证文件权限均为 `0600`。落盘成功后以
`type: "apply_model_config"` 回执；非法 payload 回执 `failed`。未来未知任务类型会静默跳过，以保持协议向后兼容。

反向的模型上报走已有的 `report` 接口：仅上报 TeamAI manifest 已记录、且磁盘上的模型 ID 和
provider 仍可识别的模型，用户级放在 `user_level.models`，workspace 级放在对应的
`workspaces[].models`。agent 正常补充元数据不会导致漏报；
模型落盘成功后会在同一次 sync 中立即补一次 report，无需等待下一次 session。用户自有模型不上报，
因为后台无法识别。服务端要求 `provider` 与 `model_id` 同时存在。与 skills/rules 一致，没有任何符合条件的
模型时该字段整体省略——因为存在的数组会被当作全量快照。CodeBuddy、WorkBuddy 和 Claude
（`~/.claude/settings.json` 里的 `ANTHROPIC_CUSTOM_MODEL_OPTION` 网关）有可发现的模型配置，
其余工具不上报。上报条目的 `source` 固定为 `enterprise`。
**`api_key` 不会被回传** —— ProxyToken 只留在本地磁盘。

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

HTTP 契约用于自建集成。普通用户只需使用[成员接入](./member-guide.md#成员接入)中的 `teamai init --http` 命令。

### 代码知识图谱

`teamai import` 将源码仓库解析为结构化知识图谱（存储在团队仓库的 `teamwiki/` 目录下），实现结构感知的知识检索：

```bash
# 从本地目录提取
teamai import --dir /path/to/project

# 从远程仓库导入
teamai import --from-repo https://github.com/org/repo

# 批量导入组织下所有仓库
teamai import --from-org myorg

# 从白名单批量导入
teamai import --from-repo-list repos.yaml

# 从已合并的 MR/PR 提取经验
teamai import --from-mr https://github.com/org/repo/pull/123

# 增量模式（跳过未变更文件）
teamai import --from-repo https://github.com/org/repo --incremental

# 仅提取结构，跳过 AI 增强
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

如果核心知识图谱提取或写入失败，导入会报错，且不会将该提交标记为已同步。下次增量导入会重试该提交。

使用 `--from-iwiki` 时，MCP 工具响应中的 `isError: true` 表示请求失败，即使响应包含文本。正文或元数据请求失败的页面会告警并在 AI 分类之前跳过；成功获取的页面仍会导入。页面树请求失败时会告警，并返回空的子页面列表。

加 `--dry-run` 时，`--from-repo` 与 `--from-repo-list` 用 `git ls-remote` 读取每个仓库的目标提交，打印 `Would import <owner>/<repo> at <commit>` 以及本地缓存是否最新，然后停止：不会 clone 或 fetch 到缓存，不会获取导入锁，也不会运行任何 AI 步骤。使用 `--incremental` 且缓存含 `LAST_SYNC` 时，预览会查询该缓存配置的 origin 上当前分支的提交，与真实 fetch/reset 一致。完整克隆预览（包括缺少缓存或 `LAST_SYNC`）跟随远端 HEAD。若缓存分支已从远端删除，不执行 prune 的通配 fetch 会保留缓存 origin 引用，增量预览也使用该保留提交。启用 prune、显式 fetch 已删除分支或缺少缓存 origin 引用时，仍预览完整克隆回退。其他缓存分支查询失败时，预览会警告并预览完整克隆回退。 指定 `--output` 时，预览会显示与真实导入相同的输出文件旁 `teamwiki/evidence/code/<slug>` 目标目录。

`--from-mr` 与 `teamai contribute` 的默认行为一样，把提取的经验发布到 `teamai-learnings` 分支：激活项目合计解析出恰好一个 learnings namespace 时放在 `learnings/<namespace>/` 下，否则放在共享的 `learnings/` 根目录。发布失败时，经验留在本机队列中，下次 `teamai pull` 会发布它；若阻止发布的是 teamai 拒绝使用的 learnings 检出，则在你按提示处理该检出之前，任何 pull 都无法发布它。

如果草稿与已有经验（共享根目录或当前激活项目的 namespace 中的）高度重叠，命令会列出这些文件（`Possible duplicate: this learning overlaps N existing learning(s): <files>.`），使用 `--all` 时同样如此。这只是提示：不会标记或替换任何已有经验。`manifest/projects.yaml` 无法读取时，只与共享根目录比较，并给出提示。

需要 AI 的步骤（`--deep-enrich`、知识增强）复用本机已安装的 AI 编码 CLI，而不是直接调用模型 API。teamai 按 `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` 的顺序探测，取第一个可用者。macOS / Linux 上探测经由 login shell，因此装在 `~/.nvm/` 下的 CLI 也能找到；Windows 上改用原生命令 `where`，拿到的是 Windows 真正能启动的 npm shim（`%APPDATA%\npm\claude.cmd`）——Git Bash 或 WSL 的 `bash` 只会返回 `/c/Users/...` 这类 MSYS 路径，Windows 无法启动。

使用 `--from-org --dry-run` 时，CLI 展示本次过滤条件选中的仓库及白名单目标路径，不读取旧草稿、不写入白名单、不克隆仓库、不获取导入锁，也不运行 AI 增强。`--skip-import` 只预览白名单条目。CLI 原有的诊断日志记录仍会执行。

对于 API 网关后的 GitLab，先设置 `GITLAB_URL` 和 `GITLAB_API_PREFIX=api/gitlab`，再运行 `teamai import --from-org https://gitlab.example.com/myorg`。组织仓库列表的每一页请求都会使用配置的前缀；未设置或为空时默认使用 `api/v4`。

图谱存储组件、接口、配置和跨仓库依赖关系。`teamai recall` 会将 learnings 与图谱 BM25 命中转换到有界的相关性分数尺度后合并排序。

依赖边由两条并行轨道提取：WASM tree-sitter **AST 轨**（TypeScript/JavaScript、Python、Go、Swift），将 import、调用、以及 TS `implements` 子句解析为精确的文件到文件边（`code-ast`）；以及正则 **启发式轨**（所有语言，`code-heuristic`），同时覆盖 AST 轨未支持的语言。重叠时 AST 结果优先。AST 解析器无需原生编译工具链；加载失败时提取会降级到启发式并记录一条 `AST_UNAVAILABLE` gap。设置 `TEAMAI_SKIP_AST=1` 可强制仅用启发式提取。

```bash
# 从本地仓库提取代码事实与图谱（写入 <repo>/teamwiki/）
teamai codebase --extract /path/to/repo --project my-service

# 增量刷新：复用首次提取的仓库路径和项目名
teamai codebase --extract /path/to/repo --project my-service --incremental

# 从已提取的 evidence 生成深度知识文档（--output 指向仓库根目录）
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# 将 teamwiki/product 和 teamwiki/docs 与提取的代码页面进行对账
teamai codebase --reconcile --output /path/to/repo

# 检查本地提取的图谱；--output 指向仓库根目录，而非 teamwiki/
teamai codebase --lint --output /path/to/repo
```

只要 extract 发现了组件，就会写入 `teamwiki/evidence/code/<project>/_manifest.json`（包括跳过 AI 增强或增强没有产出的情况），因此 `--deep-enrich` 可以接着跑。

不传 `--project` 时，`<project>` 取目录名；在检出的根目录下（主检出或 git 链接 worktree）取仓库名：主检出的真实目录名（经符号链接打开时也是如此），或 bare 仓库的名称（`repo/.bare` 或 `repo.git` → `repo`）。同一仓库的所有检出写入同一个条目。`teamai import --dir` 用同样的方式确定 slug。

`.teamai/pending-review.jsonl` 中的待审改动可用 `teamai review` 查看。用 `teamai review <id> --apply --dry-run`、`teamai review <id> --reject --dry-run` 或 `teamai review --all-apply --max-risk medium --dry-run` 预览处理决定。应用预览会执行与真实应用相同的目标文件和托管章节校验，但不会修改文档或移除待审项；批量预览保留相同的类型与风险筛选。处理预览的 `--json` 输出包含 `dryRun: true`，其中 `ok` 表示通过校验，不表示已写入。去掉 `--dry-run` 才会执行处理。

**按 namespace 分发 wiki。** `recall` 对 `teamwiki/evidence/code/<slug>/` 采用与 docs 相同的作用域规则：只要有任一角色（`manifest/roles.yaml`）或项目（`manifest/projects.yaml`）在 `resources.wiki` 中列出某个 codebase slug，它就只分发给激活了它的成员；未声明的 slug 仍然共享：

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]     # 只有激活 svc-a 时才能看到 evidence/code/svc-a/
```

这个 slug 就是 `teamai codebase --project <slug>`（或 `teamai import`）写入 `evidence/code/` 时用的那个值，它与 manifest 的 project id 没有必然关系，按实际提取时用的那个值声明即可。旧式用法（没有角色、没有 `projects.yaml`）会搜索所有 codebase，和之前一样。

### Dashboard

```bash
teamai dashboard             # 启动 Web 面板（默认端口 3721）
teamai dashboard --port 8080
```

侧栏包含 **Overview（总览）**、**Team Execution（团队执行）**、**Team Context（团队上下文）**、**Team Improvement（团队改进）**。总览汇总三模块；执行页展示本机会话，支持按仓库（同一仓库的所有 worktree 合为一项）和 AI 工具筛选及完整详情；上下文页保留 KB Health（含作者贡献和从未召回条目）；改进页保留本机趋势及晋升、归档、质量更新维护命令。命令需在终端使用，页面不执行维护操作。

页头支持英文/简体中文及日间/夜间/跟随系统主题，浏览器存储可用时记住偏好。用户输入、AI 输出、知识标题和命令保持原文。独立 `/kb-report` 继续提供原有完整报告。

实时状态仅限**本机**，沿用事件流与 SSE，支持自动重连并轮询校准会话状态。最近结束会话仍按原有 30 秒保留窗口展示。知识报告显示本机/团队来源及报告生成时间，**不将其称为团队同步时间或跨成员实时状态**。刷新失败时明确提示，并保留上一次成功结果供参考。

工作区切换覆盖已安装的项目范围和用户范围；同一项目的 worktree 归为一个项目，全部工作区视图显示全部本机会话及启动时的知识库范围。新安装范围后重启仪表盘即可发现。

#### 人工干预指标（Human Intervention）

每个会话行显示**人工干预次数**，悬停或打开详情可查看分类明细，三类信号各计一次：

| 类型 | 含义 | 数据来源 |
|------|------|----------|
| `interrupt` | 用户在 agent 执行中途按 ESC 打断 | transcript 中被中断的 turn |
| `toolReject` | 用户拒绝某个工具调用（permission deny） | transcript 中标记拒绝的 tool_result |
| `correction` | agent stop 后 60s 内用户追加含「不对 / 重来 / 错了 / wrong / redo / 違う / やり直し」等纠偏词（内置中、英、日，外加团队自定义词）的 prompt | stop → prompt_submit 事件模式 |

> 隐私：团队共享的干预统计仅含计数。本机 dashboard 事件流可保存经密钥脱敏且最长 200 个字符的输入摘要与 AI 输出用于详情展示；`~/.teamai/debug.log` 会记录相同的脱敏输入摘要。页面不会上传这些内容。

以空格分词的文字（英语、西班牙语等）中的纠偏词必须整词匹配，因此西班牙语 "segundo" 不会被算作 `undo`；中文、日文纠偏词仍按子串匹配。内置列表只覆盖中、英、日三种语言，其他语言的纠偏在团队于 `teamai.yaml` 添加自己的词之前不会被识别。团队词与内置列表合并，忽略大小写，遵循同样的匹配规则：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, deshaz, "no era eso", "otra vez"]
```

匹配在 `UserPromptSubmit` hook 捕获 prompt 时完成，因此修改团队纠偏词后，下一次 `teamai pull` 之后的新 prompt 才会生效；之前记录的会话不会重新评估。

匹配时，prompt 和纠偏词都会转换为 Unicode NFC 形式。例如，`réessaye` 可以匹配 `re\u0301essaye`，其中 `\u0301` 是组合尖音符。重音符号仍有区别，因此 `reessaye` 不匹配。规范化仅用于匹配，不会改变 60 秒的纠偏时间窗口。纠偏检测在内存中使用原始 prompt，随后丢弃原文；本机仅保存经密钥脱敏且最长 200 个字符的摘要。

干预数据会随 `teamai pull` 自动聚合上报到团队 `stats/<user>.yaml`，并在 `teamai digest` 的「会话自主性」榜单中给出团队均值与人均干预率排行，可用于验证某个 skill / rule 上线后干预率是否下降。无 transcript 的工具（如 Cursor）会优雅降级，只统计 `correction`。

#### 对话量与 Token 用量

每个会话行还显示以下两列；详情保留经密钥脱敏的输入摘要、Markdown AI 输出、时间戳和最近工具：

| 列 | 含义 | 数据来源 |
|------|------|----------|
| 对话轮数 | 该会话里**人类对话的轮数**（发了几次 prompt） | `UserPromptSubmit` 事件数 |
| Token | 该会话累计 **token 用量**（鼠标悬停看 输入 / 输出 / 缓存读 / 缓存写 明细） | Claude Code `message.usage`、CodeBuddy `requests[].usage`，或 Codex 最新的会话级 `token_usage_record`；旧版 `event_msg.token_count` 按 rollout 文件各取最新快照后累加 |

> 隐私：团队共享的轮数和 Token 指标仅含计数。Dashboard 详情中的脱敏输入摘要和输出保留在本机。

这两项同样随 `teamai pull` 聚合到 `stats/<user>.yaml`（`prompts` 与 `tokens` 字段），并在 `teamai digest` 的「对话量与 Token 用量」板块给出团队对话总轮数、token 总量（分桶）与人均 token 用量排行。拿不到 transcript 的工具（如 Cursor）会优雅降级：仍统计对话轮数，token 显示为 0 / N/A。

#### 每日会话趋势与估算成本

Dashboard 和 digest 会比较最近 7 个 UTC 自然日与此前 7 天。Dashboard 费用卡片改为**有定价数据会话的平均已知估算费用**：先筛选首次 Stop 落在该窗口的会话，汇总这些会话已知的已定价请求费用，再除以其中至少有一个已定价请求的会话数。无定价数据的会话不进分母；已定价且费用为零的会话计入。卡片展示定价覆盖数。恢复执行的会话仍归属首次 Stop 日期，其他日期的已知请求费用也计入该会话。原有 `avgRequestCostMicros` 接口字段和 digest 按请求日期统计的口径不变。会话归属到首次 stop 事件所在日期，每个已定价请求则归属到请求自身的 UTC 日期；活跃时长只累计不超过 5 分钟的相邻事件间隔，避免终端空闲时间把数据放大。会话结束时没有错误、中断或纠偏才计为成功；被拒绝的工具调用仍作为独立干预信号统计。仅包含模型、token 数、估算成本和价格表版本的请求明细保存在本地 `~/.teamai/dashboard/requests.jsonl`，不包含提示词或回复内容；重复 Stop 不会重复写入，超过 90 天会自动清理。

成本是 API 等价估算值：对可识别的 Claude 模型，根据带版本的公开目录价，以及 transcript 中的输入、输出、缓存读取和缓存写入 token 分桶计算。由于 transcript 不提供缓存 TTL，缓存写入按 5 分钟费率估算。未知模型以及无法取得详细用量的工具不会进入估算成本，也不会进入成本覆盖率分母。该数据适合观察趋势，但不等同于账单或订阅席位费用。

每日聚合会在 `teamai pull` 时写入 `stats/<user>.yaml`；原有累计字段继续作为历史总量展示。恢复执行的会话会在原记录上更新，不会重复累计已完成会话。团队仓库只接收聚合计数和按微美元保存的估算总额；prompt 原文与逐请求记录保留在本机。

### Session Save（会话存档）

`teamai session save` 把 dashboard 已有的**单次会话事件流**（工具调用序列、prompt 轮次、干预记录）折叠成一份精简、脱敏的 markdown 摘要——不调用 LLM，也不新增采集路径。

```bash
teamai session save                    # 存档当前 agent 会话（否则为最近一次会话，本地）
teamai session save --session-id <id>  # 存档指定会话
teamai session save --push             # 把「有价值」的会话推送到团队仓库
teamai session save --push --force     # 即便是琐碎会话也推送
teamai session save --push --include-prompt  # 额外带上（脱敏后的）首个 prompt 行
```

**本地（始终执行）：** 追加到 `~/.teamai/session-logs/<年-月>.md`。按会话幂等（当月已记录的会话会跳过），且超过 90 天的日志会自动清理。每条记录用 `Project:` 标出会话所属的仓库（同一仓库的所有 worktree 相同），用 `Directory:` 标出其工作目录。

**团队（`--push`，需显式开启）：** 直接提交（不走 PR）到 `teamai-reports` 分支的 `sessions/<user>/<年-月>.md`——正是 `teamai digest` 读取的路径，于是该会话会出现在 **Session Highlights** 板块。默认只推送**有价值**的会话：出现摩擦（interrupt / tool-reject / correction）或工具使用充分（≥ 3 种不同工具）。琐碎会话除非加 `--force`，否则只留本地。对只读（HTTP 模式）的团队，`--push` 会优雅失败并保留本地日志。

> 隐私：推送到团队的内容默认**只含计数 + 工具名**。首个 prompt 行需通过 `--include-prompt` 显式开启，且即便开启也会经过与别处一致的密钥脱敏（`ghp_…` → `<REDACTED:…>`）。本地日志因为不出本机，会保留脱敏后的首个 prompt 行。

### Hooks

`teamai init` 自动注入的 Hooks：

| Hook 事件 | 操作 |
|-----------|------|
| `SessionStart` | 先为当前 Agent 创建项目根目录（project scope），再自动 pull + 上报会话启动 |
| `PostToolUse` | skill 追踪 + 知识贡献检测 + dashboard 上报 |
| `UserPromptSubmit` | slash 命令追踪 |
| `Stop` | CLI 更新检查 + 上报会话结束 |

```bash
teamai hooks list      # 查看生效的内置和团队 hooks
teamai hooks inject --dry-run # 预览，不修改工具设置或受管 hook 记录
teamai hooks inject    # 重新注入
teamai hooks remove    # 移除
```

`hooks list` 按工具分别列出内置 hooks，因为各工具的集合并不相同：Copilot 额外有 `SessionEnd`，Claude Code、Codex、CodeBuddy 和 Qoder 额外有 `SubagentStop`，Codex 系工具还额外有 `SubagentStart`（为其启动的子 agent 提供项目的团队 rule 和指令），OMP 扩展覆盖四个事件且没有 `Skill` / `TodoWrite` matcher，OpenClaw 只映射 `SessionStart` + `UserPromptSubmit`，Hermes 只有 `SessionStart`。hook 注入流程不会为其安装任何内置 hook 的工具（如 JoyCode）不会列出；Kiro 也不列出——它的 `SessionStart` 由 agent 同步以 `hooks.agentSpawn` 形式内嵌，只存在于你实际同步过的 agent 中。

inject 和 remove 只会操作你实际已安装的工具（即 `~/.<tool>/` 根目录已存在的工具）。对于 `toolPaths` 中已配置但未安装的工具，命令不会为其凭空创建根目录。HOME 和当前 worktree 的工具根目录缺失时，主 checkout 中现存的 Claude/Codex hook 文件也视为已安装的目标。inject 和 pull 会更新这些团队 hooks 并恢复 HOME 中的内置 hooks；remove 会清理主 checkout 中的托管 hooks，而不重建 HOME 根目录。

Git hook 安装失败时，`hooks inject`、`init` 和单仓库自动初始化仍会尝试信任已经写入的 Codex hooks。注入保留安装错误，不显示整体成功。init 报告错误，并在完成本地设置时保持退出码 1，HTTP 初始化也如此。自动初始化在 debug 日志中记录该错误，然后继续本地设置。

非-self 的 project scope 中，`hooks remove` 会移除 HOME 中当前 checkout 的门控团队 hooks，以及主 checkout 中 Claude/Codex 的团队 hooks。其他项目的门控团队 hooks 保留在 HOME；共享的内置 hooks 会被移除。

> **OpenClaw** — teamai 的 hook 是一个 workspace hook，位于 `<workspace>/hooks/teamai-status-report`。它在 `command:new`、`command:reset`、`session:auto-reset` 和 `gateway:startup` 时运行 `session-start`，在 `message:received` 时运行 `prompt-submit`，并以事件中的 workspace 作为 hook 的 `cwd`。OpenClaw 只有在 `openclaw.json` 启用了某个 workspace hook 的条目时才会加载它，因此 init、pull 和 `hooks inject` 会写入 `hooks.internal.entries.teamai-status-report.enabled: true`，`hooks remove` 和 uninstall 会将其移除。若 OpenClaw 正在加载它发现的所有 hook（`hooks.internal.enabled: true` 且没有具名条目），新增第一个条目会把发现模式变成白名单，从而停掉你的其他 hook，所以 teamai 不改动配置，只给出警告；当你关闭了该 hook 或整个 internal hooks，或 `openclaw.json` 不是纯 JSON 时也同样处理。此时请自行运行 `openclaw hooks enable teamai-status-report`。旧版 teamai 在设置了 `OPENCLAW_STATE_DIR` 时会自行写入 `hooks.internal.enabled: true`，因此这类机器在你运行该命令前都会看到这条警告。服务端下发的 agent hook 位于 `<state dir>/hooks/<slug>`，并有自己的条目 `teamai-agent-<slug>`。workspace 与配置的查找方式与 OpenClaw 一致：`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR` 或 `OPENCLAW_PROFILE`（`~/.openclaw-<profile>`），然后是 `agents.defaults.workspace`、`OPENCLAW_WORKSPACE_DIR` 或 `<state dir>/workspace`。条目缺失或被关闭时，`doctor` 的 `OpenClaw hook enabled` 检查会失败。

在 Windows 上，经由 bash 执行的内置 hook 派发命令（如 Claude、Codex、Cursor、Copilot CLI）会以绝对路径引用 Git Bash——先查标准安装位置，再回退到 `HKLM\SOFTWARE\GitForWindows` 注册表——从而避免解析到 WSL 的 `bash.exe`；若找不到 Git Bash，则退回裸 `bash`。

Cursor 也会加载 `~/.claude/settings.json`。Copilot CLI 会加载受信任项目里的 `.claude/settings.json`（self mode 把 hook 写在项目里；Copilot 不加载 `~/.claude/settings.json`）。只有另一边的 teamai hook 已经在磁盘上时，`hook-dispatch --tool claude` 才会退出：`~/.cursor/hooks.json` 或 `$CURSOR_PROJECT_DIR/.cursor/hooks.json` 含有 `--tool cursor`，或 `$COPILOT_PROJECT_DIR/.github/hooks/teamai.json` 含有 `--tool copilot`。写给 `claude` 的团队 hook 命令用同一判断。只启用了 Claude 时，Cursor 里这份 hook 照常运行，因为没有第二份可以接替。`COPILOT_CLI` 不能当信号：Copilot 会给每个子进程设置它，包括从它的 shell 里启动的 Claude。Claude Code 不会设置 `CURSOR_VERSION` 或 `COPILOT_PROJECT_DIR`。已经装好的团队 hook 需要再跑一次 `teamai pull` 或 `teamai hooks inject`，才会带上这个判断。

> **Codex hook 信任** — Codex（OpenAI / ChatGPT Codex 应用，工具 id 为 `codex`）只运行已信任的非托管 hook，未信任或已变更的 hook 会被静默跳过；且只有项目被信任时才读取其 `.codex/`。因此每次写入 Codex hooks 文件后（`init`、每次 `pull`（含 SessionStart 触发的 pull）、`teamai hooks inject`），teamai 都会通过 `codex app-server` 信任它写入的那些 hook——与 Codex `/hooks` 信任提示调用的是同一接口。同一文件里你自己的 hook 不受影响，即使命令与团队 hook 相同。Codex 所有权记录包含事件、位置和完整生成条目，信任操作只选择对应的 Codex key。其他条目移动它的位置时，仅在完整定义唯一匹配时恢复所有权。旧 manifest 只记录事件、matcher 和命令，因此这些字段唯一匹配时，即使 hook 包含 `timeout` 或 `additionalContextLimit`，也可恢复所有权。对于 #370 之前的项目 Codex hooks，teamai 先从主 checkout 的 `.teamai/managed-hooks.json` 导入所有权，再用新 manifest 同步同一个文件；直接移除时也如此。没有所有权记录或无法区分的旧团队 hook 副本会保留。在项目中，当 Codex 需要从主 checkout 的 `.codex/` 读取 teamai 的 hooks 或 MCP servers 时，teamai 也会信任该主 checkout；bare 仓库则在当前 worktree 写入并信任。你在 Codex 中标记为不信任的项目保持不变，teamai 会提示。SessionStart 触发的 pull 写入的信任从下一个 Codex 会话起生效：当前会话已加载了它的 hooks。linked worktree 只有在存在 `.codex/` 目录时才读取主 checkout 的 `.codex/hooks.json`。post-checkout 准备步骤会为所选的 Codex 工具创建该目录，并在第一个会话之前完成 pull。跳过 checkout hooks 的宿主必须在启动 Codex 前完成准备。如果仅由 SessionStart 创建该目录，团队 hooks 从下一个 Codex 会话起加载；内置 hooks 位于 `~/.codex/hooks.json`，从第一个会话起就运行。若要自行信任，在 `config.yaml` 中设置 `codexTrustEnabled: false`。PATH 中没有 `codex` 或 app-server 失败时，`init` 和 `hooks inject` 会提示你在 `/hooks` 或 Settings → Hooks 中信任。交互式 pull 仅在 app-server 失败时警告，缺少 `codex` 时保持静默；silent pull 将结果记录在 debug 日志中。`teamai doctor` 会向 Codex 查询哪些 teamai hooks 不会运行并逐一列出。

### 团队 Hooks 声明

团队可在仓库 `hooks/hooks.yaml` 中声明自定义 hooks，按 namespace 划分的写在 `hooks/<ns>/hooks.yaml`（见 [Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)），`teamai pull` 会自动分发到支持团队 Hooks 的适配器。`builtin:` 只从 `hooks/hooks.yaml` 读取。Pi 目前仅支持 TeamAI 内置生命周期桥接；此文件中的自定义 Hooks 和内置 Hook 覆盖不会应用到 Pi。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 20 }
```

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，`^[a-z0-9-]+$` |
| `event` | Claude PascalCase 事件名（跨工具通用） |
| `matcher` | 可选，工具 matcher |
| `tools` | 可选，目标工具列表（默认 = 所有 hook 支持的工具） |
| `roles` | 已弃用：请改用 `hooks/<ns>/hooks.yaml`。在一个次版本内仍按角色 id 过滤，并警告给出目标文件 |
| `builtin.disabled` | 禁用的内置 hook 列表 |
| `builtin.overrides` | 仅可覆盖内置 hook 的 `timeout` |

安全治理：
- `sharing.hooks.autoApply: false`（`teamai.yaml`）：pull 时仅提示，需手动 `teamai hooks inject` 确认
- `sharing.hooks.requireTeamScripts: true`：拒绝 command 不在 `~/.teamai/team-scripts/` 下的 hook
- `TEAMAI_HOOKS_DISABLED=1`：本地禁用所有团队 hooks（内置 hooks 不受影响）

### Agents 资源类型

团队仓库可在 `agents/` 目录下维护自定义 subagent 定义（每个 agent 一个 `*.yaml` 或旧格式 `*.md` 文件）。根目录文件对所有成员生效；一层子目录可按角色/项目划分 agents，规则与 `rules/<namespace>/` 相同：

```text
team-repo/
  agents/
    code-reviewer.md              # 团队自定义 subagent，所有人共享
    frontend/vr-reviewer.yaml     # 仅同步给 `agents:` 中列出 `frontend` 的角色/项目
    .removed                      # tombstone（由 teamai remove agents <name> 自动管理）
```

```yaml
# manifest/roles.yaml（manifest/projects.yaml 使用同一个 key）
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # 可选；省略 = 只同步根目录 agents
```

真正生效的 namespace（`knowledge`、`skills`、`agents`）都会成为目录名，因此必须是
单个路径片段：不含 `/`、`\`、`:` 和控制字符，结尾不能是 `.` 或空格，也不能是
Windows 设备名，且同一资源类型下的两个 namespace 不能仅有大小写差异；`manifest/roles.yaml`
与 `manifest/projects.yaml` 规则一致，且两者之间也做该校验。role 的
`learnings:` 仅为向后兼容而保留、运行时忽略（learnings 按 project 而非 role 划分
namespace），不会成为目录名，因此不做校验。

`teamai pull` 会将它们按文件名拍平复制到每个 Tier-1 工具的 `agents/` 目录（如 `~/.claude/agents/`），因此两个活跃 namespace 不能定义同名 agent（pull 会报告冲突，本次运行保持已安装的 agents 不变；其他资源类型照常同步）。活跃 namespace 中的 agent 会替换根目录的同名 agent，该 namespace 不再活跃后根目录 agent 会恢复。未配置角色或项目时所有 namespace 都会同步，因此根目录与 namespace 中的同名 agent 同样会冲突。`teamai pull` 为 Codex 系工具写入 `<name>.toml`，为 Kiro 写入 `<name>.json`，为 Copilot 写入 `<name>.agent.md`，其余工具写入 `<name>.md`。成员切换角色后，不再活跃的 namespace 中的 agents 会在下一次 pull 时被移除；若本地副本已被手动修改，则保留并给出警告。未配置角色时同步全部 agents。`teamai push` 使用与 pull 相同的活跃角色和项目 namespace 来确定源文件，并将修改写回该源文件；若存在多个候选目标，则跳过并给出警告。若源文件均不活跃，也会跳过。跳过的 agent 不会阻止同一次 push 中的其他资源。新 agent 与新 skill 一样需要确定落点：`--role <ns>` 或 `--project <id>`（该项目的 `agents` namespace）指定目录；两者都不给时，从主角色的 `agents` namespace 解析。只有在解析不出任何 namespace 时才留在共享根目录（此时全员都会收到），并且 push 会给出警告（见[推送本地资源](./member-guide.md#推送本地资源)）。清理会逐个工具检查 YAML 的 `targets` 和旧格式支持；只有活跃的同名 agent 会写入该工具的同一输出文件时，才保留该文件。`teamai remove agents <name>` 会记录 tombstone。带 namespace 的 agent 可写作 `<namespace>/<name>`；只有一个 namespace 拥有的简名会解析到该 agent；若简名出现在多个位置，命令会列出完整名称并拒绝执行，而不是从所有位置删除。其他机器下一次 pull 时，会从每个同步中的工具的 agents 目录删除 `<name>.agent.md`、`<name>.md`、`<name>.toml` 和 `<name>.json`。即使该次 pull 发现团队仓库没有变化，也会执行清理。删除带 namespace 的 agent 只记录 `<namespace>/<name>` 的 tombstone，其他 namespace 中的同名 agent 不受影响；当该副本可能属于这个 agent（该 namespace 对成员活跃，或由其本机放置）且成员的目录没有从另一个活跃 namespace 收到同名 agent 时，其拍平后的 `<name>` 副本会被清理，也不会再被推送。从未启用该 namespace 的成员会保留自己的同名 agent。CLI 内置的 `teamai-recall` 配置与团队 agents 并列部署，但不会被 `teamai push` 上传。

YAML agent 可以在 `tool_extras.<tool>` 下携带工具专属字段，每个工具只接收自己的键：`tool_extras.claude` 只到达 Claude，`tool_extras.qoder` 到达 Qoder，Qoder CN、ZCode 和 OMP 分别读取 `tool_extras.qoder-cn`、`tool_extras.zcode` 和 `tool_extras.omp`。tclaude 和 tcodex 还会收到 `tool_extras.claude` 和 `tool_extras.codex` 中、`tool_extras.tclaude` 和 `tool_extras.tcodex` 未设置的字段。`teamai push` 把修改写回该工具读取的键；对 tclaude 和 tcodex 只写入与基础工具不同的值，若修改删除了继承来的字段，则跳过并说明原因，因为只有基础工具的键才能删除它。

#### 模型别名

YAML agent 可以写一类模型而不是具体模型：`model: strong`、`model: fast`，或团队自定义的别名。团队在可选的 `models/aliases.yaml` 中按工具映射每个别名，使用该工具自己的模型值，并可附带推理强度（effort）：

```yaml
# models/aliases.yaml
aliases:
  strong:
    claude: [{ model: opus, effort: high }, { model: fable }]
    codex:  { model: gpt-6-sol, effort: high }
    opencode: anthropic/claude-opus-5-5
    cursor: "claude-opus-5[effort=high]"
  fast:
    claude: haiku
    codex:  { model: gpt-6-luna, effort: low }
  reviewer:
    claude: [{ model: opus, effort: max }]
```

- `strong` 和 `fast` 始终是别名，TeamAI 不为它们内置任何模型。团队可以添加自己的名称：以小写字母开头，后跟小写字母、数字或连字符。其他任何 `model`（如 `opus`）按原样写入。
- 每个工具的条目是一个选项或有序列表；目前只使用第一个。选项是模型字符串或 `{ model, effort }`。
- 每个工具在自己的模型字段接收模型、在自己的推理强度字段接收推理强度，不会收到其他工具的键：

  | 工具 | 模型 | 推理强度字段 |
  |---|---|---|
  | Claude、claude-internal、tclaude | 按原样写入 | `effort` |
  | Codex、codex-internal、tcodex | 按原样写入 | `model_reasoning_effort`，仅在映射设置了它时写入 |
  | OpenCode | 按原样写入（`provider/model`） | `variant` |
  | CodeBuddy、Qoder、Qoder CN | 按原样写入 | `effort` |
  | Cursor | 按原样写入，包括方括号形式 `claude-opus-5[effort=high]` | 无；把推理强度写在方括号中 |
  | Copilot | 第一个条目，作为单个模型字符串 | 无 |
  | Kiro、WorkBuddy、JoyCode、ZCode、OMP | 按原样写入 | 无 |

- 为没有推理强度字段的工具映射的 `effort` 会被丢弃：该工具只收到模型；pull 把使用该别名的 agent 交付给该工具时会警告一次，并指明别名和工具。
- claude-internal 和 tclaude 使用 `claude` 条目，codex-internal 和 tcodex 使用 `codex` 条目，Qoder CN 使用 `qoder` 条目，除非该别名有它们自己的键。其他工具不继承任何条目：Qoder、ZCode、OMP 和 JoyCode 永远不会收到 `claude` 的模型。
- 别名未映射的工具不会得到 `model` 字段，因此使用其默认模型运行该 agent。没有 `models/aliases.yaml` 时，`strong` 和 `fast` 在所有工具中都不产生 model 字段。
- `tool_extras.<tool>.model` 把该工具固定到具体模型并跳过别名，包括别名的推理强度。`tool_extras.<tool>` 中只有推理强度字段而没有 model 时，只覆盖别名的推理强度，且已切换到模型配置档的工具不会收到它。
- 读取 agent 时会拒绝非字符串的 `model`。旧格式 `agents/<name>.md` 按原样复制，因此当其 `model` 是别名时 pull 会给出警告。
- 结构性错误会让整个文件失效：无法解析的 YAML、类型错误的值、不符合命名规则的别名、有 `effort` 却没有 `model` 的选项、`~`，或有顶层键却没有 `aliases:`（例如拼错的 `alias:`；空文件、只有注释的文件和空的 `aliases:` 不定义任何别名）。修复之前，pull 会警告并指明该文件，并在每个没有 `tool_extras.<tool>.model` 的工具中暂停所有带 `model` 字段的 agent（无法读取的文件可能定义任何名称）：已部署的副本保留，不写入新副本，pull 为它们记录的模型也保持不变。push 会跳过这些 agent 并说明原因，其他内容照常 push。文件修复后，普通的 `teamai pull` 就会交付被暂停的 agent，包括从未部署过的，以及其间团队对它们的修改：暂停了 agent 的 pull（团队仓库未变化时也一样）不会把团队版本记为已同步，因此下一次 pull 会完整同步。`teamai pull --dry-run` 会列出它将暂停的 agent。
- 其他当前 CLI 不认识的内容会被丢弃并给出警告，文件其余部分照常生效：不是 teamai 已知工具的工具键；`model` 和 `effort` 之外的选项字段（该条目去掉该字段后照常使用）；以及与工具自带模型别名同名的别名（`opus`、`sonnet`、`haiku`、`fable`、`inherit`、`default`、`auto`、`lite`，这是一个尽力而为的简短列表），该别名会被忽略，因此 `model: opus` 仍是 `opus`。别名中的 `gateways` 键保留给后续版本，会被忽略且不给出警告。pull 对每条警告只打印一次，并且只在交付使用该别名的 agent 时打印；关于某个工具条目的警告，只在该工具读取该条目时打印。
- pull 会记录每个 agent 副本收到的模型和推理强度，因此即使团队仓库没有变化，普通的 `teamai pull` 也会应用变化，例如从把 `model: strong` 按原样写入的旧版 CLI 升级后的第一次 pull。它只重写模型发生变化的 agent、缺失的副本，以及旧版 CLI 渲染方式不同、而你之后没有改过的副本。你修改过的副本会被保留，每次这样的 pull 都会指出它，并说明如何换用新模型。agent 使用的别名被删除时，pull 会警告其 `model` 现在按原样写入，该别名原本没有给该工具写 model 字段时也会警告。
- `models/aliases.yaml` 中的 `default` 和其他模型值一样按原样写入，它是 CodeBuddy 表示其默认模型的原生值。在该文件中写 `~` 是错误：要让某个工具不产生 model 字段，不写该工具即可。

##### 引入别名

只有支持模型别名的 CLI 才会解析别名，因此团队分两步引入：

1. 所有人先把 teamai 升级到支持模型别名的版本。此时什么都不会变：`model` 为具体模型或未设置的 agent 照旧写入。
2. 之后团队再添加 `models/aliases.yaml`，并把 agent 改为 `model: strong`、`model: fast` 或团队自己的别名，可以直接在团队仓库中修改，也可以在已部署的副本中写入别名名称后 push。

旧版 CLI 会忽略 `models/aliases.yaml`，把 `model: strong` 按原样写入每个工具，而没有工具认识这个模型。旧版 CLI 的 `teamai push` 还会把已部署副本中改动的模型当作编辑，因此可能把团队 agent 中的 `model: strong` 替换成 `opus` 这样的具体模型。TeamAI 不检查版本，所以先升级是唯一的保护。成员升级后的第一次普通 `teamai pull` 会把按原样写入的 `model: strong` 替换为别名解析出的值。

##### 按 namespace 的别名

角色或项目可以在 `models/<ns>/aliases.yaml` 中为别名赋予自己的含义，格式相同；与 `models/<ns>/models.yaml` 一样，只有 `<ns>` 在你的角色或项目的 `resources.models` 中生效时才读取。旧模式（未配置角色和项目）只读取 `models/aliases.yaml`。

- namespace 中的别名整体替换根文件中的同名别名：它未映射的工具不会得到 `model` 字段，即使 `models/aliases.yaml` 映射了该工具。
- 两个生效 namespace 定义同一个别名时，与结构性错误一样暂停带 `model` 字段的 agent，pull 会指出这两个文件。在其中一个文件里重命名或删除它，或不再声明其中一个 namespace。
- 团队仓库中任一别名文件（根文件或 namespace 文件，无论对你是否生效）定义的名称都是别名。只由未生效 namespace 定义别名的 agent 不会得到 `model` 字段，而不是按原样写入名称；你对该名称的本地条目仍然生效。pull 交付使用这种别名的 agent 时，每个别名警告一次并指出这些文件：如果该别名应当对你生效，请启用该 namespace；如果这个名称原本指的是具体模型（例如 `gpt-5-codex`），请重命名该别名。
- 同理，团队仓库中任一别名文件出现结构性错误（包括对你未生效的 namespace 中的文件）都会暂停带 `model` 字段的 agent，pull 会指出该文件。
- pull 的警告和 push 的偏差提示会指出条目所在的文件，例如 `models/checkout/aliases.yaml`。当你收到的 agent 使用的别名也由对你未生效的 namespace 定义时，`teamai doctor` 会给出提示。

##### 本地覆盖

成员可以在自己机器上的 `~/.teamai/models/aliases.yaml` 中替换团队条目，格式同样是 `aliases:`：

```yaml
# ~/.teamai/models/aliases.yaml
aliases:
  strong:
    codex: { model: gpt-6-astra, effort: xhigh }
  fast:
    codex: default          # fast 在 Codex 中使用 Codex 自己的默认模型
```

- 每个工具的顺序是：`tool_extras.<tool>.model`，然后是你的条目，然后是团队条目，最后是不写 model 字段。已切换到模型配置档的工具会过滤你的条目或团队条目给出的结果，见下文。你的条目会整体替换该工具的团队条目，包括推理强度，因此即使团队映射了推理强度，`codex: gpt-6-astra` 也不会给 Codex 写推理强度。
- 某个工具写 `~` 或 `default` 时，无论团队如何映射，它都不会得到 model 字段和推理强度。
- 键可以是保留名称（`strong`、`fast`）或团队定义的别名，值可以是任意模型。团队还没有 `models/aliases.yaml` 时，你也可以映射 `strong`。两者都不是的名称不起作用，因为该文件服务于这台机器上的所有团队。
- claude-internal 和 tclaude 使用你的 `claude` 条目，codex-internal 和 tcodex 使用你的 `codex` 条目，Qoder CN 使用你的 `qoder` 条目，除非你为它们单独写了条目。你的 `claude` 条目优先于团队的 `tclaude` 条目。
- 该文件每台机器一份：它适用于所有作用域（user 和每个项目检出），也适用于使用该别名名称的每个团队。
- 修改该文件后，普通的 `teamai pull` 即会应用，即使团队仓库没有变化。
- 除 `~` 外，该文件遵循与团队文件相同的规则，只有一处不同：结构性错误只暂停 `model` 为别名的 agent，因为该文件不能把任何名称变成别名，警告按路径指明该文件。`model` 为具体模型的 agent 照常交付和 push。当前 CLI 不认识的条目会被丢弃并给出警告。

##### 已切换到模型配置档的工具

用 `teamai models switch` 切换过的工具会把请求发往配置档的网关，而网关不认识你账号下的模型。因此，对 `model` 为别名的 agent，pull 只写入切换能够路由的值：

- Claude 保留解析出的 `opus`、`sonnet` 或 `haiku`（来自你的条目或团队条目），因为切换会把这几个系列分别指向网关模型。其他模型会被丢弃。
- Codex、OpenCode、CodeBuddy 和 WorkBuddy 不会得到 `model` 字段。
- 已切换的工具都不会得到推理强度，无论来自别名还是 `tool_extras.<tool>`，除非 `tool_extras.<tool>` 同时固定了模型。

不写 `model` 字段意味着使用工具自身的继承规则，而不是配置档的模型：例如 Codex 会在你的配置设置了 `[agents].default_subagent_model` 时使用它，否则使用启动该 agent 的会话的模型。`tool_extras.<tool>.model`、`opus` 这类具体 `model`，以及你的 `~` 或 `default`，都与未切换时一样写入。Claude 和 Codex 的变体（claude-internal、tclaude、codex-internal、tcodex）从不视为已切换。只有当工具当前的配置路径（`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 等）与切换时记录的一致，且这些配置仍是 TeamAI 写入的内容时，该工具才算已切换，这与 `teamai models restore` 所做的检查相同。TeamAI 无法读取切换记录（`~/.teamai/models/managed.json`）时，pull 会警告并在 `models switch` 支持的五个工具中暂停别名 agent；无法读取某个已切换工具的配置时，只在该工具中暂停。执行 `teamai models switch` 或 `teamai models restore` 后，普通的 `teamai pull` 就会重写受影响的 agent。

##### Push

对 `model` 为别名的 agent，各工具中的 `model` 以及别名写入的推理强度字段归别名所有，而不归副本所有：

- 副本中的模型和推理强度与上次 pull 写入的一致，或与现在 pull 会写入的一致，就视为未修改。因此在 pull `models/aliases.yaml`、你的覆盖文件或切换带来的变化之前先 push，也不会报告任何内容；push 对“保留的副本其部署版本已变化”的警告也会忽略这类变化。
- push 从不把 `model: strong` 替换为具体模型，也从不把别名的推理强度写进 `tool_extras`。你在副本里手动修改的模型或推理强度属于偏差（drift）：push 会指出该副本及该值的来源，不提交这项修改，并说明应在哪里修改：来自你覆盖文件的条目，改你的覆盖文件；团队条目或未映射的工具，改你的覆盖文件或该别名所在的团队别名文件（`models/aliases.yaml` 或 `models/<ns>/aliases.yaml`）；已切换的工具，运行 `teamai models restore --agent <tool>`。`teamai push --dry-run` 同样会报告。你对该 agent 的其他修改（例如 instructions 或其他字段）照常 push。
- 要让 agent 改用另一个别名，在已部署的副本中写入别名名称（例如用 `model: fast` 替换 `opus`，或在原本设置 `model: opus` 的 agent 中写 `model: strong`），然后 push：push 会提议 `model: <alias>`。若某个工具的模型由 `tool_extras.<tool>.model` 固定，该工具的副本不会采用别名；在那里改动的值会作为该固定值的偏移报告。两个副本写了不同的别名时会冲突，与其他任何两个不同的值一样。
- 只存在于某个工具目录中的新 agent 按其中的模型原样 push，不会被反推回别名。

##### 用 doctor 查看

`teamai doctor` 回答“为什么 Codex 用的是这个模型”。对每个 `model` 为别名的 agent，它输出一条说明（note），为该 agent 面向的每个已安装工具列一行：该工具收到的模型和推理强度，方括号里是决定它的步骤。解析结果相同的 agent 和工具合并为一行；`model` 为具体模型或未设置的 agent 不列出，因为它们按 spec 原样写入。

```text
models: how model: strong resolves for agents implementer, planner:
    claude: opus, effort high  [team: models/aliases.yaml]
    codex: gpt-6-astra, effort xhigh  [local: /home/me/.teamai/models/aliases.yaml]
    opencode: tool default  [default: models/aliases.yaml does not map opencode]
```

| 步骤 | 含义 |
|---|---|
| `extras` | `tool_extras.<tool>.model` 固定了模型，跳过别名 |
| `switched` | 该工具已切换到模型配置档：Claude 保留 `opus`、`sonnet` 或 `haiku`，其他工具不写 model 字段，由工具自行选择 |
| `local` | 你在 `~/.teamai/models/aliases.yaml` 中的条目；`tool default (chosen in <path>)` 表示你写了 `~` 或 `default` |
| `team` | 团队条目，来自所列文件 |
| `default` | 不写 model 字段：别名未映射该工具，或没有生效的别名文件定义它 |

- Codex 系工具有模型但没有推理强度时，该行会注明：沿用启动该 agent 的会话的推理强度。
- 上次 pull 部署的内容不同时（例如你修改了覆盖文件但还没 pull），该行会写出已部署的内容；普通的 `teamai pull` 即可更新，`Agents delivered to <tool>` 会把该 agent 列为 `model changed since the last pull`，但检查不会因此失败。
- 别名文件中被本 CLI 丢弃的每个条目也会作为说明列出。
- 任一别名文件（无论是否生效，包括你自己的）存在结构错误、同一别名出现在两个生效的 namespace 中，或已切换工具的设置无法读取而导致 agent 被暂缓时，`Agent model aliases can be resolved` 检查失败，并给出原因、文件和被暂缓的 agent，与 pull 自己的警告一致。

### GitHub Copilot CLI

GitHub Copilot CLI 已支持其官方自定义指令、Rules、Skills、自定义 Agent、Hooks 和 MCP 配置面，以及 TeamAI Docs 和 Env 下发：

- **作用域。** 用户资源位于 `$COPILOT_HOME`（默认 `~/.copilot`）下，项目资源位于 `<project>/.github` 下。TeamAI 在检测以及所有用户级读写中都会遵循 `COPILOT_HOME`。
- **Skills。** `teamai pull` 将用户级 Skills 写入 `$COPILOT_HOME/skills/`，将项目级 Skills 写入 `.github/skills/`；任一作用域中的修改都可像其他 TeamAI Skills 一样被 `teamai push` 检测。
- **自定义指令。** TeamAI 将团队文化和共享指令注入用户级 `$COPILOT_HOME/copilot-instructions.md` 或项目级 `.github/copilot-instructions.md`。TeamAI 标记包围的区块会被幂等替换，标记之外的文字归用户所有。`teamai uninstall` 只移除 TeamAI 管理的区块。
- **Rules。** 团队 Rules 会转换为 `$COPILOT_HOME/instructions/` 或 `.github/instructions/` 下的原生 `*.instructions.md` 文件。TeamAI 从团队 Rule 的 `paths` 派生 Copilot 必需的 `applyTo` frontmatter；没有 `paths` 时使用 `**`。Push 时只有 Markdown 正文回流，团队拥有的 `paths` 元数据保持不变。未知的 Copilot instructions 文件属于用户，不会被上传或删除。Copilot CLI 1.0.89 及更高版本也会读取项目的 `.claude/rules`，因此启用 Claude 时，每条项目 rule 会送达 Copilot 两次；teamai 仍会写入两份副本，对每个也读取其他工具文件的工具都是如此。
- **自定义 Agents。** 团队 Agents 会转换为 `$COPILOT_HOME/agents/` 或 `.github/agents/` 下的官方 `<name>.agent.md` 配置。TeamAI 将兼容的工具名映射为 Copilot 主别名，通过 `tool_extras.copilot` 保留 Copilot 专属 frontmatter，并且只删除与团队 Agent 或内置 recall 配置匹配的文件；用户自建配置保持不变。详见 [GitHub 自定义 Agent 配置](https://docs.github.com/zh/copilot/reference/custom-agents-configuration)。
- **Team Context recall。** 内置 `teamai-recall.agent.md` 只获得 `execute`、`read` 和 `search`。它调用现有的 `teamai recall` 流程，让 Copilot 检索 learnings、codebase 证据和 teamwiki 结果，而不会复制或创建第二套知识库。
- **Docs 和 Env。** 团队 Docs 同步到配置的本地文档目录（默认 `~/.teamai/docs`；project scope 使用项目内对应路径）。团队环境变量同步到该作用域由 TeamAI 管理的 `env.sh`；请从已 source 此文件的 shell 启动 Copilot。TeamAI 不会把环境变量值复制到 Copilot 配置中。
- **Hooks 与隐私遥测。** TeamAI 在 `$COPILOT_HOME/hooks/teamai.json` 或 `.github/hooks/teamai.json` 写入独立的 version-1 Hook 文件，使用 Copilot 与 VS Code 兼容的 PascalCase 事件（`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` 和 `SessionEnd`），从而保留 TeamAI 所需的 snake_case Hook 负载字段，并生成 `bash`、`powershell` 和后备 `command` 字段。会话 ID、Skill 使用、提示次数、生命周期状态和最终 Token 总数会进入本地 Dashboard；Copilot 提示原文、助手输出、Transcript 路径和请求元数据绝不会被保存。若最终 Token 计数不可用，会话仍会被记录，但不包含 Token 数据。对于恢复的会话，TeamAI 在 SessionStart 时保存不含路径的日志字节边界；只有此前的运行标记尚未关闭、且未被上次运行使用时，才会采纳该标记。关闭计数必须关联这个标记或边界之后写入的标记。若标记仅在 SessionStart 之后出现，而 SessionEnd 没有提供方时间戳，则无法确认它属于本次运行；会话仍会被记录，但不包含 Token 数据。文件会被幂等合并，且保留无关条目。TeamAI 从不修改 Copilot 的 `settings.json`。
- **MCP。** `teamai pull` 和 `teamai mcp inject` 使用 Copilot 原生结构，把本地与远程 Server 合并到 `$COPILOT_HOME/mcp-config.json` 或 `.github/mcp.json`。归属信息保存在 Copilot 文件之外，因此重复 pull 保持幂等，`mcp remove` 或卸载只会移除 TeamAI 管理的条目；手写 Server 与 `settings.json` 均保持不变。

团队 Hooks 仍以团队仓库中的 `hooks/hooks.yaml` 为来源：直接编辑该文件，再使用正常的 pull/push 流程。TeamAI 不会从 Copilot 配置文件反向导入任意原生 Hook 条目。

### OpenCode

[OpenCode](https://opencode.ai) 已作为一等工具支持。由于它的配置布局与 Claude 系不同，teamai 对以下几点做了特殊处理：

- **作用域。** OpenCode 的用户配置在 `~/.config/opencode/` 下，项目配置在 `<project>/.opencode/` 下——前缀与其他所有工具都不同。teamai 会按 `--scope` 写入正确的位置，且仅在该作用域确实安装了 OpenCode 时才碰它的文件（绝不会为未使用 OpenCode 的用户创建 `~/.config/opencode/`）。Hooks 是唯一的例外——始终写在用户级，原因见下。
- **Skills** 落在 `.opencode/skills/`（项目）或 `~/.config/opencode/skills/`（用户）。OpenCode 也原生读取 `.claude/skills`，但 teamai 仍会写 OpenCode 路径，好让只用 OpenCode 的用户也能拿到。
- **Subagents** 会被渲染成 OpenCode 自己的 `agents/*.md` 格式：frontmatter 带 `description` + `mode: subagent`（以及 `model` 和 `tool_extras.opencode` 中的字段，如 `temperature`）；agent 名取自文件名。OpenCode **不**读取 `.claude/agents`，因此这份原生副本是必需的。
- **Rules** 会被复制到 `.opencode/rules/`（或 `~/.config/opencode/rules/`），但 OpenCode 不会自动扫描 rules 目录——文件在被引用前是惰性的。因此 teamai 会往 `opencode.json` 的 `instructions` 数组里加入 glob，并在团队最后一条 rule 消失时再把它们移除，且只编辑这一个键、不动你自己的 `instructions` 条目。在项目中是 `.opencode/opencode.json` 里的 `.opencode/rules/**/*.md`，与团队 instructions 条目并列；OpenCode 会从会话的工作目录及其直到 worktree 的每一级父目录对相对条目做 glob，因此在项目任意位置都能加载 namespace 下的 rule。pull 会移除旧版本写入根目录 `opencode.json` 的 `.opencode/rules/*.md`（它加载不到任何 namespace 下的 rule），且不动该文件的其他键。user scope 下是绝对路径 `~/.config/opencode/rules/*.md`，外加 rule 所落入的每个 namespace 目录各一条（`~/.config/opencode/rules/<ns>/*.md`）：OpenCode 从会话的工作目录解析相对条目，对绝对条目只对文件名做 glob，因此 `**` 永远不会匹配。pull 会替换旧版本写入的相对 `rules/*.md`（它加载的是项目的 `rules/`），并在某个团队 namespace 的 rule 不再送达你时移除它的 glob；你为自己的目录添加的 glob 会保留。OpenCode 会忽略 `paths:`：它加载的每条 rule 都对所有文件生效。`uninstall` 会移除这些 glob，并删除除此之外已无其他内容的 `.opencode/opencode.json`。
- **Hooks** 以 OpenCode *plugin* 形式交付，而非配置文件条目——OpenCode 没有 `hooks` 数组，它会**同时**加载 `~/.config/opencode/plugin/` 和 `<project>/.opencode/plugin/` 下的 JS/TS 插件。两个目录都有插件时会被加载两次，每个事件也就派发两次，因此 teamai 只保留一份：写在用户目录的 `teamai-hooks.ts`，覆盖所有项目；早期布局残留的项目级副本会在下次同步时被删除。这与其他工具一致——它们的 `settings.json` hooks 同样放在 HOME，靠传给 `hook-dispatch` 的 `cwd` 做作用域判断。插件订阅 OpenCode 自己的事件，并 shell 到其他所有工具共用的 `teamai hook-dispatch` 入口。事件映射对齐 Claude 内置集合：`session.created` → session-start、`session.idle` → stop、`chat.message` → prompt-submit、`tool.execute.after` → post-tool-use。插件会转发与其他工具一致的 STDIN 负载（`cwd`、`session_id`、`tool_name`、`tool_input`、`prompt`，post-tool-use 时还有工具输出和状态），并把 OpenCode 的小写工具 id（`skill`、`todowrite`）映射回 handler 注册表期望的 PascalCase matcher。OpenCode 无法把 hook 的 stdout 回注到会话，因此 hooks 只为副作用运行（状态上报 / 同步 / 更新）。注意 OpenCode 会 **await** 它的具名 hook（`chat.message`、`tool.execute.after`），所以这两个事件的派发会短暂等待 `teamai` 子进程后 agent 才继续；错误始终被吞掉，hook 永远不会让会话失败。服务端下发的 agent hook（`teamai-agent-<slug>.ts`）同样装在这个用户级 plugin 目录下。upvote **采纳（adoption）**在 OpenCode 上基于 recall 日志运行，不依赖 transcript：插件的 `shell.env` hook 会在 bash 工具的环境中设置 `TEAMAI_AGENT_SESSION_ID`，因此在其中运行的 `teamai recall` 会归入其 hooks 携带的同一会话；`task` 调用会把子代理的子会话关联到父会话，因此子代理 recall 之后父会话打开的文档会被 upvote。可选的 LLM-judge 需要 transcript，而 `session.idle` 不携带，所以它在 OpenCode 上不运行；hook 的 stdout 会被丢弃，因此"本次会话采纳的团队知识"摘要也不会显示。

  内置 hooks 和服务端下发的 hooks 均支持 OpenCode **1.18.23** 和 **V2**（已对照 2.0.23 验证）。每个插件默认导出一个定义：V1 调用 `server`，V2 调用 `setup`。上述命名 hook 与 `shell.env` 对应 V1；V2 将 `session.prompt` 和 `tool.execute.after` 映射为相同分发，将 `shell` / `subagent` 规范为 `bash` / `task`，并使用宿主原生的 `OPENCODE_SESSION_ID` 为 shell 中的 recall 归属会话。生命周期订阅限定在插件的目录内，卸载时取消。升级 TeamAI 后运行 `teamai hooks inject` 或 `teamai pull`，然后重启 OpenCode，替换报 “Plugin must export a default definition” 的旧插件。
- **MCP** server 位于共享 `opencode.json` 的 `mcp` 键下（详见上文 MCP 章节）。

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 通过其公开的 Skills、指令文件和扩展机制接入：

- **作用域。** 项目级 Skills 写入 `.pi/skills/`，用户级 Skills 写入 `~/.pi/agent/skills/`。Pi 不读取 rules 目录，因此 teamai 不为它写 rule 文件：user scope 的团队 rule 是 `~/.pi/agent/AGENTS.md` 中的一个区块，在项目中则由 TeamAI 的 Pi 扩展把项目的团队 rule 加入每次运行的系统提示，二者都不按路径限定作用范围。pull 会删除旧版本留在 `.pi/rules/` 和 `~/.pi/agent/rules/` 中未修改的副本，并点名你改过的副本。
- **指令文件。** Pi 读取项目自己的 `AGENTS.md`（或 `CLAUDE.md`），TeamAI 不修改它。用户范围的团队指令写入 `~/.pi/agent/AGENTS.md`。在项目中，TeamAI 的 Pi 扩展在会话开始时向 `teamai` 获取成员的团队指令和项目的团队 rule，并加入每次运行的系统提示；Pi 每次运行都会重建该提示，因此它们不会累积。
- **Hooks。** TeamAI 只在用户级 `~/.pi/agent/extensions/` 生成一份 `teamai-hooks.ts`，把 `session_start` 映射为 session-start、`before_agent_start` 映射为 prompt-submit、`agent_settled` 映射为 stop；`tool_execution_start` 缓存工具输入，`tool_execution_end` 派发 post-tool-use 时把缓存的输入转发为 `tool_input`，并附上结果文本 `tool_response` 和根据错误标志得出的 `tool_status`。每个事件都携带 Pi 会话 id（`ctx.sessionManager.getSessionId()`），与 Pi 的 bash 工具导出的 `PI_SESSION_ID` 相同，因此在其中运行的 `teamai recall` 会归入其 hooks 携带的同一会话，upvote **采纳（adoption）**在 Pi 上同样生效。Pi 会同时加载用户级与项目级扩展目录，因此 TeamAI 不创建项目副本——第二份副本会导致每个事件被派发两次，这与 OMP 适配器的单副本策略一致。早期版本遗留且带 TeamAI 标记的项目副本会在下次同步时移除，注入逻辑也不会覆盖没有 TeamAI 标记的同名文件。Pi 没有可供 self mode 提交的设置文件，所以 fresh clone 仍需在该机器上手动跑一次 `teamai init`/`pull` 才能激活 Pi hooks。显式执行 `teamai hooks remove` 或用户级 `teamai uninstall --agent pi` 会删除这份共享扩展。项目级卸载为其他项目保留它，并移除旧的项目副本；没有 TeamAI 标记的同名文件不会被删除。`teamai hooks list` 始终显示这个全局路径。Pi 的 profile 覆盖项（`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）在 hooks 中暂不支持，与 OMP 适配器一致，使用默认的 `~/.pi/agent/` 布局。模型配置是另一回事，会读取 `PI_CODING_AGENT_DIR`。项目级卸载后共享扩展仍已安装；指令派发会先检查此项目对该工具的排除设置。
- **团队 Hooks 边界。** Pi 适配器只安装内置生命周期桥接。`hooks/hooks.yaml` 声明的自定义团队 Hooks 和内置 Hook 覆盖会被跳过并给出警告。完整团队 Hooks 与逐项目归属语义需要单独的跨适配器设计，留待后续 PR。
- **服务端下发的 Agent Hooks。** HTTP source hooks 会以同一用户级扩展目录中的 `teamai-agent-<slug>.ts` 形式安装。不支持的生命周期事件会警告并跳过。
- **MCP（Pi 0.99.0+）。** 支持 stdio 和 streamable HTTP；SSE 会跳过。用户级写入 `~/.pi/agent/mcp.json`，项目级写入 `.pi/mcp.json`；项目配置需要 Pi 信任项目后才加载。保留原生 `codemode` 默认值，不强制 direct；`mcp.yaml` 的 timeout 从毫秒转换成秒。受管条目的本地 exposure/启用状态在团队定义不变时保留，团队定义更新时会被替换；doctor 按完整条目比较，会报告这些本地差异。接管 `/mcp` 的扩展可能禁用内置 MCP；使用内置支持需移除此类扩展。
- **Subagents。** 暂不支持 TeamAI 自定义 subagent 文件。

### Qoder

Qoder 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.qoder/skills/`、`.qoder/rules/` 和 `.qoder/agents/`。Hooks 与 MCP Server 会合并进对应作用域的 `.qoder/settings.json`，并保留用户已有的其他设置；这些路径与 Qoder 的用户级和项目级配置约定一致。

Rules 按 Qoder Desktop 写入的形式生成，Qoder CLI 也读取这种形式：带 `paths:` 的规则写成 `trigger: glob` 加一行不带引号、以逗号分隔的 `glob:`，由于该行会按每个逗号切分，`{a,b}` 形式的选择会展开为多个 glob；没有 `paths` 的规则写成 `trigger: always_on`。Qoder 未公开这种 frontmatter 的 schema，该形式取自 `alibaba/tron-one-agent` 中 Desktop 生成的规则文件。`push` 时只有 Markdown 正文回流；`.qoder/rules/` 中没有对应团队规则的文件属于你自己：`pull` 不会删除它，`push` 也不会把它当作新的团队规则提交。旧版 teamai 原样写入的副本，若仍是 teamai 写入的内容，下一次 `pull` 会改写为新格式；你修改过的副本会保留并给出提示。

Qoder CN 是独立发行的版本，其**用户级**目录为 `~/.qoder-cn` 而非 `~/.qoder`，因此它作为独立的内置目标 `qoder-cn` 支持，而不是并入 `qoder`。两者仅用户作用域不同：用户级的资源写入 `~/.qoder-cn/{skills,rules,agents}`，Hooks 与 MCP 写入 `~/.qoder-cn/settings.json`；项目作用域则沿用 Qoder 的 `<project>/.qoder/` 布局。两者读取相同的 Claude 兼容资源格式，因此下发内容一致，仅用户级根目录不同。同时安装两个版本时，TeamAI 会分别同步到各自的用户目录，无需再建软链接。在项目中 Qoder 与 Qoder CN 都读取 `.qoder/rules/`，因此两者共用其中的一份副本：卸载其中一个时，只要另一个仍已安装，副本就会保留；`doctor` 也只检查一次，即 `Rules delivered to qoder, qoder-cn`。

### Kiro

Kiro 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.kiro/skills/`、`.kiro/steering/` 和 `.kiro/agents/`，与 Kiro 官方文档定义的[工作区 Skills](https://kiro.dev/docs/skills/)、[Steering](https://kiro.dev/docs/steering/)和自定义 agents 布局一致。Subagents 渲染为 Kiro CLI 2.x 与 3.x 都支持的 JSON；每个文件都会保留 Kiro 私有字段和自定义 Hooks，并加入 TeamAI 管理的 `hooks.agentSpawn` 命令，在交互式 CLI 会话激活该自定义 agent 时派发 `session-start`。这一经验证的 CLI 2.x Hook 内嵌在 `.kiro/agents/*.json`，而不是写入 IDE 1.x / CLI 3.x 引入的独立 `.kiro/hooks/`；Kiro 内存中的内置默认 agent 无法修改，`--no-interactive` 也不会触发 `agentSpawn`。MCP Server 会合并进对应作用域的 `.kiro/settings/mcp.json`（见上文 MCP 章节）。

Rules 以带 Kiro inclusion frontmatter 的 steering 文件写入 `.kiro/steering/` 与 `~/.kiro/steering/`：带 `paths:` 的规则写成 `inclusion: fileMatch`，并把其 glob 列表写入 `fileMatchPattern`；没有 `paths` 的规则写成 `inclusion: always`。Kiro 只读取 steering 目录的顶层（[kirodotdev/Kiro#10448](https://github.com/kirodotdev/Kiro/issues/10448)），因此与 [Oh My Pi](#oh-my-pi) 一样，namespace 下的规则会平铺写入：`rules/fe/style.md` 写成 `fe.style.md`，`push` 会把对该文件的修改写回 `rules/fe/style.md`。push 要求该平铺副本有下发记录；同名的个人文件既不会在 push 前被刷新，也不会被当作团队规则的修改。若你收到的另一条规则也对应同一个平铺文件名，该规则不会写入；与团队规则平铺文件名相同的你自己的文件永远不会被覆盖或删除。旧版写入的嵌套副本 `<ns>/<name>.md` 会在平铺副本写入后删除；你修改过的副本会保留并给出提示，因为 Kiro 不会读取它。`push` 时只有 Markdown 正文回流；没有对应团队规则的 steering 文件（例如 Kiro 自己生成的 `product.md`）属于你自己：`pull` 不会删除它，`push` 也不会把它当作新的团队规则提交。旧版 teamai 原样写入的副本，若仍是 teamai 写入的内容，下一次 `pull` 会改写为新格式；你修改过的副本会保留并给出提示。Kiro CLI 无论 `inclusion` 取值都会加载全部 steering 文件（[kirodotdev/Kiro#7950](https://github.com/kirodotdev/Kiro/issues/7950)），因此在 CLI 中限定路径的规则也会始终生效。Kiro IDE 曾忽略 `~/.kiro/steering` 中的 `fileMatch`（[kirodotdev/Kiro#9176](https://github.com/kirodotdev/Kiro/issues/9176)，Kiro 0.12）；维护者称此后已修复，该 issue 未经复测即关闭。

### CodeBuddy 与 WorkBuddy

WorkBuddy 运行的是 CodeBuddy 的引擎，因此两者都按 CodeBuddy 的格式得到 rules：带 `paths:` 的规则写成 `alwaysApply: false`，并把 `paths:` 写成 YAML 块列表，每项一个带引号的 glob；没有 `paths` 的规则写成 `alwaysApply: true`。CodeBuddy 的 frontmatter 解析器按行读取而非按 YAML 解析，原样副本中的行内写法 `paths: ["a", "b"]` 会让它得到带方括号的 glob。在项目中两个工具都读取 `.codebuddy/rules/`，因此该目录为两者只保存每条规则的一份副本：排除或卸载其中一个工具时，只要另一个仍已安装，这些副本就会保留；`doctor` 也只检查该目录一次，即 `Rules delivered to codebuddy, workbuddy`。只有存在 `.workbuddy/` 时 WorkBuddy 才视为已安装。在有 `.workbuddy/` 但没有 `.codebuddy/` 的项目中，共用副本会创建 `.codebuddy/`，于是 CodeBuddy 在该项目中也会被视为已安装，并同样得到 skills、agents 和 hooks；如果你不用 CodeBuddy，`teamai uninstall --agent codebuddy` 会移除它们并让它保持排除，共用的 rules 仍为 WorkBuddy 保留。user scope 下 CodeBuddy 读取 `~/.codebuddy/rules/`，WorkBuddy 读取 `~/.workbuddy/rules/`。`push` 时只有 Markdown 正文回流；其中没有对应团队规则的文件属于你自己：`pull` 不会删除它，`push` 也不会把它当作新的团队规则提交。旧版 teamai 原样写入的副本，若仍是 teamai 写入的内容，下一次 `pull` 会改写为新格式；你修改过的副本会保留并给出提示。

> 升级说明：旧版本把 WorkBuddy 的项目 rules 写到 `.workbuddy/rules/`，而 WorkBuddy 从不读取该目录。下一次 `pull` 会删除其中仍是 teamai 投递内容的副本（目录清空后一并删除），并把 rules 写到 `.codebuddy/rules/`，即使团队仓库没有变化也是如此；你改过的副本会保留并点名。WorkBuddy 的一次性迁移把 `~/.codebuddy/rules/` 复制到了 `~/.workbuddy/rules/`（会留下 `~/.workbuddy/.migrated-from-codebuddy`），其中也包括团队规则的副本。复制过来的团队规则若仍是 teamai 投递的内容（该规则的某种渲染结果，或 teamai 记录的在 `~/.codebuddy/rules/` 下同名文件写入的字节），在 WorkBuddy 仍得到该规则时会改写为 CodeBuddy 格式，否则删除；改过的副本会保留并点名，你自己的规则保持不变。

### ZCode

ZCode 已作为内置目标支持。Skills 下发到 `.zcode/skills/`（ZCode 同时会读取中央目录 `~/.agents/skills/`，该目录由 `agents` 条目覆盖），Subagents 以 Claude 风格 Markdown 下发到 `.zcode/agents/`。Hooks 会合并进共享的 `~/.zcode/cli/config.json`，并保留插件状态等无关键值。写入器为你处理了两个 ZCode 特有的细节：

- ZCode 的配置文件钩子**默认禁用**——TeamAI 会强制置 `hooks.enabled: true`，确保写入的条目真正生效。
- Windows 上，钩子条目通过隐藏的 **wscript VBS 启动器**执行（`wscript.exe <teamai-hook-dispatch.vbs> <分发命令尾段>`）：wscript 属 GUI 子系统，钩子运行绝不弹控制台黑框；启动器把 STDIN 暂存为临时文件再转发，保证 payload 完整到达 `hook-dispatch`。超时按事件放宽（会话启动 180 秒、stop / prompt 提交 60 秒、工具调用后 30 秒），避免会话启动时携带仓库拉取的分发被中途掐断。含多字节文本（如中文）的 payload 在启动器的 ANSI 代码页暂存环节可能降级——身份字段会被抢救，降级分发仍能正确关联到会话；卸载时会同时清除条目与脚本文件。
- POSIX 上条目就是普通的 `bash -lc <分发命令尾段>` argv 向量，不写入启动器；两个平台上，命令尾段都以 argv 末位元素原样存储——这正是托管条目识别与托管清单比对的依据。

以上路径已对照 ZCode 桌面端实测验证：设置页「新建子智能体」写入的就是 `~/.zcode/agents/*.md`，反向放入的文件也会出现在页面的已安装列表中。MCP Server 下发到 `~/.agents/mcp.json`（用户级，Claude 的 `mcpServers` 结构——正是 ZCode 自己的 MCP 设置页读取的文件）。项目级暂未接入：ZCode 的工作区 MCP 使用不同的键（`.zcode/config.json` 内的 `mcp.servers`），Claude 写入器无法生成该结构。ZCode 不读取 rules 目录：user scope 下团队 rule 是 `~/.zcode/AGENTS.md` 中的一个区块，ZCode 把它作为用户上下文读取，不按路径限定作用范围。在项目中，teamai 写在 `~/.zcode/cli/config.json` 中的 `SessionStart` hook 会把项目的团队 rule 加入每个新会话（ZCode 不运行项目级 hook）。ZCode 压缩会话时会丢弃这段文本，rule 要到下一个会话才回来。

### Oh My Pi

Oh My Pi（OMP）已作为内置目标支持。TeamAI 将 Skills、Rules 和 Subagents 下发到 OMP 的原生目录——项目级为 `.omp/skills/`、`.omp/rules/` 和 `.omp/agents/`，用户级为 `~/.omp/agent/skills/`、`~/.omp/agent/rules/` 和 `~/.omp/agent/agents/`（用户级资源位于 agent 目录 `~/.omp/agent/` 下，与项目级前缀不同，TeamAI 会随作用域自动切换）。团队指令在用户范围写入 `~/.omp/agent/RULES.md`，在项目范围由下文的 extension 加入每轮的系统提示（见[这些块写到哪里](./team-culture.md#这些块写到哪里)）；MCP Server 合并进 `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json`（Claude `mcpServers` 结构，见上文 MCP 章节）。Skills 采用一层 `<name>/SKILL.md` 目录结构，TeamAI 在同步时补全 `description`——OMP 原生 skill 发现要求该字段。以上路径遵循 OMP 官方文档的发现布局（对照 OMP 18.2.5 验证）。Hooks 走 OMP 的 extension runner：`teamai pull` 会生成唯一的 extension 写入 `~/.omp/agent/extensions/teamai-hooks.ts`（绝不写项目副本——OMP 会同时加载两个根并导致每个事件双派发），它把 OMP 的 `session_start` / `session_stop` / `before_agent_start` / `tool_result` 事件转发给所有 agent 共用的 `teamai hook-dispatch` 入口，并按会话 `cwd` 做项目门控。在项目会话中，它还会在 `session_start` 时获取成员的团队指令，并在 `before_agent_start` 中追加到系统提示。每个事件都携带 OMP 会话 id（`ctx.sessionManager.getSessionId()`；subagent 有自己的会话），`tool_result` 还带上工具的文本输出和根据 `isError` 得出的状态，因此 upvote **采纳（adoption）**在 OMP 主 agent 上生效：OMP 不在其 shell 中设置会话变量，所以 recall 归入运行它的那次 `bash` 调用所在的会话；带行选择器的 `read`（`x.md:50-200`、`x.md:raw`）计为对该文件的读取。从 OMP 18.3.2 起，subagent 的事件还会携带其 `ctx.agent` 的 id 和名称，因此 `teamai-recall` subagent 自身的读取从不计入。subagent 的会话文件位于父会话文件之下，父会话文件的头部写明父会话 id，因此 extension 会在 subagent 的工具调用中关联这两个会话，主 agent 在 subagent recall 之后打开的文档会被 upvote（对照 OMP 18.4.8 验证）。`session_stop` 处理器不返回任何值，分发绝不会强制会话继续；由于 OMP 的工具名是小写（`bash`、`read` 等）且没有 `Skill` / `TodoWrite` 工具，post-tool-use 不做 matcher 定向分发。用户级 `teamai uninstall` 会移除该 extension；项目级卸载为其他项目保留它。与 Pi 一样，不带 TeamAI 标记的同名文件绝不会被覆盖或删除。OMP 的 profile（`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）暂不支持，使用默认的 `~/.omp/agent/` 布局。

Rules 以 OMP 自己的 frontmatter 写入 `.omp/rules/` 与 `~/.omp/agent/rules/`：没有 `paths:` 的规则写成 `alwaysApply: true`，其正文进入每次的提示；带 `paths:` 的规则写成 `globs`（即其 glob 列表）加一个 `description`（正文的第一个 Markdown 标题，没有标题时为 `Team rule for files matching <globs>`），OMP 会在提示的 rulebook 中以 `name (globs): description` 列出它，并在工作匹配时读取。两者都没有的规则会被 OMP 丢弃，teamai 以前原样复制的每条规则正是如此。OMP 只读取 rules 目录的顶层，因此 namespace 下的规则会平铺写入：`rules/fe/style.md` 写成 `fe.style.md`，`push` 会把对该文件的修改写回 `rules/fe/style.md`。push 要求该平铺副本有下发记录；同名的个人文件既不会在 push 前被刷新，也不会被当作团队规则的修改。若你收到的另一条规则也对应同一个平铺文件名，该规则不会写入：根目录规则（例如 `rules/fe.style.md`）保留该文件，两条 namespace 规则则都不写入；`pull` 会指出这些规则，`doctor` 会报告失败。与团队规则平铺文件名相同的你自己的文件不会被覆盖或删除：只有与下发记录中的内容一致，或与渲染结果完全一致，才能证明它是 teamai 写入的。下发后你修改过的平铺副本，`remove` 和 `uninstall` 会保留并点名。`push` 时只有 Markdown 正文回流；OMP rules 目录中没有对应团队规则的文件属于你自己：`pull` 不会删除它，`push` 也不会把它当作新的团队规则提交。旧版 teamai 原样写入的副本，若仍是 teamai 写入的内容，下一次 `pull` 会改写为新格式；旧的嵌套副本 `<ns>/<name>.md` 在平铺副本写入后删除，无论是否有下发记录（记录，或与团队规则原文一致，即可证明未被修改）；你修改过的副本会保留并给出提示，因为 OMP 不会读取它：如需保留修改，请把它复制到平铺文件中。OMP 只在会话启动的目录读取 `.omp/rules/`，因此项目规则只到达从项目根目录启动的会话，从子目录启动的会话收不到。OMP 还会把项目中的 Cursor rules（`.cursor/rules/*.mdc`，仅顶层）和 Copilot instructions（`.github/instructions/**/*.instructions.md`）当作 rule 加载，并按名称每条只保留一份，优先使用它自己的 `.omp/rules` 副本（据 OMP 18.2.1 的加载器核实）。因此启用 Cursor 或 Copilot 时，根目录团队规则只送达 OMP 一次；但启用 Copilot 时，namespace 下的规则会送达两次：一次是 `.omp/rules` 中的 `fe.style`，一次是 `.github/instructions/fe/` 中的 `style`。只有你启用该来源时，OMP 才会读取 `~/.cursor/rules`。

### DeepSeek Harness

DeepSeek Harness（`dsh`）支持 TeamAI Skills 和共享资源。DSH 官方的 Claude Hook Bridge 是通过 profile 插件加载的，并不是设置文件中的 Hooks；因此当 dsh 的主目录（`$DSH_HOME`，未设置时为 `~/.dsh/`）存在时，`teamai init`、`teamai pull` 或 `teamai hooks inject` 会在 `~/.teamai/dsh/` 下生成兼容 Claude 的 Hook 配置和 Cordis patch。

dsh 不读取 rules 目录。user scope 下团队 rule 是 `$DSH_HOME/AGENTS.md`（未设置 `DSH_HOME` 时为 `~/.dsh/AGENTS.md`）中的一个区块，dsh 会把它放进第一次请求，不按路径限定作用范围。与 Hook 一样，只有该主目录存在时 teamai 才写入它。Skills 仍写入 `~/.dsh/skills/`，且只在 `~/.dsh/` 存在时写入，与 `DSH_HOME` 无关。在项目中，dsh 带上下面的 patch 运行后，teamai 的 session-start hook 会加入项目的团队 rule。dsh 以分离方式运行该 hook，第一次请求可能错过它们，压缩会话时也会丢弃它们。

TeamAI 会打印带绝对路径的 patch。将这个 `--patch` 参数加到启动 DSH profile 的命令中，例如 `dsh tui --patch "<打印出的路径>"`。这是一次性的启动器选择；`teamai hooks remove` 和 `teamai uninstall` 会移除 TeamAI patch，同时保留生成配置中的其他 Hook 条目。

### JoyCode

JoyCode 已作为内置目标支持。Skills、Rules 和 Subagents 分别下发到 `.joycode/skills/`、`.joycode/rules/` 和 `.joycode/agents/`。Subagents 使用带 YAML frontmatter 的 Markdown 文件。

Rules 是采用 JoyCode 自有渲染的 `.mdc` 文件。JoyCode 逐行读取 frontmatter，而不是按 YAML 解析：它会保留 Cursor 渲染给 `globs` 加的引号，并按每个逗号拆分取值，因此 Cursor 形式的带 `paths:` 的 rule 从未生效。带 `paths:` 的 rule 写成不加引号、逗号分隔的 `globs:`，每个 `{a,b}` 选择项都展开为单独的 glob，并加上 `alwaysApply: false`；不带 `paths` 的 rule 写成 `alwaysApply: true`。`push` 时只有 Markdown 正文回流，与 Cursor 相同。旧版 teamai 以 Cursor 形式写入的副本，若仍是 teamai 所下发的内容，会在下一次 `pull` 时重写；你改过的副本会保留并被点名；只要其 `globs` 仍带引号，`pull` 会指出它不作用于任何文件，并说明如何修正。`doctor` 将项目 `.joycode/rules/` 中的每份副本与该渲染比对。

user scope 下 JoyCode 不读取 rules 目录：团队 rule 是 `~/.joycode/rules.txt` 中的一个区块，不按路径限定作用范围。pull 会删除旧版本留在 `~/.joycode/rules/` 中未修改的 `.mdc` 副本，并点名你改过的副本。

JoyCode 规则清理采用保守策略：不在团队规则列表中的本地 `.mdc` 和 `.md` 文件会被保留，只有团队明确记录了删除标记（tombstone）才会清理。这能保护同一目录中的个人规则；缺少删除记录的旧团队副本也会保留，不会猜测其已过期。

对于以 YAML 保存的团队 Agent，push 会将本地文件与对应工具的渲染结果比较，只将真实编辑合并回原始配置。部署范围 `targets`、其他工具的元数据，以及本地格式未输出的字段都会保留。遇到冲突或无法解析的编辑时跳过回写，不会替换团队源文件。

**Hooks 与手动同步**：JoyCode 当前没有提供生命周期 Hooks 机制或专用启动适配器（无类似 `settings.json` hooks 数组或 `hooks.json` 的事件配置）。因此，打开或启动 JoyCode 不会触发 TeamAI 的 `SessionStart` 事件，无法进行后台自动拉取、使用指标上报或自动更新检测。JoyCode 用户需要通过在终端手动运行 `teamai pull` 来同步团队最新技能、规则与 Agent，通过 `teamai push` 贡献变更。若 JoyCode 后续版本提供了 Hooks 或插件生命周期机制，将通过专用适配器接入。

### Cursor

Cursor 的子代理部署到 `.cursor/agents/*.md`，YAML frontmatter 携带 `agent_id`（团队代理名）、`description`、`tools`，以及团队代理声明了的 `model`，外加所有 `tool_extras.cursor` 字段；`reverseFromCursor` 按同样字段读回，因此 `pull` → `push` 往返不会丢 model。

Cursor 的项目规则必须以 **`.mdc`** 文件形式放在 `.cursor/rules/` 下，且带 YAML frontmatter——放在那里的纯 `.md` 会被 Cursor 直接忽略。因此 teamai 向 Cursor 写规则时用 `<name>.mdc`（JoyCode、Copilot、Kiro、Qoder、Qoder CN、CodeBuddy、WorkBuddy 与 Oh My Pi 各有自己的格式，见各自小节；其他工具写纯 `.md`），并从团队规则派生 frontmatter：

- 带 `paths:` 列表的规则会转成 `globs: "<逗号拼接>"` + `alwaysApply: false`（上下文中有匹配文件时 Cursor 自动附加该规则）。值加引号是因为以 `*` 开头的 glob 不加引号时并非合法 YAML。
- 无 `paths` 的规则（团队强制规则）会转成 `alwaysApply: true`（每个 Cursor 会话都应用）。

两种格式之间只有 markdown 正文互通，各自的 frontmatter 归各自所有。`pull` 时 Cursor 的 frontmatter 由机器派生（正文原样拷贝，仅规范化首尾空行），因此 `pull` → `push` 往返不会被误判为内容变更。`push` 时，在 `.cursor/rules/*.mdc` 里改完正文再执行 `teamai push`，**只有正文**会回流上游——团队规则自己的 `paths:` frontmatter 会被保留，规则的作用域不会被悄悄丢掉。

有两类文件刻意**不会**从 Cursor 规则目录推送：

- 团队仓库中没有同名规则的 `.mdc`。`.cursor/rules/` 同时也是 Cursor 自带的 *New Cursor Rule* 命令写入个人规则的地方，teamai 不会把它们当作新的团队资源。
- CLI 内置规则——它们是被下发的（对 Cursor 同样写成 `.mdc`），而非同步而来。

从旧版本升级：旧布局写入的 `.cursor/rules/*.md` 是无效文件（Cursor 从未读取过它们），因此 `pull`、`remove`、`uninstall` 会连同 `.mdc` 一起删除。你自己放在那里的 `.md` 不受影响。

### 其他

```bash
teamai doctor          # 配置诊断
teamai doctor --json   # 同样的诊断结果，以 JSON 输出到 stdout（CI、hook、agent 可直接消费）
teamai stats           # skill 使用统计
teamai update --check  # 仅检查 CLI 更新，不安装
teamai update          # 检查并安装 CLI 更新
teamai digest          # 生成团队活动周报
teamai remove skills <name>   # 删除资源（需要确认）
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # 跳过确认，用于脚本和 CI
```

`teamai stats` 显示当前 scope 的 skill 使用情况与会话统计；当该 scope 的 recall 日志中有 run 时，还会显示一个 recall 小节（见 [Recall 采纳与 upvote](./knowledge.md#recall-采纳与-upvote)）。普通的 `teamai stats` 在内存中解析旧版角色，不保存 config，也不打印 dry-run 迁移提示。`teamai stats --dry-run` 保留迁移预览提示且不写入任何内容：它按现状读取 reports checkout，不刷新也不创建，并会说明这一点。当 session owners 文件缺失时，预览在内存中使用同一份推断的归属与已上报额度，包括旧版本拆分到多个 scope 的会话。

仅当所有检查通过时，`teamai doctor` 才以状态码 0 退出；任一检查失败时以状态码 1 退出。尚未初始化时，它只报告缺少配置，不会臆测 Git 托管平台。手动执行 `teamai pull` 结束时会运行同一批检查（不含托管平台相关的检查，也不含本次 pull 已经自行报告过的检查）。被标记为 informational 的检查——目前只有 `No stale env blocks left behind`——仍会计入 `doctor` 的退出码，但 pull 不会把它的失败并入 `Pull finished, but N check(s) failed`：早期安装留下的遗留文件属于清理事项，不代表这次 pull 弄坏了什么，因此依旧会被点名，只是单独用一行更轻的提示呈现。

除了托管平台、clone、配置和 hook 检查之外，`doctor` 还会验证落到本机上的内容。`<tool> is installed` 在 `enabledAgents` 列出了不会收到任何内容的工具时失败——这正是 pull 报告成功、而该工具什么都没收到的情况。它使用与同步相同的解析逻辑，因此像 OpenClaw 这样把 skills 放在 workspace 目录而非工具根目录的工具，会在同步真正写入的位置被判断。工具已安装时也会作为通过项报告，因此 `--json` 无论哪种情况都会为每个已启用工具给出一条记录。pull 结束时的检查只覆盖它从当前目录解析出的那个 scope；其他 scope 请在对应目录下运行 `teamai doctor`。`Skills delivered to <tool>` 会把角色命名空间、标签订阅与排除规则解析出的 skill 集合，与每个已安装工具磁盘上的内容比对：从未送达的 skill 与送达但不可读的 skill 会分别报告——后者指 `SKILL.md` 缺失、frontmatter 无法解析，或其 `name` 与目录名不一致，导致 agent 永远发现不了它。`Team docs delivered` 将你应收到的文档（不含未激活的 docs namespace）与 `sharing.docs.localDir` 比对（它只有一个目标目录，而非每个工具一个）；每个应有的文档都必须是可读取的文件，因此占用了该名字的目录或断链接也算缺失。它还会将本地多余的非隐藏文件报告为过期文档，即使团队文档已经删空也会检查；本地隐藏文件会保留，不会使检查失败，未激活 namespace 中团队文档的本地副本也不会：pull 会删除未修改的副本，并点名你修改过的副本。`doctor` 还会输出提示，它们只是信息，不是失败的检查。每条提示指出一个在本机替换了根目录条目的 namespace skill、agent、rule、共享指令文件、env 变量、hook、MCP server 或团队模型配置（`rules: "style" from rules/checkout/style.md replaces rules/style.md`）。当某个 namespace 提供了 env 变量、hook、MCP server 或团队模型配置时，还会有一条提示按来源统计该类型的条目（`env: 3 received here (2 root, 1 checkout)`）。未配置角色或项目时，提示改为列出团队仓库中重复定义的每个文件，以及在根文件中重复出现的每个 env 变量、hook 或 MCP server 名称。

对于 Oh My Pi 和 Kiro，即使所有收到的 rule 都发生平铺名称冲突、无法写入任何文件，`doctor` 也会报告冲突。在团队仓库中重命名其中一条 rule，然后运行 `teamai pull`。

`Rules delivered to <tool>` 与 `Agents delivered to <tool>` 对另外两类按工具下发的资源做同样的事，并且都向 handler 询问落点，而不是自行拼路径：rule 的文件名和内容因工具而异（`.md` 原样、`.mdc` 带派生的 `globs`/`alwaysApply`（JoyCode 的不加引号）、`.instructions.md` 带 `applyTo`、Kiro 平铺的 `.md` 带 `inclusion`/`fileMatchPattern`、Qoder 的 `.md` 带 `trigger`/`glob`、Oh My Pi 平铺的 `.md` 带 `alwaysApply` 或 `globs`/`description`、CodeBuddy 的 `.md` 带 `alwaysApply`/`paths`；共用一份副本的工具，例如项目中的 CodeBuddy 与 WorkBuddy，只有一项同时点名两者的检查），agent 的落点来自渲染结果，且由 `targets:` 决定哪些工具应当收到。已送达的 rule 会与 handler 为该工具渲染出的字节逐一比对，而不只是检查该工具所需的键是否存在：`globs` 与团队 rule 的 `paths:` 不再一致的 `.mdc`，即使 `alwaysApply` 取值合法，也会作用到错误的文件上；这里会报告为 `delivered from an older copy`——正文漂移的副本同样如此，因为两者都写入成功，却都是错的。agent 会与渲染结果逐字节比对：旧版 spec 留下的副本（普通 pull 会跳过团队仓库未变化的 scope，它可能一直留在那里）报告为 `delivered from an older spec`，而不是当作已送达。`Every team agent reaches a tool` 会指出在任何已安装工具上都无法渲染的 agent，通常是 spec 解析失败，或 `targets:` 只列了本机没有的工具。这两项仅在 `doctor` 中运行：它们会按工具读取每条 rule、解析每个 agent，放进 pull 结束时的检查会耗尽其时间预算。

删除最后一条团队 rule 后，`doctor` 仍会报告清理失败留下的 teamai 所拥有的 OpenCode glob 或内联区块。运行 `teamai pull` 可移除它们。

有几个工具并不读取 rules 目录，按文件比对的检查无法代表它们，因此各自单列一项。`Team rules are active in opencode` 检查 `opencode.json`（项目中为 `.opencode/opencode.json`）的 `instructions` 中是否列着 teamai 所拥有的每条 glob，且没有过时的条目（如旧版本写入的相对 `rules/*.md`）：OpenCode 不会自动扫描 `.opencode/rules`，缺了它，已送达的每个 `.md` 都不会生效，而按文件比对的检查依旧通过。user scope 下，`Team rules are inlined in Hermes SOUL.md` 把 `SOUL.md` 中 teamai 管理的代码块与团队 rule 内联后的内容比对——Hermes 的常驻指令来自这一个文件而非某个目录，因此代码块被删除或停留在旧版规则集上，都意味着该工具读到的是错误的规则，而磁盘上看不出任何异常。user scope 下，`Team rules are inlined in <file>`（`Codex AGENTS.md`、`ZCode AGENTS.md`、`DeepSeek Harness AGENTS.md`、`OpenClaw workspace AGENTS.md`、`Pi AGENTS.md`、`JoyCode rules.txt`）把该工具所读文件中的 team-rules 区块与团队 rule 内联后的内容比对；对 Codex，旁边有 `AGENTS.override.md` 遮蔽该文件时也会失败。在项目中，当该工具 `hooks.json` 中的 teamai `SessionStart` 或 `SubagentStart` 条目缺失或没有设置 `additionalContextLimit: 0` 时，`Project rules and instructions reach <tool> whole through its session hooks` 会失败：没有它，Codex 对较大的内容只保留开头和结尾。在项目中，当 `~/.zcode/cli/config.json` 没有 teamai 的 `SessionStart` 条目或没有设置 `hooks.enabled: true` 时，`Project rules reach zcode through its SessionStart hook` 会失败；当 `~/.teamai/dsh/` 下的 patch 或 hook 配置缺失时，`Project rules reach dsh through its session-start hook` 会失败，doctor 无法看到 dsh 是否带 `--patch` 运行。对 Pi，teamai 的 Pi 扩展缺失或过期时，`pi adds the team instructions and rules to its prompt` 会失败。Codex、ZCode、DeepSeek Harness 和 Pi 没有 `Rules delivered to <tool>` 检查。

`MCP servers delivered to <tool>` 将团队 `mcp.yaml` 为该工具解析出的每个 server 与该工具自己配置文件中的条目逐一比对，并列出 reconcile 跳过的 server 及原因。比对的是条目内容而非名字：reconcile 不会覆盖不属于 teamai 的条目，因此你自己写的同名 server 会占住这个名字，团队的定义从未真正送达；过期的旧副本同样等于没送达。两者都报告为 `not the team's definition`，而覆盖非 teamai 写入的条目只有 `teamai pull --force` 能做到。未解析的 `${VAR}` 会在这里连同变量名一起报告——否则它只在 pull 时出现一次，之后再无提示。没有值的已声明密钥不算失败：doctor 把它作为备注打印（`--json` 中的 `notes`），并附上设置它的命令，退出码与没有它时相同；备注还会说明为它保留的条目可能含有旧值，以及某个 key 既声明为密钥、又在 `env.yaml` 中设置的情况。无法解析的 `mcp.yaml` 并不等于团队没有 MCP：它会作为 `Team MCP servers can be read` 连同解析错误一起报告，因为这种文件不会向任何工具注入内容，而且除第一次之外的每次运行都对此保持沉默。无法解析的团队 hooks 与团队模型配置（文件无法解析、同一文件内重复的名字，或两个活动 namespace 中的同名条目）会让 `Team hooks can be resolved` 与 `Team model profiles can be resolved` 失败，并给出 pull 只记录一次的原因；`teamai status` 把它们计为 0 时会指向这里。`Env variables injected in shell profile` 不再只查标记注释：它会检查 `env/env.yaml` 能否解析、以及是否在 `variables:` 键下声明了变量（写成普通的 `KEY: value` 映射等于没有声明；而显式写成 `variables: []` 属于没有内容要下发的配置，不会判为失败）、每个变量是否以 `env.yaml` 声明的值（或你为该团队设置的值；用 `--from-env` 设置的不会写入）写进了 `env.sh`（残留的旧值会一直被导出到每个 shell 和 MCP server，直到下次 pull；比对时会用生成器自身的逆运算读回 `env.sh`，因此跨多行引用的多行值能够正确匹配，而不会被误判为过期），以及本作用域注入的代码块（即 source 本作用域 `env.sh` 的那一块，因为同一个 profile 里还可能有其他作用域的代码块）是否真的能加载它——未加引号的 Windows 路径在 POSIX shell 中会被转义破坏，`source` 从不执行，而且没有任何提示。`No stale env blocks left behind` 是独立的一项检查：pull 优先选用哪个文件会随时间变化（Windows 上 Git Bash 的登录 shell 读取的是 `.bash_profile`/`.bash_login`/`.profile`，从不读取 `.bashrc`），而 pull 只会新增代码块，从不迁移旧的，因此早期安装或平台变化留下的失效代码块可能一直留在另一个候选文件里。它会列出每一个这样的文件（检查 `.zshrc`、`.bashrc`、`.bash_profile`、`.bash_login` 和 `.profile`，新旧写法都算），并指向 `teamai uninstall` 来清除它们——这与投递检查分开进行，因此不会因为还留着一个旧副本，就让一个正常工作的 env 代码块被判成故障。

`Codex trusts this project, so it loads its team MCP servers` 在 project scope 下、项目的 `.codex/config.toml` 含有本 worktree 的 `managed-mcp.json` 为 Codex 记录的 server 时生成：Codex 只在受信任的项目中加载该文件，对未受信任的项目则静默跳过。它按 Codex 的方式读取 Codex 用户配置（`~/.codex/config.toml`，或 `toolRoots.codex` 下的那份）中的 `projects` 表：先取当前 checkout 的、设置了 `trust_level` 的 `projects."<dir>"` 条目，再取其主 checkout 的，均按真实路径（`/private/tmp/...` 而非 `/tmp/...`）。在该条目设置 `trust_level = "trusted"` 之前，它会失败，并指出文件及其中的 server；pull 结束时的检查也会报告这一失败。pull 尝试自动信任后，如果该检查仍失败，请在 Codex 中修改项目信任，或自行为主 checkout 加上该条目，这样即覆盖所有 worktree。doctor 只读取该文件。

`Contributed learnings are published` 会在 `teamai contribute` 写下、但尚未推送成功的笔记仍在队列中时失败。当本次 pull 已经说过时，手动 `teamai pull` 结束时不会再重复它：pull 会尝试发布队列并自行报告结果，还会带上导致失败的推送错误——这是该检查本身给不出的信息。如果 pull 因为团队仓库刷新失败而根本没走到那一步，该检查会照常打印。

`--json` 把同一份报告作为单个对象打印到 stdout，并将所有日志改走 stderr，因此 `teamai doctor --json 2>/dev/null` 可以整体解析；退出码不变。每个检查都会带上人类模式下显示的修复建议：

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

尚未初始化时 `scope` 为 `null`。仅当团队仓库声明了 packages 时才会出现 `packages` 字段，内容是已渲染的报告行；`notes` 只在有额外提示时出现：上文所述的 namespace 提示（替换了根目录条目的条目，或未配置角色或项目时重复定义的名字），以及无法查询 Codex 时（PATH 中没有 `codex`，或其 app-server 失败）的 Codex hook 信任提醒。

自动更新在 Stop hook 中执行，可通过两层控制：

| 层级 | 文件 | 字段 | 值 |
|------|------|------|------|
| 团队默认 | `teamai.yaml` | `autoUpdate` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

用户级 `updatePolicy` 始终优先于团队级 `autoUpdate`。

自更新只会重装由 npm 管理的副本。当 teamai 从 `node_modules` 之外的检出目录运行（例如通过 `npm link` 链接）时，自动更新和 `teamai update` 都会跳过安装并打印警告，因为 `npm install -g` 会用已发布的包替换该链接。要更新它，请在该检出目录中拉取最新代码并重新构建。

在 Windows 上，更新检查、安装和 hooks 刷新均不会弹出命令行窗口。

### 使用统计上报

Pull 对整批统计上报最多等待 5 秒，之后继续其他工作，上报任务仍会完成。
超时后推送成功，仍会更新本地已上报快照。skill 使用按 scope 记录：写入会话所在
目录对应的已配置 teamai 项目的数据目录（或 user scope），因此每个目标只上报
自己的使用；未配置 teamai 的目录不记录。Dashboard 会话仍写入整机共用的
`~/.teamai/dashboard/events.jsonl`，但每条事件都记下所属 scope 数据目录（data home）的键（哈希值，不是路径），因此每个 scope
只上报在其中记录的会话：user scope 的 pull 不再上报项目的会话，项目会上报自己的
Copilot 会话以及从软链接路径启动的会话。每个会话只上报一次，整体归属其开始时所在的
scope，即使之后切换到另一个项目：它的 Stop 带有整份 transcript 的累计值，第二个 scope
会重复计算。旧版本记录的事件没有该键：由其目录当前解析到的 scope 上报（项目下的嵌套
clone 解析到它自己的项目或 user scope，而不是外层项目）；没有目录或目录已删除的事件不由任何 scope 上报。
每个 scope 还各自保存已上报快照，且复用回退 ID 的新会话（Copilot 未提供会话 ID 时基于 PID 的 ID）
总算作新会话，无论先前那个由哪个 scope 上报；恢复的会话（`claude --resume`）保留原 ID，仍是同一个会话，无论在哪里恢复，都由最先上报它的 scope 上报；升级后的首次上报从原先各 scope 共用的快照开始，不会重复上报。目标确认成功后才清理自己的使用事件，
推送失败会保留事件（最多保留最新 5,000 条，见下文）。上报完成前继续持有相关同步锁，
避免另一次 Pull 与尚未完成的上报竞争。

这仍是尽力上报，不提供崩溃恢复保证：远端推送成功与本地确认之间如果进程
被终止，统计仍可能重复；也不提供多仓库部分成功时的持久化逐目标去重。
5 秒限制只结束等待，不取消 Git，也不强制仍有子进程运行的 CLI 退出。

默认情况下，`teamai pull` 会把会话/使用统计提交进团队仓。从只读远端拉取（或
不想要统计提交）的团队可在 `teamai.yaml` 中关闭：

```yaml
usageReport: false
```

Pull 在上报步骤之后把每个 scope 的使用文件限制为最新 5,000 条事件，丢弃更早的
事件。对 HTTP 源或 `usageReport: false` 的团队，该文件是 `teamai stats` 唯一的
数据来源，因此文件保持有界而不会被清空；上报未完成且事件超过 5,000 条的上报
scope 也以同样方式丢弃最早的未上报事件。该上限只在上报清理完已发送事件之后执行。Hook 追加、上报后的清理与该上限共用使用文件旁的一把锁，
因此改写文件时不会丢失期间记录的事件。Hook 在约 250 ms 内拿不到锁时，把事件写入旁边的
`*.pending-<id>.jsonl` 文件，由下一个持锁者追加进使用文件；改写在约 5 秒内拿不到锁时保持文件不变。
pending 文件的权限不宽于使用文件（尚无使用文件时仅所有者可读写）。工作区内的 `.teamai/.gitignore`
忽略该锁、改写的临时副本与 pending 文件；`pull` 与 `push` 会为已有的单仓库 `.gitignore` 补上这些条目，
已有的项目级 `.gitignore` 则在使用文件第一次写 pending 文件或改写时补上。

**删除其他项目上报进你 `stats/` 的 skill。** 在 skill 使用按 scope 记录之前，下一个
执行 pull 的项目会上报所有项目的 skill，因此 `teamai-reports` 上的 `stats/<user>.yaml` 可能
统计了属于无关仓库的 skill。这些事件没有记录目录，teamai 无法归属，也不会改写该
文件。请手动删除该条目，在单独的 clone 中操作，不要动 teamai 的 `reports-wt/` 检出：

```bash
git clone --branch teamai-reports --single-branch <team-repo-url> teamai-reports
cd teamai-reports
# 删除 stats/<user>.yaml 中 `skills:` 下该 skill 的条目
git commit -am "stats: remove <skill> reported from another project"
git push origin teamai-reports
```

下一次上报会先读取该分支，所以条目不会再出现。

### Git 子模块

若团队以 git submodule 形式分发 skill，在 `teamai.yaml` 中开启 `submodules: true`：

```yaml
submodules: true
```

每次 pull 时 teamai 会执行 `git submodule update --init`，按团队仓钉住的版本
填充子模块（仅 git 仓后端生效；取完整子模块历史——浅取无法检出较旧的 pin）。
默认关闭。若更新失败，pull 会记录警告并保留旧的同步版本号，下次 pull 会重新
完整同步并自动重试（不会被"版本未变化"的快速路径跳过）。注意：子模块拉取
依赖环境现有的 git 凭据——若宿主机采用按命令注入 token 的认证方式（而非配置
credential helper），私有子模块将无法通过认证。

### Pull 后脚本

团队常常需要部署 teamai 内建面之外的内容（客户端可选模型、本机安装、PATH
shim 等）。在 `teamai.yaml` 中声明 `scripts.postPull`，teamai 会在一次 pull
完全结束后，为**拥有本机部署权的那个团队仓**运行该 Node 入口——项目 scope
激活时是项目仓，否则是用户仓（继承来的用户仓只带资源与知识，不带部署）：

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

路径相对团队仓根目录；解析到仓外（含经 symlink）会被拒绝。会话启动路径上，
脚本作为 pull 进程的子进程运行，并在固定预算内
被等待（导出 `TEAMAI_POSTPULL_TIMEOUT_SEC`，脚本可据此为重步骤自限）；预算
到期时脚本被留在后台继续跑而不是被杀，下次 pull 自会对账。交互式
`teamai pull` 则以 fire-and-forget 方式把脚本拉起进终端。路径非法、文件缺失
或拉起失败只会是 `~/.teamai/debug.log` 里的一行（`postPull: launched /
exited / timed out`），绝不会让 pull 失败。

### CI 集成

`teamai ci extract-mr --output <dir> --dry-run` 在访问 provider 或创建 artifacts 前拒绝执行，打印 `teamai ci extract-mr --output has no --dry-run preview, nothing was run` 并以退出码 1 结束。省略 `--output` 可执行预览；去掉 `--dry-run` 可写入 artifacts。

`teamai ci extract-mr` 接入 CI 流水线，从每个 MR/PR 自动提取知识：

```bash
# 评论模式：以评论形式发布建议（在 PR 打开/更新时运行）
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# 写入模式：合并后将审批通过的建议写入知识库
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

工作流程：

1. MR 打开/更新 → CI 触发 `--mode comment`，提取知识建议并发布为 MR 评论
2. Reviewer 审查评论，对不需要的建议添加拒绝标记（GitHub 👎 / TGit ☝️）
3. MR 合并 → CI 触发 `--mode write`，将未被拒绝的建议写入团队知识仓库

如果审核状态 API 返回非 2xx 响应，write 模式会按 fail-closed 处理：任务失败退出，且不会向团队知识仓库写入文件、提交或 push。

评论模式在无法列出已有 marker 评论时也会按 fail-closed 处理，避免临时的 Provider 错误创建重复评论。

模板及配置说明见 [`examples/ci/`](../../../examples/ci/README.md)。

### 跨团队 Skill 订阅

`teamai source` 让你订阅其他团队的公共 skill 仓库，pull 时自动获取最新 skills：

```bash
# 添加订阅源
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# 查看订阅列表
teamai source list

# 浏览订阅源的 skills
teamai source browse other-team

# 移除订阅（同时清理其 skills）
teamai source remove other-team
```

订阅源的 skills 在 `teamai pull` 时自动同步到本地，与团队自有 skills 共存。`teamai source add`/`remove` 会立即更新当前 scope 的团队仓，因此改动尚未提交时，本机的 `list`、`browse` 和 `pull` 也会使用它。订阅配置存储在该仓库 `teamai.yaml` 的 `sources` 字段中。运行 `teamai push` 会开一个包含配置改动的 PR；合入后，每位成员的 `teamai pull` 都会自动获取到新的订阅源。

订阅源的克隆和拉取时间按配置仓库 URL 的 SHA-256 哈希缓存，并在源名称之间共享。不同团队可以用同一源名称订阅不同仓库，不会共用克隆或 24 小时拉取 TTL。同一 URL 的不同源名称共享仓库版本和 TTL，避免旧名称的缓存覆盖已更新的共享 skill。修改 URL 会使用该 URL 的缓存；旧版按名称隔离及仅按名称缓存的克隆会原样保留，不再复用。移除源会保留仓库缓存，供其他安装继续使用。

订阅源安装清单按团队检出与目标目录（用户 HOME、项目或 worktree）分别保存。`source remove` 只释放当前安装的归属，保留共享缓存和其他安装记录。如果另一目标已从共享 `teamai.yaml` 中移除源名称，仍可在剩余目标运行 `source remove <name>`，按其记录清理，且不会重写团队配置。如果共享名称已重新订阅其他仓库，旧安装或无法确定仓库身份的记录也只允许本地清理，并保留新订阅。

pull 在复制前检查物理目标。若重叠路径已由不同或无法识别仓库的安装占用，会跳过该 skill 并显示归属记录；需要先移除另一安装才能替换。同一仓库可以共享并更新路径。新增目标冲突时会保留原有副本；更换仓库时若有冲突，则完整保留原安装。成功更换后会释放旧部署路径。只有最后一个订阅源拥有者释放路径后才删除文件，也适用于符号链接及重叠目录。dry-run 执行相同检查，但不改写 skill 或安装清单。

来源标签使用当前安装记录；如果另一安装的 skill 占据当前物理目标，push 也会排除它。升级时，旧版未记录目标目录的 `installed.json` 无法证明部署位置，会原样保留且绝不作为删除依据。其 skill 名称会暂时从 push 排除并显示警告，因此无关的同名本地草稿也可能被暂缓。先核查并备份所有目标中的旧副本，确认归属后才手动归档旧清单，再 pull 仍使用的源以建立有范围的安装记录。已经停止公开的旧 skill 可能需要人工清理，不会自动推断并迁移。

移动或删除团队检出不等于放弃其已部署文件；尽可能先在原范围移除订阅。新清单记录团队检出和目标目录，归属提示会指出需要核查的记录。孤立记录在人工核查前继续保护文件，不会自动回收。如果归属记录无法安全读取，skill push 会停止并警告，避免误发布第三方文件。

Git 订阅源的添加、浏览/缓存刷新、pull 和移除共用本机生命周期锁，并在锁内重新读取状态。锁被占用时会提示重试，不会越过仍在运行的操作；dry-run 只检查锁状态并读取现有缓存，不克隆、拉取或更新时间戳；没有缓存时会说明暂时无法预览 skill 内容。订阅源事务进行期间，skill push 也会暂缓并提示重试。

成功拉取只记录当前部署目标，并释放不再使用的工具路径，即使仓库 URL 未变也一样。有效源配置未声明 `publicSkills`、列表为空或所有公开 skill 目录均不存在时，会释放原安装；其他安装仍拥有的文件会被保留。源配置缺失或无法读取时会保留原安装，不推断为停止公开。因冲突保留的副本继续保留原路径记录。

公开及已记录的 skill 名称必须已规范化，不能包含规范化后会改变的路径片段、重复分隔符、反斜杠或末尾斜杠，避免通过不同拼写绕过团队 skill 优先级。规范的嵌套名称也不能覆盖团队或内置 skill 的目录，包括父子路径冲突。保护机制留下旧源文件时，pull 或移除会保留其有范围的来源记录，相关路径在人工核查前仍从 push 排除，不会静默收归团队内容。移除订阅源会先检查所有其他归属记录和删除目标，再修改共享配置。归属记录必须包含安全的相对 skill 名称和非空的下级相对路径；等同根目录、越界或绝对路径会阻止清理，且不更改配置或文件。

所有被接受的源名称（包括 `.git`、`node_modules` 和以 `.pyc` 结尾的名称）都参与归属、来源和 push 检查；资源目录过滤规则不会隐藏这些名称的跟踪记录。

若有范围的记录中任一 skill 缺少非空的实际部署路径，pull 和源移除会保留整个安装并要求人工核查；同一仓库和预览也遵循此规则。当前工具路径不能证明历史部署位置，不会作为推测清理、覆盖文件或重建归属的依据。先核查并备份原始源副本及无关本地文件，再人工退役不明确的记录；修改工具路径或重试 `source remove` 无法补全缺失的历史。不明确的有范围归属会跨 checkout 按名称隔离，防止共用 HOME 的另一团队发布保留的源文件；在核查记录前，这可能暂时隐藏无关的同名草稿，完整的现代物理路径记录仍只按路径排除。明确记录了非空普通路径的旧清单仍受支持。 其他有范围安装或旧版无范围记录中的不明确声明，也会在任何修改前阻止相同、父级或子级逻辑名称的源写入和清理，并指明待核查的记录。由于历史位置未知，此保守名称检查可能阻止本来位于不同目录的操作，但绝不会推测删除权限。无关名称的源和具有完整具体路径的外部记录保持正常行为。

通过归属预检后，订阅源 pull 会恢复 Codex 的已验证副本协调：仅当未被占用的配置目录副本同时与共享副本和传入源内容一致时才删除它。不同的本地副本、其他安装、已有跟踪路径、计划目标以及仓库输入均受保护；dry-run 不会协调文件。若 skill 根目录是符号链接，仅在其解析为源仓库内的子目录时才复制实体内容。越界、悬空或循环的根目录别名会在部署前停止；普通的仓库内别名和工具目标符号链接仍受支持。已有的 skill 根目录链接会保留记录及其指向的内容，等待人工核查；仅凭物理路径记录不能授权删除链接目标。不会迁移内部文件符号链接。

对于已有完整物理路径记录的订阅源，push 只按实际物理路径排除其内容；另一个 agent 中无关的同名本地 skill 仍是候选项。仅旧版或缺少完整物理归属的有范围记录使用按名称隔离；格式错误或不完整的物理路径记录仍会阻止 skill push。

新的有范围安装记录会在复制后保存每个目标的原始物理路径。对已有安装执行复制、撤回或移除前，TeamAI 会核对全部目标；符号链接改向、悬空、无法读取或无法确认时，会在更改安装文件、YAML 或记录前停止。请恢复原目标后重试，或人工核查保留文件和记录。其他安装保护的是原始物理位置，不是符号链接的新目标。没有物理路径记录的旧安装仅允许明确记录的普通路径；已有符号链接路径（包括链接形式的根目录）需要人工核查，不会猜测历史归属。新安装仍支持稳定的符号链接目标。

规范的嵌套公开名称（如 `group/child`）仍受支持。若父子目录边界变更存在歧义（包括同一仓库的其他安装），或不同 skill 身份指向同一个物理目录，pull 会在复制任何 skill 或修改安装记录前停止。警告会要求人工核查：备份保留的文件，在受影响的安装中执行 `source remove`，再拉取新的公开内容。如果保留的父目录中还有其他订阅源拥有的子目录，父目录的来源记录也会保留；先移除子目录的安装，再重试移除父目录。不会自动迁移子树。互不重叠的目标迁移，以及同一仓库、同一 skill 对完全相同路径的共享仍受支持。

状态和 skill 详情按记录的物理路径识别嵌套订阅源安装，不会将无关同名副本标为来自该订阅源。如果有范围的来源记录无法读取，状态或 skill 检查会提示来源标签不完整；local-only 标签不代表该文件已确认为本地所有。

请勿并行执行订阅源安装/移除与 push。订阅源锁会串行化源状态修改，但 push 不会在整个暂存和发布事务中一直持有该锁；完整的跨命令快照隔离仍有限制。

源仓只会共享它在自己 `teamai.yaml` 的 `publicSkills` 列表里显式声明的 skill。如果对方仓库没有 `teamai.yaml`，或没有声明 `publicSkills`，`teamai source add` 仍会成功，但会警告该源将同步 **0 个 skill**——需要对方团队先发布 `publicSkills` 列表，才会有内容流转过来。

#### HTTP 源

除了 git 订阅源，还可以在已有 git 主仓的基础上附加一个 HTTP 源——适用于服务端管理的 skill 下发：

```bash
# 附加 HTTP 源（git 主仓不受影响）
teamai source add-http https://your-team-host/api --token <api-key>

# 查看（在 "HTTP source" 下显示）
teamai source list

# 解绑并卸载其资源
teamai source remove-http
```

HTTP 源通过 hook dispatch 在每次 session 中上报状态并拉取 skill 指令。每个安装仅支持一个 HTTP 源。若主仓本身已是 HTTP 模式（`init --http`），则 `add-http` 不可用（主仓已占用 HTTP 配置）。
