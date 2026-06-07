# 需求文档：Phase 1 — 检索 Subagent

## 引言

当前 teamai-cli 的知识库检索机制存在两个核心问题：

1. **被动触发**：现有 `auto-recall` 只在 `PostToolUse`（Bash 报错、Grep、WebSearch、WebFetch）时被动触发，主对话本身不会在"任务开始前"主动检索团队知识库。
2. **上下文污染**：现有 `teamai recall` 与 `auto-recall` 都把命中结果直接以 `additionalContext` 或 STDOUT 注入主对话上下文，随知识库增大检索结果会持续膨胀，挤占主对话上下文窗口。

Phase 1 目标是新建一个以 **subagent** 形式运行的检索 agent（`teamai-recall`），由主对话通过 Claude Code 的 Agent tool 调用：检索过程在独立子上下文中完成，最终只把"精简摘要 + doc_id 列表"返回给主对话——主对话上下文不再随知识库膨胀。

围绕这个目标，本阶段需要：

- 扩展 teamai-cli 的资源同步能力，支持 `agents/` 目录（新资源类型）
- 提供并部署内置的 `teamai-recall` subagent 定义文件
- 在 CLAUDE.md 中注入"任务前必须先调用检索 subagent + 任务完成后必须声明参考的 doc_id"两条规则
- 在 `TodoWrite` 等任务规划点设置 hook 兜底提醒
- 把检索范围从仅 `skills + learnings` 扩展到 `docs + rules + skills + learnings` 四类全覆盖，并在检索结果中标注类型

> 范围声明：本阶段 **不涉及** 双计数器（Phase 3）、置信度（Phase 4.1）、hot/cold 分流（Phase 4.3）、contribute-check 知识库空白维度（Phase 2）。这些将在后续阶段逐步引入；本阶段只需在数据结构和接口上为它们预留空间，不做完整实现。

## 需求

### 需求 1：teamai-cli 支持同步 agents 资源类型

**用户故事：** 作为 teamai-cli 的开发者，我希望系统能像同步 skills 一样同步 agents 目录，以便检索 subagent 等 agent 文件可以通过团队仓库分发，并自动部署到各个 AI 工具的 agents 路径下。

#### 验收标准

1. WHEN 用户运行 `teamai pull` THEN 系统 SHALL 把 team repo 中 `agents/*.md` 同步到本地各 AI 工具的 agents 路径（如 `~/.claude/agents/`、`~/.codebuddy/agents/`）
2. WHEN `teamai.yaml` 的 `toolPaths.<tool>` 中没有定义 `agents` 字段 THEN 系统 SHALL 跳过该工具的 agents 同步而不报错
3. WHEN 用户在 `~/.claude/agents/` 下新增或修改了一个 agent 文件并运行 `teamai push` THEN 系统 SHALL 检测到该文件并将其推送到 team repo 的 `agents/` 目录
4. WHEN 检测某个 AI 工具是否安装时 THEN 系统 SHALL 复用现有 `ResourceHandler.isToolInstalled` 逻辑，未安装的工具不创建 agents 目录
5. WHEN 用户运行 `teamai remove <agent-name>` THEN 系统 SHALL 从 team repo、本地各 AI 工具 agents 路径同时删除该 agent，并写入 tombstone（与 skills 一致的删除语义）
6. IF agents 同步过程中某个工具失败 THEN 系统 SHALL 仅警告该工具失败，不影响其他工具的同步

### 需求 2：内置 teamai-recall subagent 定义并随 pull 自动部署

**用户故事：** 作为团队成员，我希望执行 `teamai pull` 后本地自动获得一个可用的 `teamai-recall` subagent，以便主对话可以立即通过 Agent tool 调用它做知识库检索。

#### 验收标准

1. WHEN 用户运行 `teamai pull` THEN 系统 SHALL 把 CLI 内置的 `teamai-recall.md` 部署到所有已安装 AI 工具的 agents 路径下（参照 `deployBuiltinSkills` 的实现模式）
2. WHEN `teamai-recall.md` 已经存在于本地且内容与 CLI 内置版本不同 THEN 系统 SHALL 用 CLI 内置版本覆盖本地版本（确保版本同步）
3. WHEN 主对话通过 Agent tool 以任务描述（自然语言 query）调用该 subagent THEN subagent SHALL 在独立上下文中：
   1. 提取任务关键词
   2. 调用 teamai 检索（覆盖 skills + learnings 两类知识库，作为 MVP 范围）
   3. 读取命中条目原文，生成不超过约定长度的精简摘要
   4. 输出结构化结果列表（每条包含：序号、doc_id、类型标签、文件路径、一句话摘要、信心分数）
4. WHEN subagent 输出结果时 THEN 末尾 SHALL 以 HTML 注释（如 `<!-- teamai:recalled-doc-ids: [id1, id2] -->`）形式声明本次返回的所有 doc_id，供后续阶段（Phase 3 Stop hook）从对话记录中解析
5. WHEN 主对话调用 subagent 检索完成 THEN 主对话上下文 SHALL 仅看到 subagent 返回的精简摘要（约几百到一两千字符），不含完整知识库内容
6. WHEN 本地 `~/.teamai/docs/codebase.md` 文件存在 THEN subagent SHALL 在生成摘要前读取该文件，提取仓库列表作为上下文写入摘要前置说明；文件不存在时静默跳过，不影响检索流程

### 需求 3：CLAUDE.md 注入"任务前必检索 + 任务后声明引用"规则

**用户故事：** 作为团队成员，我希望主对话在涉及编码、问题排查、方案设计时自动遵守"先检索后动手"的纪律，以便团队既有经验可以被实际复用。

#### 验收标准

1. WHEN 用户运行 `teamai pull` THEN 系统 SHALL 在每个已安装 AI 工具的 CLAUDE.md（路径取自 `toolPaths.<tool>.claudemd`）中以现有 marker 机制（`<!-- [teamai:claudemd:start] -->`/`end`，或为本规则单独申请的新 marker）注入两条规则：
   1. 在开始任何涉及代码修改、问题排查、方案设计的任务前，必须先通过 Agent tool 调用 `teamai-recall` subagent 进行知识库检索
   2. 任务完成后（在最终回复中），必须声明本次实际参考的知识条目 doc_id 列表（建议格式如 `<!-- teamai:referenced-doc-ids: [id1, id2] -->`）
2. WHEN 用户已经手动在 CLAUDE.md 中编辑了 marker 区块外的内容 THEN 系统 SHALL 仅替换 marker 区块内容，不影响 marker 之外的用户内容（复用 `injectClaudeMdSection`）
3. WHEN 同一台机器同时安装多个 AI 工具（如 Claude Code + CodeBuddy） THEN 系统 SHALL 对每个工具的 claudemd 路径独立注入；任一工具 claudemd 路径未配置时 SHALL 跳过该工具
4. WHEN 注入失败（例如目标目录不可写） THEN 系统 SHALL 输出警告而不阻塞 pull 流程

### 需求 4：TodoWrite hook 兜底提醒

**用户故事：** 作为团队成员，当我让 AI 用 `TodoWrite` 规划任务时，我希望系统在第一时间提醒"如未检索请先调用 teamai-recall"，以便防止 agent 因规则被忽略而漏掉检索。

#### 验收标准

1. WHEN 主对话触发 `PostToolUse` 且 `tool_name === 'TodoWrite'` THEN 系统 SHALL 通过 hook 输出 `additionalContext`（与 auto-recall 同样的 hookSpecificOutput JSON 协议），内容包含：「任务已规划，请确认本次任务开始前已通过 Agent tool 调用 teamai-recall 完成知识库检索；如未检索请立即调用」
2. WHEN 同一 session 内 `TodoWrite` 被多次触发 THEN 系统 SHALL 在该 session 内最多发送 1 次提醒（去重，复用现有 session cache 文件机制）
3. WHEN 用户已经显式禁用（设置 `TEAMAI_RECALL_DISABLED=1`） THEN 系统 SHALL 跳过该提醒
4. WHEN hook 注入到 `settings.json` / `hooks.json` 时 THEN 系统 SHALL 与现有 `auto-recall` hooks 共存且独立（不同 description 关键字），并对 Claude / CodeBuddy / Cursor 三种格式均能正确写入

### 需求 5：检索范围扩展至 docs/rules，完成四类知识库覆盖

**用户故事：** 作为团队成员，我希望 `teamai-recall` subagent 能同时检索 skills、learnings、docs、rules 四类知识库，以便不同形态的团队知识（规范、设计文档、技能、踩坑笔记）都能在同一次任务前被一次性召回。

#### 验收标准

1. WHEN `teamai pull` 完成索引构建 THEN 系统 SHALL 在搜索索引中同时收录 docs、rules、skills、learnings 四类条目，每条条目带 `type` 字段标注类型（`docs` / `rules` / `skills` / `learnings`）
2. WHEN 用户调用 `teamai recall <query>` 或 subagent 在内部检索 THEN 返回结果 SHALL 包含来自这四类知识库的命中条目，并在每条结果上显示类型标签
3. WHEN 历史 `search-index.json` 仅含 learnings 条目 THEN 系统 SHALL 在下一次 pull 时自动重建索引，使其覆盖四类，不要求用户手动迁移
4. WHEN docs/rules/skills 中某条目内容超出 `MAX_DOC_BYTES`（50KB） THEN 系统 SHALL 复用现有截断逻辑，避免索引构建被超大文档拖慢
5. WHEN 索引数据结构扩展时 THEN 系统 SHALL 为后续 Phase 4.3 的 hot/cold 路径分流预留 `path` 或 `hotness` 字段（字段可选，本阶段允许全为默认值），不要求本阶段实现分流逻辑
6. WHEN 索引重建时间超过 2 秒 THEN 系统 SHALL 输出现有的告警日志（"consider incremental updates"），不阻塞 pull 流程

### 需求 6：保持向后兼容与可观测性

**用户故事：** 作为已经在使用 teamai-cli 的团队成员，我希望升级到含 Phase 1 的版本后，原有的 `teamai recall`、`auto-recall`、`teamai pull` 等命令行为不被破坏，并且新流程在出错时有明确日志。

#### 验收标准

1. WHEN 用户在 Phase 1 升级前已经存在的 `teamai recall <query>` 直接命令行调用 THEN 该命令 SHALL 继续返回与升级前一致格式的结果（`[teamai:recall:start] ... [teamai:recall:end]` 块），仅在内部扩展为四类来源
2. WHEN 升级前的 `auto-recall` 在 Bash/Grep/WebSearch/WebFetch 上的被动触发逻辑 THEN 系统 SHALL 保持不变，不与新增的 subagent 链路冲突
3. WHEN team repo 中尚不存在 `agents/` 目录 THEN `teamai pull` SHALL 静默跳过 agents 同步（视为该 team 暂未启用 agents 资源），不报错
4. WHEN subagent 调用失败、索引未构建、knowledge base 为空等异常 THEN 系统 SHALL 输出 debug 或 warn 级日志（复用 `log.debug`/`log.warn`），不向 STDOUT 抛出会被主对话当作上下文的错误信息
5. WHEN 在 vitest 单元测试中运行新增模块 THEN 关键路径（agents 资源处理器、subagent 部署、CLAUDE.md 注入新规则块、四类索引构建）SHALL 各自有至少一个单元测试用例覆盖
