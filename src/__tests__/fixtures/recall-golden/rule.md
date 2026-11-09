# Team Knowledge Recall (teamai)

> **Self-exemption (must read first):** If you ARE the `teamai-recall` subagent yourself, this rule does NOT apply to you — do not invoke `teamai-recall` (or any recall) again. Proceed directly to performing the knowledge search that is your task. This prevents infinite subagent recursion in tools (e.g. Cursor) whose always-apply rules leak into subagent sessions.
>
> **自豁免（务必先读）：** 如果你自己就是 `teamai-recall` subagent，本规则对你不适用——不要再调用 `teamai-recall`（或任何 recall），直接执行你本职的知识检索任务。此举防止在（如 Cursor 等）会把 always-apply 规则泄漏进 subagent 会话的工具中发生无限递归。

## 规则：任务开始前检索团队知识库（推荐）

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** search the team knowledge base
— unless one of the skip conditions below applies.

### 跳过条件（满足任一即可跳过检索）

1. **用户已提供上下文** — 用户在消息中明确引用了文件、给出了解决方案、或说明"答案在当前目录/这个文件里"
2. **本地文件已有答案** — 任务信息可直接从当前工作区文件获得（如修复当前文件中明显的 bug）
3. **简单/局部改动** — 对已知文件做小范围修改（修 typo、调整参数值、改格式），无需额外知识背景

### 方式一：通过 Subagent（推荐，适用于支持 Agent tool 的工具）

调用 `teamai-recall` subagent（位于 agents/ 目录），传入任务的自然语言描述。
Subagent 会返回结构化的团队知识摘要（skills、learnings、docs、rules、codebase）。

### 方式二：通过 Bash 命令（适用于所有工具）

```bash
teamai recall "<关键词1> <关键词2> ..."
```

从任务描述中提取 3-6 个高信号关键词进行检索。

If the output contains `Nothing was searched:`, this project's teamai config cannot be
read and no team knowledge was searched: show that line to the user rather than
concluding the team has no knowledge, and do not move the file or run `teamai init`
without their consent. If it contains `Recall skips the older index`, that scope was not
searched: relay that warning rather than conclude the team has no knowledge there.

**务必中英双语检索（跨语言召回）**：知识库中英文混杂，检索是纯词法匹配，
中文 query 无法命中纯英文文档，反之亦然。因此每个领域术语都应**同时给出中英两种写法**
一起检索，例如「重启推理集群」应扩展为 `重启 推理 集群 restart inference cluster`；
只翻译中英确实不同的术语；任何**语言无关的 token**（中英写法相同、或无实际译法者）一律保持原样，
例如专有名词、品牌与产品名、缩写、代码标识符与符号、错误码、版本号、文件路径、命令与 API 名
（`AppID`、`Kubernetes`、`GPU`、`RuntimeError`、`v2.1.3`、`oauth`）——翻译它们只会损害匹配。
