---
name: teamai-wiki
description: "Persistent, incremental LLM Wiki — accumulate structured knowledge across multiple ingest/query sessions. Supports init, ingest (local files, URLs, sessions), query, lint, export, and status operations with [[wiki links]] cross-references."
---

# /teamai-wiki

持续积累的多页面 Wiki 知识库。通过增量摄入（ingest）、查询（query）、健康检查（lint）不断积累知识，页面间用 `[[wiki links]]` 互相引用，可直接在 Obsidian 中浏览。

**团队共享知识库**：wiki 存储在 team repo 的 `wiki/` 目录中，通过 `teamai pull/push` 与团队同步。不仅支持代码，也支持文档、会议纪要、设计决策、团队信息、流程规范等任何知识源。

**替代 `/teamai-share-learnings`**：`/teamai-wiki ingest --from-session` 是 `/teamai-share-learnings` 的严格超集 — 结构化、增量、可查询。

## Usage

```
/teamai-wiki init [dir]                          # 初始化 wiki 目录结构（dir 可选，可以是代码库、文档目录或空目录）
/teamai-wiki ingest <source>                     # 摄入源文件/目录，更新 wiki 页面
/teamai-wiki ingest <source> --batch             # 批量摄入，少交互
/teamai-wiki ingest <url>                        # 从 URL 摄入知识（网页、GitHub 仓库等）
/teamai-wiki ingest --from-session               # 从当前 Claude 会话中提取知识写入 wiki
/teamai-wiki query "<question>"                  # 查询 wiki，综合回答
/teamai-wiki query "<question>" --save           # 查询并将回答存入 wiki
/teamai-wiki lint                                # 健康检查：矛盾、孤立页、缺失引用
/teamai-wiki status                              # 当前 wiki 统计（页面数、链接数、最近活动）
/teamai-wiki export [--format md|html]           # 导出 wiki 为单文件 Markdown 或 HTML
```

## What This Skill Does

实现 Karpathy LLM Wiki 模式的完整版本：

1. **持续积累** — wiki 是知识产物，每次 ingest 和 query 都在叠加知识
2. **增量摄入** — 通过 SHA256 哈希跟踪已处理文件，跳过未变更内容
3. **多源输入** — 支持本地文件/目录、URL、当前会话三种摄入来源
4. **结构化组织** — 八大分类：实体、概念、对比、人员、决策、流程、源摘要、查询结果
5. **双向引用** — `[[wiki links]]` 在页面间建立联系，自动维护 Backlinks
6. **可查询** — 基于已积累的 wiki 页面回答问题，带引用
7. **可导出** — 合并为单文件分享给不用 Obsidian 的同事
8. **可审计** — 操作日志（log.md）记录每次操作

## Wiki 目录结构

```
wiki/                              <- 存储在 team repo 中，通过 teamai pull/push 同步
├── _schema.md                     <- wiki 约定和配置（每次操作前读取）
├── index.md                       <- 所有页面目录索引（按分类组织，含一行摘要）
├── log.md                         <- 追加式操作日志
├── overview.md                    <- 全局综合概述页
├── _metadata.json                 <- 机器可读元数据（本地生成，不推送到 team repo）
│
├── entities/                      <- 实体页（专有名词：具体的模块、服务、产品、项目）
├── concepts/                      <- 概念页（通用名词：设计模式、架构原则、技术概念）
├── comparisons/                   <- 对比页（两个或多个事物的对比分析）
├── people/                        <- 人员页（团队成员、专长、职责）
├── decisions/                     <- 决策页（架构决策记录 ADR、技术选型、变更原因）
├── processes/                     <- 流程页（工作流、SOP、部署流程、on-call 流程）
├── sources/                       <- 源文件摘要页（每个被摄入的源对应一个）
└── queries/                       <- 有价值的查询结果（--save 存入）
```

## 页面分类说明

| 分类 | 目录 | 适用内容 | 示例 |
|------|------|----------|------|
| entity | entities/ | 专有名词：具体的模块、服务、产品、项目、工具 | hai-api-server, sglang-engine, pytorch |
| concept | concepts/ | 通用名词：设计模式、架构原则、技术概念 | rollback-workflow, retry-backoff, pub-sub |
| comparison | comparisons/ | 两个或多个事物的对比分析 | sglang-vs-vllm, redis-vs-memcached |
| person | people/ | 团队成员、专长领域、负责模块 | jeff-xu, alice-chen |
| decision | decisions/ | 架构决策、技术选型、变更记录 | use-redis-for-cache, migrate-to-k8s |
| process | processes/ | 工作流、SOP、部署/on-call/发布流程 | deploy-to-prod, incident-response |
| source | sources/ | 源文件的结构化摘要 | hai-api-server-py, design-doc-auth |
| query | queries/ | 有价值的查询结果 | sync-vs-async-comparison |

**分类选择由 LLM 智能判断**：ingest 时不需要手动指定分类。Agent 分析内容后自动决定应归入哪个目录。一份会议纪要可能同时产生 decisions/ 和 people/ 页面。

## 页面格式

每个 wiki 页面遵循统一格式：

```markdown
---
title: Message Builder
category: entity
tags: [hai-flow, core, message-queue]
sources: [hai_flow/hai_flow/core/message.py]
created: 2026-04-08
updated: 2026-04-08
---

# Message Builder

[正文内容...]

## Related

- [[hai-flow-engine]] — 所属系统
- [[rollback-workflow]] — 使用 MessageBuilder 实现回滚

## Backlinks

_Pages that link here:_
- [[overview]]
- [[hai-flow-engine]]
```

### 各分类页面模板

**comparisons/ 页面模板**：

```markdown
---
title: SGLang vs vLLM
category: comparison
tags: [inference, serving, gpu]
sources: []
created: 2026-04-08
updated: 2026-04-08
---

# SGLang vs vLLM

## 对比维度

| 维度 | SGLang | vLLM |
|------|--------|------|
| 吞吐 | ... | ... |
| 延迟 | ... | ... |
| 易用性 | ... | ... |

## 结论
[什么场景选什么]

## Related
- [[sglang-engine]]
- [[vllm]]

## Backlinks
```

**people/ 页面额外字段**：

```markdown
---
title: Jeff Xu
category: person
tags: [backend, hai, gpu-infra]
sources: []
created: 2026-04-08
updated: 2026-04-08
---

# Jeff Xu

## 专长领域
- GPU 推理服务架构
- Kubernetes 集群管理

## 负责模块
- [[hai-api-server]]
- [[sglang-engine]]

## Related
- [[alice-chen]] — 协作：前端开发

## Backlinks
```

**decisions/ 页面额外字段**：

```markdown
---
title: 选择 Redis 作为缓存层
category: decision
tags: [architecture, cache, redis]
sources: [docs/adr/001-redis-cache.md]
status: accepted
date: 2026-03-15
created: 2026-04-08
updated: 2026-04-08
---

# 选择 Redis 作为缓存层

## 背景
[为什么需要这个决策]

## 决策
[最终选择了什么]

## 原因
[为什么选这个方案]

## 备选方案
- 方案 A: ...
- 方案 B: ...

## 影响
[这个决策带来的影响]

## Related
## Backlinks
```

**processes/ 页面额外字段**：

```markdown
---
title: 生产环境部署流程
category: process
tags: [deploy, production, k8s]
sources: [docs/runbooks/deploy.md]
created: 2026-04-08
updated: 2026-04-08
---

# 生产环境部署流程

## 前置条件
- [ ] 所有 CI 测试通过
- [ ] Code review 已完成

## 步骤
1. ...
2. ...

## 回滚方案
...

## Related
## Backlinks
```

---

## Execution Steps

When invoked, first determine the subcommand (init/ingest/query/lint/status/export), then follow the corresponding steps. **Do not skip steps.**

---

### Subcommand: `init [dir]`

#### Step 1 — Parse arguments

- `WIKI_DIR`: 根据当前项目的 teamai scope 决定：
  - 读取 `<projectRoot>/.teamai/config.yaml` 中的 `scope` 字段
  - **project scope** → `<projectRoot>/.teamai/wiki/`
  - **user scope**（或无项目配置时）→ `~/.teamai/wiki/`
- `SOURCE_DIR`: 可选的 `dir` 参数

如果 `WIKI_DIR` 已经存在且包含 `_metadata.json`，提示用户已经初始化过，询问是否要重新初始化。

#### Step 2 — 创建目录结构

```bash
mkdir -p WIKI_DIR/{entities,concepts,comparisons,people,decisions,processes,sources,queries}
```

#### Step 3 — 生成 _schema.md

写入 wiki 约定文档：

```markdown
# Wiki Schema

本 wiki 由 `/teamai-wiki` skill 自动维护。

## 页面分类

| 分类 | 目录 | 说明 | 示例 |
|------|------|------|------|
| entity | entities/ | 专有名词：具体的模块、服务、产品、项目 | hai-api-server, message-builder |
| concept | concepts/ | 通用名词：设计模式、架构原则、技术概念 | rollback-workflow, deny-actions |
| comparison | comparisons/ | 两个或多个事物的对比分析 | sglang-vs-vllm, redis-vs-memcached |
| person | people/ | 团队成员、专长领域、负责模块 | jeff-xu, alice-chen |
| decision | decisions/ | 架构决策记录、技术选型、变更原因 | use-redis-for-cache |
| process | processes/ | 工作流、SOP、部署/发布/on-call 流程 | deploy-to-prod |
| source | sources/ | 源文件/文档的结构化摘要 | hai-api-server-py |
| query | queries/ | 有价值的查询结果 | sync-vs-async |

## 命名规则

- 文件名使用 kebab-case：`message-builder.md`
- 标题使用人类可读的格式：`Message Builder`
- Wiki 链接使用文件名（不含 .md）：`[[message-builder]]`

## 链接格式

- 内部引用：`[[page-name]]` — 仅使用文件名，不含目录前缀
- 带描述：`[[page-name]] — 简要说明`
- 跨分类引用同样有效，链接是全局唯一的

## 页面模板

每个页面必须包含：
1. YAML frontmatter（title, category, tags, sources, created, updated）
2. 正文内容
3. Related 段落（出链）
4. Backlinks 段落（入链，由系统自动维护）
```

#### Step 4 — 生成初始文件

写入空的 `index.md`：

```markdown
# Wiki Index

> Auto-maintained by /teamai-wiki. Last updated: YYYY-MM-DD

## Entities

_No pages yet._

## Concepts

_No pages yet._

## Comparisons

_No pages yet._

## People

_No pages yet._

## Decisions

_No pages yet._

## Processes

_No pages yet._

## Sources

_No pages yet._

## Queries

_No pages yet._
```

写入空的 `log.md`：

```markdown
# Wiki Log

| Time | Operation | Details |
|------|-----------|---------|
| YYYY-MM-DD HH:MM | init | Wiki initialized |
```

写入 `overview.md`：

```markdown
---
title: Overview
category: entity
tags: [overview, index]
sources: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# Overview

_This page will be populated after the first ingest._

## Related

## Backlinks
```

写入 `_metadata.json`：

```json
{
  "version": 1,
  "wikiDir": "<absolute-path>",
  "sourceDir": null,
  "createdAt": "<ISO-timestamp>",
  "updatedAt": "<ISO-timestamp>",
  "sources": {},
  "pages": {
    "overview.md": {
      "title": "Overview",
      "category": "entity",
      "tags": ["overview", "index"],
      "outLinks": [],
      "inLinks": [],
      "updatedAt": "<ISO-timestamp>"
    }
  },
  "stats": {
    "totalPages": 1,
    "totalSources": 0,
    "totalLinks": 0,
    "lastIngest": null,
    "lastLint": null
  }
}
```

#### Step 5 — 智能检测源目录并首次 ingest

如果用户提供了 `dir` 参数：

1. **检测目录类型**：
   - 包含代码文件（`.py`, `.ts`, `.go`, `.rs`, `.java` 等）→ 代码项目
   - 包含 Markdown/文档文件但无代码 → 文档目录
   - 空目录或不存在 → 跳过 ingest

2. **代码项目**：自动触发 `ingest` 流程
3. **文档目录**：自动触发 `ingest` 流程（Agent 会智能提取 decisions、processes 等）
4. **空目录/不存在**：只完成 init，提示用户后续使用 `ingest` 添加内容

如果没有提供 `dir` 参数：只完成 init，不触发 ingest。

输出：
```
Wiki initialized at WIKI_DIR
   Directories: entities/, concepts/, comparisons/, people/, decisions/, processes/, sources/, queries/
   Files: _schema.md, index.md, log.md, overview.md, _metadata.json
```

如果触发了 ingest：
```
   Auto-ingesting from: SOURCE_DIR (detected: code project / document directory)
```

---

### Subcommand: `ingest <source>`

这是核心操作。单次 ingest 可能创建或更新 10-15 个 wiki 页面。

`<source>` 支持三种形式：
- **本地路径**：文件或目录（`/path/to/dir` 或 `./file.md`）
- **URL**：网页或 GitHub 仓库（`https://...`）
- **`--from-session`**：从当前 Claude 会话上下文提取

#### Step 1 — 读取 wiki 状态

读取以下文件（使用 Read 工具）：
- `_schema.md` — 了解 wiki 约定
- `index.md` — 了解已有页面
- `_metadata.json` — 已摄入文件的哈希

如果 `_metadata.json` 不存在，提示用户先运行 `/teamai-wiki init`。

如果 `_metadata.json` 解析失败（JSON 损坏），输出警告并尝试从 wiki 目录重建元数据。

#### Step 2 — 识别源类型并扫描

**如果 source 是本地路径**：

扫描文件，排除噪音和敏感文件：

```bash
find SOURCE_PATH -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.next/*' \
  -not -path '*/vendor/*' \
  -not -path '*/.venv/*' \
  -not -path '*/venv/*' \
  -not -path '*/.tox/*' \
  -not -path '*/.mypy_cache/*' \
  -not -path '*/.pytest_cache/*' \
  -not -path '*/target/*' \
  -not -path '*/.cache/*' \
  -not -name '*.pyc' \
  -not -name '*.pyo' \
  -not -name '.DS_Store' \
  -not -name '*.lock' \
  -not -name 'package-lock.json' \
  -not -name '.env' \
  -not -name '.env.*' \
  -not -name '*.pem' \
  -not -name '*.key' \
  -not -name '*.p12' \
  -not -name 'credentials.json' \
  -not -name '*.secret' \
  -not -name 'id_rsa*' \
  -not -name '*.pfx' \
  | head -2000 \
  | sort
```

对每个文件计算 SHA256 哈希：

```bash
sha256sum FILE_PATH
```

与 `_metadata.json` 中已记录的哈希比较：
- **哈希相同** -> 跳过（文件未变更）
- **哈希不同或新文件** -> 加入待处理列表

检测文件类型分布，判断是代码为主、文档为主还是混合：
- 代码文件：`.py`, `.ts`, `.js`, `.go`, `.rs`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.rb`, `.php`, `.swift`
- 文档文件：`.md`, `.txt`, `.rst`, `.adoc`, `.doc`, `.docx`, `.pdf`
- 配置文件：`.yaml`, `.yml`, `.json`, `.toml`, `.ini`, `.cfg`

如果总文件数为 0，输出 `No files found in SOURCE_PATH.` 并结束。
如果总文件数 > 500，提示用户指定子目录聚焦。

**如果 source 是 URL**：

1. 判断 URL 类型：
   - GitHub 仓库 URL（`github.com/org/repo`）→ 使用 `gh` CLI 克隆到临时目录，然后按本地路径处理
   - 普通网页 → 使用 WebFetch 工具获取内容
   - 无法访问（需要认证等）→ 输出错误提示，建议用户手动下载后用本地路径 ingest

2. WebFetch 获取的内容作为单个文档处理，计算内容 SHA256 作为去重依据

**如果使用 `--from-session`**：

1. 回顾当前会话上下文（不需要特殊工具，LLM 已有上下文）
2. 提取以下知识：
   - 解决了什么问题
   - 关键决策及原因
   - 发现的技术细节
   - 涉及的人员和职责
   - 可复用的模式或流程
3. 将提取的内容按分类组织，跳过 Step 2 的文件扫描，直接进入 Step 3

输出扫描摘要：
```
Scanning: SOURCE_PATH (type: code/docs/mixed/url/session)
   Total files: N
   New files: X
   Changed files: Y
   Unchanged (skipped): Z
```

如果所有文件都未变更，输出 `All N files unchanged, nothing to ingest.` 并追加 log 条目后结束。

#### Step 3 — 并行 Agent 分析

**IMPORTANT: 使用 Agent 工具进行并行分析。在单条消息中启动多个 Agent。**

将待处理文件分组（每组 3-8 个文件），为每组启动一个 Agent，prompt 如下：

```
你是一个 Wiki 知识提取 Agent。分析以下源文件，提取 wiki 页面所需的信息。

当前 wiki 已有页面列表：[从 index.md 获取]

待分析文件：
- file1.py
- file2.md
- ...

对每个文件，用 Read 工具读取内容，然后提取以下 8 类知识：

1. **实体（Entities）**：模块、类、服务、组件、工具 — 值得单独成页的东西
   - 名称（kebab-case 文件名）
   - 标题（人类可读）
   - 描述（2-4 句话）
   - 关键函数/方法列表（代码文件）或关键段落（文档文件）
   - 与其他实体的关系

2. **概念（Concepts）**：设计模式、架构原则、技术概念 — 通用的、可复用的思想
   - 名称
   - 描述
   - 涉及的实体

3. **对比（Comparisons）**：两个或多个事物的对比分析
   - 对比标题（A vs B 格式）
   - 对比维度
   - 结论/建议

4. **人员（People）**：文件中提到的团队成员、作者、负责人
   - 名称
   - 专长领域（从上下文推断）
   - 负责的模块/系统

4. **决策（Decisions）**：技术选型、架构决策、变更记录
   - 决策标题
   - 背景、选择、原因
   - 替代方案

5. **流程（Processes）**：工作流、SOP、部署/发布流程
   - 流程名称
   - 步骤描述
   - 前置条件

6. **关系（Links）**：各类页面之间的 [[wiki link]] 关系

7. **源摘要（Source Summary）**：每个文件的结构化摘要
   - 文件路径
   - 职责（一句话）
   - 关键内容
   - 依赖

注意：并非每种分类都会在每个文件中出现。只提取实际存在的内容，不要凭空创造。

输出格式为 Markdown，使用以下结构：

## New Pages
### [entity|concept|comparison|person|decision|process] page-name
Title: ...
Tags: ...
Content: ...
Related: [[link1]], [[link2]]

## Updated Pages
### page-name
Additions: ...（需要追加到已有页面的内容）

## Source Summaries
### file-path
Summary: ...
```

**--batch 模式**：减少 Agent 交互，每个 Agent 处理更多文件（最多 15 个），输出更精简。

**--from-session 模式**：不需要启动 Agent，主 LLM 直接从会话上下文提取知识，按上述 7 类组织输出。

#### Step 4 — 写入/更新 wiki 页面

收集所有 Agent 结果后：

**新页面**（使用 Write 工具）：
- 实体 -> `entities/<name>.md`
- 概念 -> `concepts/<name>.md`
- 对比 -> `comparisons/<name>.md`
- 人员 -> `people/<name>.md`
- 决策 -> `decisions/<name>.md`
- 流程 -> `processes/<name>.md`
- 源摘要 -> `sources/<name>.md`

每个页面使用标准格式（见"页面格式"小节），包含：
- YAML frontmatter（使用对应分类的模板字段）
- 正文
- Related 段落（出链）
- 空的 Backlinks 段落（下一步填充）

**更新已有页面**（使用 Edit 工具）：
- 追加新信息到正文
- 更新 Related 段落
- 更新 frontmatter 中的 `updated` 日期和 `sources` 列表

**命名规则**：
- 文件名 kebab-case：`message-builder.md`
- 避免过长文件名，最多 5 个单词
- 源摘要文件名由源路径生成：`hai_api/server.py` -> `hai-api-server-py.md`
- 人员页面用姓名拼音或英文名：`jeff-xu.md`
- 对比页面用 A-vs-B 格式：`sglang-vs-vllm.md`
- 决策页面用动词短语：`use-redis-for-cache.md`
- 流程页面用名词短语：`deploy-to-prod.md`

**避免重复页面**：创建前检查 index.md 和 _metadata.json，如果已有同名或近似页面，更新而非新建。

#### Step 5 — 更新 backlinks

扫描所有 wiki 页面，收集 `[[link]]` 引用关系。

对每个页面，更新其 `## Backlinks` 段落：

```markdown
## Backlinks

_Pages that link here:_
- [[overview]]
- [[hai-flow-engine]]
```

使用 Grep 工具搜索 `[[page-name]]` 的引用：

```
grep -r '\[\[page-name\]\]' WIKI_DIR/ --include='*.md'
```

**只更新新增/变更页面的 backlinks 以及引用了这些页面的已有页面的 backlinks。**

#### Step 6 — 更新 index.md

重新生成 `index.md`，按分类组织所有页面：

```markdown
# Wiki Index

> Auto-maintained by /teamai-wiki. Last updated: YYYY-MM-DD
> Pages: N | Links: M | Sources: K

## Entities

- [[message-builder]] — 消息构造器，hai-flow 核心组件
- [[hai-api-server]] — HAI API 主服务

## Concepts

- [[rollback-workflow]] — 回滚工作流设计模式

## Comparisons

- [[sglang-vs-vllm]] — 推理框架对比：吞吐、延迟、易用性

## People

- [[jeff-xu]] — GPU 推理服务架构、K8s 集群管理

## Decisions

- [[use-redis-for-cache]] — 选择 Redis 作为缓存层（2026-03）

## Processes

- [[deploy-to-prod]] — 生产环境部署流程

## Sources

- [[hai-api-server-py]] — hai_api/server.py

## Queries

_No queries yet._
```

#### Step 7 — 更新 overview.md

如果本次 ingest 带来了重大新信息（新页面 > 3 或首次 ingest），更新 `overview.md`：
- 综合描述项目/团队的整体架构和知识概览
- 列出核心模块及其关系
- 引用相关页面 `[[links]]`

#### Step 8 — 追加 log.md

追加一行操作日志：

```markdown
| YYYY-MM-DD HH:MM | ingest | Source: <path/url/session>, Type: <code/docs/mixed/url/session>, New pages: X, Updated: Y, Skipped: Z |
```

#### Step 9 — 更新 _metadata.json

更新以下字段：
- `sources`: 添加/更新已摄入文件的哈希和关联页面
- `pages`: 添加/更新页面的元数据（title, category, tags, outLinks, inLinks）
- `stats`: 更新统计数据
- `updatedAt`: 当前时间戳
- `sourceDir`: 如果未设置，记录源目录路径

输出 ingest 摘要：
```
Ingest complete
   Source: <path> (type: code/docs/mixed/url/session)
   New pages: X (entities: A, concepts: B, comparisons: C, people: D, decisions: E, processes: F, sources: G)
   Updated pages: Y
   Skipped: Z unchanged files
   Total wiki links: N
```

---

### Subcommand: `query "<question>"`

#### Step 1 — 读取 wiki 索引

读取 `index.md` 和 `_metadata.json`，了解 wiki 中有哪些页面。

如果 wiki 为空（无页面），提示用户先运行 `/teamai-wiki ingest`。

#### Step 2 — 定位相关页面

根据问题关键词，从 index.md 中识别 3-8 个最相关的页面。也可使用 Grep 搜索 wiki 页面内容：

```
grep -r -l 'keyword' WIKI_DIR/ --include='*.md'
```

#### Step 3 — 读取相关页面

使用 Read 工具读取定位到的 wiki 页面。沿着 `[[links]]` 扩展阅读范围（最多读取 12 个页面）。

#### Step 4 — 综合回答

基于 wiki 页面内容，回答用户问题：
- 引用来源页面：`（参见 [[page-name]]）`
- 如果 wiki 中没有足够信息，明确说明并建议 ingest 更多源文件
- 回答语言跟随用户问题的语言

#### Step 5 — 保存查询结果（如果 --save）

如果用户使用了 `--save` 参数：
- 生成文件名（根据问题关键词，kebab-case）
- 写入 `queries/<name>.md`，使用标准页面格式
- 更新 index.md 的 Queries 分类
- 更新 _metadata.json

#### Step 6 — 追加 log.md

```markdown
| YYYY-MM-DD HH:MM | query | Q: "<question>", Pages read: N, Saved: yes/no |
```

---

### Subcommand: `lint`

#### Step 1 — 读取所有 wiki 页面

读取 `_metadata.json` 获取页面列表，然后读取所有 wiki 页面内容。

如果页面较多（>30），使用 Agent 工具并行读取和分析。

#### Step 2 — 执行检查

检查以下问题：

**Broken Links**：
- 页面中的 `[[link]]` 指向不存在的页面

**Orphan Pages**：
- 没有任何其他页面链接到它（backlinks 为空，且不是 overview/index）

**Contradictions**：
- 不同页面对同一实体或概念的不同描述（需要 AI 判断）

**Missing Pages**：
- 被多个页面通过 `[[link]]` 引用但不存在的页面

**Stale Content**：
- 如果 `_metadata.json` 中记录的源文件哈希与当前文件不同，标记对应的 wiki 页面为 potentially stale

**Backlink Mismatches**：
- 实际引用关系与 Backlinks 段落不一致

**Empty Categories**：
- 目录存在但没有任何页面的分类（提示用户可以 ingest 相关内容）

#### Step 3 — 输出报告

```markdown
## Wiki Lint Report

### Broken Links (N)
- [[missing-page]] referenced in entities/message-builder.md:15

### Orphan Pages (N)
- entities/old-module.md — no incoming links

### Missing Pages (N)
- [[rabbitmq-integration]] — referenced by 3 pages, suggest creating it

### Stale Content (N)
- sources/server-py.md — source file changed since last ingest

### Backlink Mismatches (N)
- entities/foo.md — missing backlink from concepts/bar.md

### Empty Categories (N)
- people/ — no pages yet (consider: /teamai-wiki ingest team-roster or meeting notes)
- processes/ — no pages yet (consider: /teamai-wiki ingest runbooks or SOPs)

### Summary
Pages: N | Links: M | Issues: K
```

#### Step 4 — 追加 log.md

```markdown
| YYYY-MM-DD HH:MM | lint | Issues found: N (broken: A, orphan: B, missing: C, stale: D) |
```

---

### Subcommand: `status`

#### Step 1 — 读取 _metadata.json

读取 wiki 的 `_metadata.json`。如果不存在，提示先运行 `/teamai-wiki init`。

#### Step 2 — 输出统计

```
Wiki Status
   Wiki: WIKI_DIR
   Pages: N (entities: A, concepts: B, comparisons: C, people: D, decisions: E, processes: F, sources: G, queries: H)
   Links: M (avg N.N per page)
   Sources ingested: K files
   Last ingest: YYYY-MM-DD HH:MM
   Last lint: YYYY-MM-DD HH:MM (or "never")
   Recent log entries:
      - [time] ingest: ...
      - [time] query: ...
```

Also read the last 5 lines of `log.md` for recent activity.

---

### Subcommand: `export [--format md|html]`

将 wiki 导出为单个文件，方便分享给不用 Obsidian 的同事。

#### Step 1 — 读取 wiki 状态

读取 `_metadata.json` 和 `index.md`。如果 wiki 为空，提示先 ingest 内容。

#### Step 2 — 确定导出格式

- `--format md`（默认）：合并为单个 Markdown 文件
- `--format html`：生成带目录导航的 HTML 页面

#### Step 3 — 合并内容

**Markdown 格式**：

按 index.md 的顺序，将所有页面合并为一个文件：

```markdown
# Wiki Export: <wiki-name>

> Exported on YYYY-MM-DD | Pages: N | Links: M

---

## Table of Contents

[自动生成目录]

---

## Entities

### Message Builder

[页面正文，[[links]] 转换为 Markdown 内部锚点 [text](#anchor)]

---

### HAI API Server

[...]

---

## Concepts

[...]

## Comparisons

[...]

## People

[...]

## Decisions

[...]

## Processes

[...]
```

**HTML 格式**：

生成一个自包含的 HTML 文件：
- 左侧：目录导航（按分类折叠）
- 右侧：页面内容
- `[[links]]` 转换为页面内锚点跳转
- 基本样式（可读、打印友好）

#### Step 4 — 写入输出文件

- Markdown: `wiki/export/wiki-export-YYYY-MM-DD.md`
- HTML: `wiki/export/wiki-export-YYYY-MM-DD.html`

```bash
mkdir -p WIKI_DIR/export
```

输出：
```
Wiki exported to: <path>
   Format: md/html
   Pages included: N
   File size: X KB
```

#### Step 5 — 追加 log.md

```markdown
| YYYY-MM-DD HH:MM | export | Format: md/html, Pages: N, Output: <path> |
```

---

## Behavioral Rules

1. **每次操作前必须读取 `_schema.md`** — 确保遵循 wiki 约定。
2. **增量优先** — ingest 只处理新增和变更的文件，通过 SHA256 哈希判断。
3. **使用 Agent 工具并行分析** — 源文件分析必须并行，在单条消息中启动多个 Agent。
4. **保持页面精简** — 每个页面聚焦一个实体或概念，避免巨型页面。单页不超过 200 行。
5. **双向链接** — 每次创建/更新页面后，维护 Backlinks。
6. **Backlinks 段落由系统维护** — 不要手动编辑 Backlinks，它由 ingest 和 lint 自动更新。
7. **追加式 log** — log.md 只追加，不修改或删除历史记录。
8. **_metadata.json 是真相来源** — 页面列表、文件哈希、链接图都以此为准。
9. **命名一致性** — 文件名 kebab-case，标题 Title Case 或人类可读中文。
10. **幂等性** — 重复 ingest 同一源目录应产生相同结果（不会重复创建页面）。
11. **wiki 路径** — 读取 `<projectRoot>/.teamai/config.yaml` 的 `scope` 字段：project scope 用 `<projectRoot>/.teamai/wiki/`，user scope 用 `~/.teamai/wiki/`。与 teamai push/pull 的 `WikiHandler.getSharedWikiDir()` 逻辑对齐。
12. **Obsidian 兼容** — 所有 `[[links]]` 使用 Obsidian 格式，方便用户在 Obsidian 中直接浏览。
13. **语言** — Wiki 页面内容默认使用中文撰写，技术术语保持英文原文。
14. **智能分类** — LLM 根据内容自动判断页面归属哪个分类目录，无需用户指定。
15. **敏感文件排除** — ingest 时自动跳过 `.env`、`*.pem`、`*.key`、`credentials.json` 等可能含密钥的文件。
16. **容错处理** — `_metadata.json` 损坏时尝试从 wiki 目录重建；URL 无法访问时给出清晰错误提示。
17. **源类型自适应** — 代码目录和文档目录使用不同的分析策略，混合目录自动分组处理。
18. **团队同步** — wiki 页面通过 `teamai push/pull` 与团队共享。`_metadata.json` 不推送，每次 pull 后由本地重建。修改 wiki 后提醒用户运行 `teamai push` 同步到团队。
