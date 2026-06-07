# 实施计划 — Phase 1：检索 Subagent

- [ ] 1. 在 `toolPaths` 配置层引入 `agents` 字段
   - 在 `src/types.ts` 的 `ToolPathConfig` 中新增可选字段 `agents`，并在 `src/config.ts`（或对应默认配置加载点）为 claude/codebuddy/cursor 等已支持的工具补全默认 agents 路径（如 `~/.claude/agents/`）
   - 确保未配置 agents 字段的工具走"跳过"分支而非报错
   - _需求：1.2、1.4_

- [ ] 2. 实现 `AgentsHandler` 资源处理器并注册到 `getHandler`
   - 在 `src/resources/` 新建 `agents.ts`，参照 `SkillsHandler` 实现扁平单文件、无子目录的同步语义（pull/push/remove + tombstone）
   - 在 `src/resources/index.ts` 注册新 handler；在 `pull.ts`、`push.ts`、`remove.ts` 流程中纳入 agents 资源类型
   - 配套 vitest 单元测试覆盖 pull/push/remove 三条主路径
   - _需求：1.1、1.3、1.5、1.6、6.3、6.5_

- [ ] 3. 编写内置 `teamai-recall.md` subagent 定义并随 pull 部署
   - 在 CLI 内置资源目录（参照 `builtin-skills` 的存放方式）新增 `teamai-recall.md`，包含：触发说明、检索流程提示、输出格式约定（结构化列表 + 末尾 `<!-- teamai:recalled-doc-ids: [...] -->`）、读取 `~/.teamai/docs/codebase.md` 的前置说明
   - 仿照 `deployBuiltinSkills` 在 `src/builtin-agents.ts`（或同名模块）中实现 `deployBuiltinAgents`，并在 `pull.ts` 流程中调用，确保对所有已安装工具的 agents 路径覆盖部署
   - 配套单测验证文件被正确写入并能用 CLI 内置版本覆盖本地旧版本
   - _需求：2.1、2.2、2.3、2.4、2.6_

- [ ] 4. 在 CLAUDE.md 中注入"任务前必检索 + 任务后声明引用"规则块
   - 在 `src/utils/claudemd.ts` 复用 `injectClaudeMdSection`，新增一个独立 marker 段（如 `<!-- [teamai:recall-rules:start] -->` / `end`）写入两条规则文案
   - 在 `pull.ts` 流程对每个已安装工具的 claudemd 路径独立注入；不可写或未配置时仅 warn，不阻塞
   - 配套单测验证：marker 区块外用户内容不被破坏；多工具独立注入；写入失败时仅告警
   - _需求：3.1、3.2、3.3、3.4_

- [ ] 5. 新增 `TodoWrite` PostToolUse hook 提醒模块
   - 在 `src/hooks.ts` 中新增 `TodoWrite` PostToolUse hook 注册项（与现有 `auto-recall` 共存，使用独立 description 关键字），在 Claude/CodeBuddy/Cursor 三种格式下都能正确写入配置文件
   - 实现 hook 处理脚本：输出 `hookSpecificOutput.additionalContext` 提醒文案；复用现有 session cache 文件做 session 内去重（每 session 仅 1 次）；尊重 `TEAMAI_RECALL_DISABLED=1` 开关
   - 配套单测覆盖去重、禁用开关、三种工具配置写入
   - _需求：4.1、4.2、4.3、4.4_

- [ ] 6. 扩展搜索索引以覆盖 docs/rules/skills/learnings 四类
   - 在 `src/utils/search-index.ts` 中扩展索引条目结构，新增 `type: 'docs' | 'rules' | 'skills' | 'learnings'` 必选字段，并预留可选字段 `path`、`hotness` 供 Phase 4.3 使用
   - 重写 `buildIndex`（或新增 `collectAllSources`）使其遍历四类源目录构建索引；保持 `MAX_DOC_BYTES` 截断与 ">2s 重建告警" 行为
   - 当检测到旧版只含 learnings 的 `search-index.json` 时自动重建（基于版本号或 schema 标记）
   - 配套单测覆盖：四类条目均被收录；超大文件被截断；旧索引被自动迁移
   - _需求：5.1、5.3、5.4、5.5、5.6_

- [ ] 7. 在 `recall` 命令与 subagent 检索路径中输出类型标签
   - 修改 `src/recall.ts`：从扩展后的索引返回结果中读取 `type` 字段，将其作为标签拼到每条命中输出中；保留 `[teamai:recall:start] ... [teamai:recall:end]` 输出包络以保持向后兼容
   - 在 `auto-recall.ts` 中确认仍使用同一索引但行为不变（不引入新规则触发链路）
   - 配套单测验证 recall 输出包含四类标签且整体格式与升级前一致
   - _需求：5.2、6.1、6.2、6.4_

- [ ] 8. 端到端集成测试 + 文档与配置补充
   - 添加端到端集成测试：mock 一个 team repo（含 agents/、skills/、learnings/、docs/、rules/ 五类内容），跑 `teamai pull` → 验证 agents 文件落地、CLAUDE.md 规则块注入、TodoWrite hook 配置写入、四类索引构建、`teamai recall` 输出含四类标签
   - 在仓库 `README.md`（或 `docs/`）中补充 Phase 1 新增能力的简要说明（agents 资源类型、teamai-recall subagent 用法、TodoWrite 提醒开关）
   - 验证 `teamai recall <query>` 在升级后行为与升级前格式一致
   - _需求：1.1、2.1、3.1、4.1、5.1、6.1、6.5_
