# 任务文档与人工确认

TeamAI 管理与代码一起版本控制的任务文档。全局产品需求、架构与部署文档保留在
Octo Docs/Drive，Octo Loop 管理任务身份与协作。执行 Agent 使用明确选择的身份
调用 Octo CLI；TeamAI 不保存 Octo 凭证，也不内置 Octo 服务端客户端。

通过 `teamai skill get sdlc` 阅读操作说明，通过 `teamai skill path sdlc` 获取模板和
脚本。始终在业务仓库的工作树中操作，即使团队资产仓库位于别处。每个任务对应
`intent/<workspace-id>/<task-id>/{intent,spec,plan}.md`，按需创建并随代码提交。
文件名遵循 Anthropic SDLC playbook；目录布局和 OKF 类型名是 TeamAI 的约定。
共享 docs 同步不管理这个目录。

Agent 编写并提交当前阶段后，执行 `check.mjs`，再通过 `review.mjs --request`
请求确认。两个脚本均在 Git 根目录执行，接受 `--workspace`、`--task` 和
`--stage intent|spec|plan`。产品负责人确认 intent 和 spec，工程负责人确认 plan。

负责人在自己的交互终端中运行
`review.mjs --workspace <id> --task <id> --respond <request-id>`，输入 approve、
reject 或 cancel。脚本展示文件路径、提交 SHA 和 blob ID，记录当前 TeamAI 成员名。
Agent 会话与非交互输入不能作出确认。这是本地操作归属，不是 SSO 或新的组织权限系统。

开始依赖步骤及交付 PR 前，运行 `review.mjs ... --stage <阶段> --approved`。
intent 改变后重新检查和确认 spec、plan；spec 改变后重新检查和确认 plan。
只修改代码且文档内容未变时不机械重复确认。请求和答复追加保存在 Git 公共目录中，
同一仓库的工作树共享记录；`--history` 可读取审计记录。新克隆需要重新确认，
导出的历史仅作证据。不会新增审批 Markdown 文件。

Agent 使用现有工具实现代码、运行检查和创建 PR。PR 包含确认摘要、文件版本和实际
检查结果，失败或未执行不能算成功。仅要求完成 intent、spec 或 plan 时明确报告
停止阶段。PR 不表示合并、部署、更新权威文档或自动完成 Loop 任务；回写 Loop
需要任务执行时取得相应授权。

## OKF 与迁移

新任务文档和受管理知识使用含非空 `type` 的 YAML frontmatter，保留未知字段与
其他生产者定义的类型。来源使用 OKF 对象和普通 Markdown 链接。保留文件
`index.md`、`log.md` 适用各自规则。格式正确、人工确认、内容准确、测试通过分别
判断；置信度和投票不能推导已验证。

使用 `check.mjs --file <路径>` 检查格式，附加
`--migrate --type '<负责人确定的类型>'` 可输出 JSON 迁移前后预览。脚本不写文件；
在独立工作树审查后再应用。语义不明确的元数据和原文保留，权威文档迁入 Octo
单独处理。Skills、Rules 保留原生执行格式。

## 已移除的能力

Workflow 执行、Models 目录和切换、Dashboard、Scorers、会话评分（包括历史评分
读取与发布）已移除。HTTP/ClawPro 的上报、同步、资源下发、项目绑定入口也已移除。
现有 Git 来源继续通过工具适配器下发 Skills、Rules、MCP。未来 Octo 来源可以
复用适配器，本版不实现 Octo 下发 API。

旧 Workflow 运行不能续跑，旧评分与配置文件不会重新启用这些功能。不自动删除
用户会话原文、Git 历史或知识原文。历史凭证的 Git 忽略保护保留，工具原生模型
配置不再由 TeamAI 管理。原 HTTP-only 安装需要重新初始化为 Git 团队仓库。
