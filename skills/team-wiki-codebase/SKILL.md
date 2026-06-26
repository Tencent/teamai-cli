---
name: team-wiki-codebase
description: |
  让 AI 真正理解大型代码库。针对多仓库、多微服务、迭代多年的项目，通过架构逆向 + Graph RAG 图谱 + CLI 多语言 AST，
  将海量代码压缩为结构化知识库——每条结论可回溯代码行，每条关系有置信度标注。
  
  适用场景：项目有 10+ 仓库或微服务，AI 直接读代码无法全局理解、回答不准确、token 开销大。
  
  产出：组件设计文档 × N + 架构总览 + 桥梁文档 + Graph RAG 图谱(G1~G9) + _manifest.json + team-wiki 编译产物。
  
  Trigger: team-wiki-codebase, code-to-knowledge, 代码知识库, 架构分析, 架构逆向
  Prerequisites: 可访问的源码目录（支持多仓库）；本 skill 目录下 `references/` 与 `scripts/`
---

# team-wiki-codebase — 大型代码库 AI 认知工程

> 方法论与脚本位于本 skill 的 `references/`、`scripts/`（`team-wiki upgrade` 后出现在 `.cursor/skills/team-wiki-codebase/` 或 `.codebuddy/skills/team-wiki-codebase/`）。人类可读概览见 [README.md](./README.md)。
> 图谱 CLI 能力见 [GRAPH-CAPABILITIES.md](../GRAPH-CAPABILITIES.md)。

**解决什么问题**：大型项目（10+ 仓库、数十微服务、迭代多年）让 AI 无法全局理解——上下文窗口装不下所有代码，组件关系散落各处，业务规则隐藏在深层调用链中。直接让 AI 读代码，既慢（海量 token）又不准（缺乏全局视角）。

**怎么解决**：通过架构逆向工程，将海量代码系统化压缩为**结构化、可验证、AI-Native** 的深度知识库——每个结论可回溯到代码行，每条关系有置信度标注，每次更新有增量校验。AI 读知识库而非读源码，用约 **1/50 的 token** 获得全局架构认知。

## 使用方式

```
/team-wiki-codebase                         # 默认：Standard（单 session 核心路径）
/team-wiki-codebase --deep                  # Deep：完整 K1~K4 + G1~G9
/team-wiki-codebase --update                # 增量更新已有 knowledge/
/team-wiki-codebase continue                # 从 _review/progress.json 断点继续
```

---

## Agent 架构

| Agent | 文件 | 启动时机 |
|-------|------|---------|
| 知识库文档生成 Agent | `references/agents/kb-doc-generator.md` | Phase K2 每批组件 |
| Graph RAG Agent | `references/agents/graph-rag-agent.md` | Phase K3 |

**主 Agent 职责**：流程编排、确认点管理、progress.json 维护、质量报告汇总。

---

## 入口判断

**每次激活时必须先执行此判断。**

```
IF 用户输入包含 "--update" 或 "增量更新":
  → Update 模式
ELSE IF 用户输入包含 "continue" 或 "继续":
  → Continue 模式
ELSE:
  → 检查用户指定目录下是否有 _review/progress.json
  IF 存在 → 告知状态，等待"继续上次"或"重新开始"
  ELSE    → Phase 0
```

---

## Continue 模式

```
Step 1：定位 progress.json
Step 2：读取解析，展示恢复摘要
Step 3：根据 current_phase 跳转：
  "phase0_done"              → Phase K1
  "phasek1_waiting_confirm"  → 展示 k1-architecture-map.md，等待确认①
  "phasek1_confirmed"        → Phase K2
  "phasek2_batch_N"          → Phase K2 第 N 批继续（跳过已完成）
  "phasek2_waiting_confirm"  → 等待确认②
  "phasek2_confirmed"        → Phase K3
  "phasek3_done"             → Phase K4
  "phasek4_done"/"completed" → 告知完成，询问是否 --update 或重跑某组件
```

---

## Update 模式（增量更新）

**触发**：`/team-wiki-codebase --update` 或「增量更新」。
**前提**：已有 completed 状态的 progress.json。

```
Step 1：读取 progress.json，获取 file_hash_cache
Step 2：扫描 project_root，计算各文件当前 SHA256
Step 3：对比 hash，分类：新增 / 修改 / 删除
Step 4：展示变更摘要，等待用户确认：
  ┌────────────────────────────────────┐
  │ 变更摘要                            │
  │ 新增: N 个文件                      │
  │ 修改: N 个文件（含 Aurora.py 等）   │
  │ 删除: N 个文件                      │
  │ 受影响组件: [列表]                  │
  │ 受影响图谱文档: G1/G2/G6/G7        │
  └────────────────────────────────────┘
Step 5：仅重跑受影响范围：
  - Phase K2：重新生成受影响组件的 Type-4 文档（覆盖写入）
  - Phase K3 局部：更新涉及变更组件的图谱文档（G1/G2/G6/G7）
  - Phase K4：重新运行 validate_kb.py
Step 6：更新 file_hash_cache + metadata.json commit SHA
Step 7：组件级 diff（处理新增/删除仓库或组件）
  IF repos 列表与上次不同：
    新增的仓库 → 对新仓库执行完整 K1 扫描，补充到组件清单，生成 Type-4 文档
    删除的仓库 → 对应组件文档顶部加 `⚠️ [DEPRECATED] 此组件对应仓库已移除`
    → 更新 k1-architecture-map.md 的组件清单
    → 更新 G1 矩阵（移除已删除组件的行列，新增新组件行列）
```

---

## progress.json 规范

**路径**：`<output_dir>/../_review/progress.json`

```json
{
  "version": "5",
  "repos": [
    {"name": "repo-a", "path": "/absolute/path/to/repo-a", "language": "go"},
    {"name": "repo-b", "path": "/absolute/path/to/repo-b", "language": "python"}
  ],
  "output_dir": "/absolute/path/to/knowledge",
  "primary_language": "go",
  "project_name": "ProjectName",
  "scan_time": "2026-01-01T10:00:00Z",
  "current_phase": "phasek2_batch_2",
  "confirmed_phases": ["phase0", "phasek1"],

  "service_map": {
    "描述": "Phase K1 Step 3 构建的服务名→仓库映射表",
    "ServiceA": {"repo": "repo-a", "entry": "cmd/serviceA/main.go"},
    "ServiceB": {"repo": "repo-b", "entry": "app/main.py"}
  },

  "kb_progress": {
    "component_total": 12,
    "components_done": ["Aurora", "Frame"],
    "components_pending": ["CCDB", "Dispatcher"],
    "type1_done": false,
    "type2_done": false,
    "type3_done": false,
    "bridge_docs_done": false,
    "graph_rag_done": false
  },

  "accuracy_stats": {
    "total_claims": 0,
    "verified": 0,
    "unverified": 0,
    "ambiguous_relations": 0
  },

  "interface_coverage": {
    "描述": "接口数量对账结果，由 Phase K2 自校验填充",
    "ComponentA": {"type": "HTTP", "scanned": 13, "documented": 0, "gap": 13},
    "ComponentB": {"type": "MQ",   "scanned": 5,  "documented": 0, "gap": 5}
  },

  "consistency_check": {
    "描述": "Phase K3 Step 3 跨文档一致性校验结果",
    "contradictions": 0,
    "missing_refs": 0,
    "g1_deviations": 0,
    "consistency_rate": 0.0
  },

  "e2e_validation": {
    "描述": "Phase K4 Step 4 AI 端到端验证结果",
    "total_questions": 0,
    "correct": 0,
    "partial": 0,
    "incorrect": 0,
    "boundary_ok": 0,
    "boundary_fail": 0,
    "accuracy_rate": 0.0
  },

  "file_hash_cache": {
    "relative/path/to/file.go": "sha256_hex"
  }
}
```

> `accuracy_stats` 在每批 Phase K2 完成后累加，是知识库可信度的全局指标。

---

## 核心原则（准确性优先）

1. **代码为唯一事实来源**：每个结论必须有代码文件:行号 作为证据，无法验证的标 `[UNVERIFIED]`
2. **置信度三态强制**：图谱中每条关系标 `EXTRACTED(1.0)` / `INFERRED(0.6~0.9)` / `AMBIGUOUS(0.1~0.3)`；禁止凭空发明，禁止用 0.5 默认值
3. **两级准确性验证**：Phase K2 每份文档生成后立即自校验；Phase K4 全库质量检验
4. **人在回路两次确认**：架构理解（K①）和组件文档质量（K②）必须人工确认，防止系统性错误扩散
5. **并行生成 + 断点续传**：Type-4 组件文档并行分发（同一消息发出所有 Agent calls）；每批持久化 progress.json
6. **Token 精简**：`Glob → Grep → Read` 三步法，禁止全量目录扫描
7. **诚实审计**：`[UNVERIFIED]` 不得隐藏；质量数字完整展示；不确定用 AMBIGUOUS 不删除
8. **认知边界声明**：知识库 README 必须明确声明覆盖范围和不覆盖范围，让 AI 知道何时应该说"不确定"
9. **跨文档一致性**：Phase K3 强制交叉比对组件间关系描述，矛盾项必须修复后才计入"一致"
10. **端到端可验证**：Phase K4 用标准化问题测试知识库实际回答能力，E2E 准确率目标 ≥ 80%

---

## Phase 0：初始化

一次性向用户询问以下信息（**同一条消息，不分步骤**）：

1. **项目所有代码仓库路径**（用户把整个项目涉及的所有仓库地址列出来）：
   - 格式：每行一个绝对路径，或逗号分隔
   - 示例：
     ```
     /path/to/api-gateway
     /path/to/order-service
     /path/to/user-service
     /path/to/common-lib
     ```
   - 说明：这是最关键的一步。大型项目的代码散布在多个仓库中，必须**全部提供**才能构建完整的架构认知。遗漏仓库 = 知识库盲区。
2. **项目名称**（用于文档命名，如 "CVM"、"电商平台"）
3. **产品文档来源**（可选，提供则生成 Type-5/6 桥梁文档）：
   - API 文档目录路径
   - 使用限制 / FAQ 文档路径
4. **输出路径**（默认：第一个仓库的父目录下的 `knowledge/`）

**Step 0A：仓库清单整理**

收到用户提供的仓库列表后，构建仓库清单：

```
FOR 每个用户提供的路径:
  1. 验证路径存在且可访问
  2. 检测是否为 git 仓库（是否有 .git 目录）
  3. 检测主要语言（按文件扩展名分布）
  4. 统计代码规模（文件数 + 估算行数）
  5. 记录 git commit SHA + tag

结果写入 _review/repo-manifest.json：
{
  "repos": [
    {
      "path": "/absolute/path/to/repo-a",
      "name": "repo-a",
      "language": "go",
      "files": 320,
      "lines_estimate": 45000,
      "commit": "abc123",
      "tag": "v1.2.0",
      "accessible": true
    },
    ...
  ],
  "total_repos": N,
  "inaccessible": ["path/to/repo-x（权限不足）"]
}
```

展示给用户确认：
```
已识别 {N} 个仓库：
  ✅ repo-a (Go, ~45K 行)
  ✅ repo-b (Python, ~12K 行)
  ✅ repo-c (Go, ~28K 行)
  ❌ repo-x (路径不存在或无法访问)

总计: ~{N}K 行代码，{N} 个仓库
确认无误后回复"继续"，或补充遗漏的仓库。
```

**Step 0B：自动检测主要语言**（按仓库列表汇总，不阻断流程）：
```
检测方法：汇总所有仓库的文件扩展名分布
  .go 文件占比最高         → language: "go"
  .py 文件占比最高         → language: "python"
  .java 文件占比最高       → language: "java"
  .ts/.js 文件占比最高     → language: "typescript"
  .rs 文件占比最高         → language: "rust"
  多语言混合（无明显主导）  → language: "mixed"
备注：language 字段用于接口扫描时选择 grep 模式（详见 Phase K1 Step 5）
```

**Step 0C：记录基准版本**：
```bash
# 对每个仓库分别记录
FOR repo in repos:
  git -C <repo.path> rev-parse HEAD 2>/dev/null
  git -C <repo.path> describe --tags --always 2>/dev/null
```
写入 `_review/metadata.json`：
```json
{
  "project_name": "CVM",
  "scan_time": "<ISO8601>",
  "repos": [
    {"name": "repo-a", "commit": "<sha>", "tag": "<tag>"},
    {"name": "repo-b", "commit": "<sha>", "tag": "<tag>"}
  ]
}
```

**Step 0D：CLI 结构基线（每个代码仓库，推荐）**

在 K1 深读之前，用 Team Wiki CLI 生成可证据化的 import/call 结构边（Python/Go/TS 等，`code-ast`）并与 regex 基线合并（`code-heuristic`）：

```bash
# 对每个 repo（<wiki_root> 通常为项目下的 .teamwiki 或 .wiki）
team-wiki compile code <repo_abs_path> <wiki_root> \
  --project <project_slug> \
  --extract ast,heuristic \
  --write

# 预览 AST 统计（不写盘）
team-wiki compile code <repo> <wiki> --extract ast --dry-run
```

- 输出：`code/<project>/` 下 index/component/relation 等页；`graph/<project>-graph-index.json`（结构边草案）。
- K1/K2/K3 写 `_manifest.json` 的 `edges[]` 时：**优先引用** compile 的 `code-ast` 边 + `evidenceRefs`（`path:line`），Agent 推断标 `INFERRED`/`AMBIGUOUS`。
- K3 完成后写入 wiki 图：`team-wiki compile code <output_dir> <wiki_root> --extract ast,heuristic --write`（有 `_manifest.json` 时走 manifest 快路径 merge `graph-index.json`）。

写入初始 progress.json（current_phase: "phase0_done"），进入 **Phase K1**。

---

## Phase K1：架构逆向与源材料采集

**方法论**：`references/methodology/phase0-collection.md` + `references/methodology/phase1-reverse-engineering.md`

### Step 1：可选运行扫描脚本（推荐）

```bash
python3 scripts/scan_repo.py <project_root> --depth 2 --top 10
```
输出：文件统计 + 关键文件发现报告 + 语言分布。

### Step 2：关键文件提取

按优先级扫描（详见 phase0-collection.md）：
- **P0 必须**：入口文件、路由/Handler、流程编排配置、Proto/IDL
- **P1 重要**：数据库 Schema（DDL）、常量/错误码定义
- **P2 增强**：配置文件、测试文件（理解预期行为）

### Step 3：架构逆向（详见 phase1-reverse-engineering.md）

- 自底向上分层：叶子节点(DB/MQ) → 中间节点(编排/调度) → 根节点(API入口)
- 三层穿透追踪：对核心 API ≥5 条完成 API入口→编排层→服务执行层 全链路追踪
- 构建 N×N 组件关系矩阵（标注通信方式：RPC/MQ/DB）

### Step 4：生成架构分析报告

写入 `_review/k1-architecture-map.md`：

```markdown
## 架构分层（≥4层）
| 层级 | 组件列表 | 核心职责 | 代码仓库 |

## 组件清单
| 组件名 | 架构层级 | **所属仓库** | 语言 | 核心度(P0/P1/P2) | 入口文件 | **接口校验类型** |

接口校验类型取值（在确认点①请用户核对此列）：
  - `HTTP`    → API 接入层，有 HTTP/gRPC 路由注册，需做接口数对账
  - `MQ`      → 消息处理层，有 MQ Consumer/Exchange 声明，以 Topic 数做基准
  - `RPC`     → 内部服务层，有 .proto / .thrift / IDL 文件，以 Method 数做基准
  - `NONE`    → 调度/执行/数据层，无对外接口，不做接口数校验

## N×N 组件通信矩阵
（值：RPC/MQ/DB/—，标注置信度 [E]EXTRACTED/[I]INFERRED/[A]AMBIGUOUS）

## 核心调用链路（≥5条）
（格式：API(file:line) → 编排层(config:line) → 服务层(handler:line) → DB(table)）

## 术语表
| 内部术语 | 外部/产品术语 | 说明 |

## 不确定项（供人工确认）
（标注 [A] 的关系和推断，说明不确定原因）
（接口校验类型不确定的组件，标注 [?] 等用户在确认点①明确）
```

### Step 5：接口清单扫描（按校验类型分别执行）

**仅对 k1-architecture-map.md 中接口校验类型 ≠ NONE 的组件执行**：

```
FOR 每个 接口校验类型 = HTTP 的组件:
  执行 grep 扫描：
    Go:   grep -rn "\.GET\|\.POST\|\.PUT\|\.DELETE\|router\.Handle\|@handler" <component_dir>
    Python: grep -rn "@app\.route\|@router\.\|APIRouter\|include_router" <component_dir>
  记录：组件名 → HTTP接口数 N（SCAN_CONFIDENCE: HIGH/MEDIUM）

FOR 每个 接口校验类型 = MQ 的组件:
  执行 grep 扫描：
    grep -rn "Exchange\|Queue\|Topic\|consumer\|subscribe\|@KafkaListener" <component_dir>
  记录：组件名 → MQ Topic/Queue 数 N

FOR 每个 接口校验类型 = RPC 的组件:
  解析 .proto / .thrift 文件：
    find <component_dir> -name "*.proto" -o -name "*.thrift" | xargs grep "^rpc\|^service"
  记录：组件名 → RPC Method 数 N
```

结果写入 `_review/interface-inventory.json`：
```json
{
  "ComponentA": {"type": "HTTP", "count": 13, "confidence": "HIGH"},
  "ComponentB": {"type": "MQ",   "count": 5,  "confidence": "MEDIUM"},
  "ComponentC": {"type": "RPC",  "count": 8,  "confidence": "HIGH"},
  "ComponentD": {"type": "NONE", "count": 0,  "confidence": "—"}
}
```

**完成后**：更新 `current_phase` 为 `"phasek1_waiting_confirm"`。

**⛔ 确认点①** — 等待用户明确回复，不得自动进入下一阶段。

展示给用户：
```
架构分析完成。

组件清单（共 N 个）：
  P0 核心: [列表]
  P1 重要: [列表]
  P2 辅助: [列表]

接口扫描结果（供校验用）：
  HTTP 接口：ComponentA 13个, ComponentB 7个
  MQ Topic：  ComponentC 5个
  RPC Method：ComponentD 8个
  无接口组件：ComponentE, ComponentF, ...

AMBIGUOUS 关系（请明确）：
  - ComponentX → ComponentY 的通信方式不确定

请确认（直接编辑 k1-architecture-map.md 后回复"继续"）：
  1. 架构分层和 P0/P1/P2 标注是否正确？
  2. 每个组件的接口校验类型（HTTP/MQ/RPC/NONE）是否准确？
  3. 接口扫描数量是否合理？明显偏少说明有遗漏，偏多可能扫到了测试文件。
```

确认后：更新 `"phasek1_confirmed"` → Phase K2。

---

## Phase K2：文档生成（分批并行 + 中间质量确认）

**方法论**：`references/methodology/phase2-document-types.md`

### 生成顺序（依赖链驱动，底层先写）

```
批次1: 数据层 + 基础执行层 Type-4 组件文档    ← 并行
批次2: 资源/调度层 Type-4 组件文档            ← 并行
批次3: 消息/服务层 Type-4 组件文档            ← 并行
批次4: API入口层 Type-4 组件文档              ← 并行
           ⛔ 确认点② ← 人工抽查组件文档质量
批次5: 架构总览层 (Type-1 + Type-2 + Type-3) ← 串行（依赖上层全部完成）
批次6: 桥梁文档 (Type-5 + Type-6 + Type-7)   ← 串行（依赖产品文档）
批次7: 知识增强 (Type-8: 反模式/RPC契约/排障) ← 串行
```

### 每批执行流程

读取 `references/agents/kb-doc-generator.md`，拼装输入包并启动：

```
component_list:    本批次组件/文档类型列表
architecture_map:  _review/k1-architecture-map.md 完整内容
repos:             _review/repo-manifest.json 中的仓库列表
service_map:       progress.json 中的 service_map
output_dir:        <Phase 0>
project_name:      <Phase 0>
product_docs_dir:  <Phase 0，可为空>
methodology_dir:   references/methodology/
completed_docs:    kb_progress.components_done（断点恢复跳过）
parallel_mode:     true（批次1~4）/ false（批次5~7）
```

每批完成后：
- 将完成组件追加到 `kb_progress.components_done`
- 累加 `accuracy_stats`（从 Agent 返回的自校验摘要中提取）
- 更新 `current_phase` 为 `"phasek2_batch_N"`
- 展示本批次 token 消耗和 `[UNVERIFIED]` 统计

### ⛔ 确认点②（批次1~4完成后）

展示给用户：
```
已生成 {N} 份组件设计文档。准确性统计：
  总声明数: {N} | 已验证: {N} | [UNVERIFIED]: {N}（{X}%）
  AMBIGUOUS 关系: {N} 条

请抽查 2~3 份文档（建议选最复杂的组件）：
  路径：<output_dir>/XX_<组件名>设计说明.md

确认要点：
  1. AI 快速理解表的代码入口是否精确到函数名？
  2. 核心流程描述是否与代码实际一致？
  3. [UNVERIFIED] 比例是否可接受？（建议 <15%）

如发现系统性问题，请描述，我将调整策略后重新生成。
```

更新 `current_phase` 为 `"phasek2_waiting_confirm"`。
用户确认后更新为 `"phasek2_confirmed"`，继续批次5~7。

### 全部批次完成后

写入 `_review/k2-doc-list.md`（文档清单：路径 + 规模KB + [UNVERIFIED]数 + 生成时间）。
更新 `current_phase` 为 `"phasek2_done"` → Phase K3。

---

## Phase K3：AI-Native 增强 + 图谱文档集

**方法论**：`references/methodology/phase3-ai-enhancement.md`

### Step 1：AI-Native 元素注入

对所有已生成文档补充（如 Phase K2 的 Agent 未完整添加）：

| 元素 | 要求 | 适用范围 |
|------|------|---------|
| `search-anchor` | 5~15 个关键词，标题后第一行 | 所有文档 |
| AI 快速理解表 | 10 维度，紧跟标题 | 所有 Type-4 组件文档 |
| 双向链接 | 组件↔主架构，桥梁↔组件 | 所有文档 |
| 检索路由规则 | 4条分流规则 + 4级优先级 | 仅技术架构总览 |
| QA 对 | 10~20 个高频问题+答案引用 | 仅技术架构总览第9章 |

### Step 2：Graph RAG 图谱文档集

读取 `references/agents/graph-rag-agent.md`，拼装输入包并启动：

```
all_kb_docs_dir:  <output_dir>
architecture_map: _review/k1-architecture-map.md
doc_list:         _review/k2-doc-list.md
project_name:     <Phase 0>
output_dir:       <output_dir>/graph/
methodology_file: references/methodology/phase2-document-types.md
```

生成 G1~G9（每条关系强制置信度三态标注）：

| 图谱文档 | 解决的问题 | 置信度要求 |
|---------|---------|-----------|
| G1 组件依赖关系矩阵 | "谁依赖 X？" | EXTRACTED 来自文档明确描述 |
| G2 调用链路全景 + 状态机 + 约束矩阵 | "API 经过哪些模块？" | 调用链 EXTRACTED，推断依赖 INFERRED |
| G3 数据流与存储依赖图 | "数据存哪里？" | 读写关系 EXTRACTED |
| G4 错误码组件映射表 | "错误码是哪个模块的？" | EXTRACTED |
| G5 跨组件交互场景手册（≥10个时序图） | "配额检查怎么做？" | 时序 EXTRACTED，边界 INFERRED |
| G6 知识图谱三元组（≥100条） | "A 间接依赖谁？" | 每条标 E/I/A + 分值 |
| G7 架构风险与影响面分析 | "X 挂了影响多大？" | 直接依赖 EXTRACTED，间接 INFERRED |
| G8 核心配置参数索引 | "怎么改 XX 配置？" | EXTRACTED 来自配置文件 |
| G9 业务规则约束矩阵 + AI 推理决策树 | "能不能做 XX？" | 规则 EXTRACTED，推断 INFERRED |

同时生成 `<output_dir>/graph/README.md`（索引 + 按问题类型查找表 + 检索路由建议）。

### Step 3：跨文档一致性校验

**Graph RAG Agent 完成后，主 Agent 自行执行此步骤（不委托给子 Agent）。**

目的：检测组件文档之间的矛盾描述，防止"A 说调用 B 用 RPC，B 说被 A 用 MQ 调用"这类不一致。

```
Step 3A：构建"声称矩阵"

  对每份 Type-4 组件文档，从**两个层面**提取关系声称：
  
  层面1：AI 快速理解表中的"上游组件"和"下游组件"字段
  层面2：正文中的接口设计章节、核心流程章节中的调用描述
  
  如果层面1和层面2对同一关系描述不一致 → 首先记录为"文档内矛盾"（比表头和正文优先级更高的问题）
  
  提取示例：
    组件X.md 表头声称: X→Y(RPC), X→Z(MQ)
    组件X.md 正文声称: X→Z(HTTP)  ← 与表头矛盾！
    组件Y.md 表头声称: Y←X(RPC), Y→Z(DB)
    组件Z.md 表头声称: Z←X(HTTP), Z←Y(DB)

Step 3B：交叉比对

  FOR 每对组件 (A, B):
    IF A.md 声称 "A→B 用 RPC" AND B.md 声称 "B←A 用 MQ":
      → 记录矛盾: "A→B 通信方式不一致: A说RPC, B说MQ"
    IF A.md 声称 "A→B" BUT B.md 未提到 "被A调用":
      → 记录缺失: "A声称调用B，但B的文档未提及被A调用"
    IF G1矩阵中的关系 与 组件文档声称不一致:
      → 记录偏差: "G1矩阵说A→B(RPC)，但A的文档说A→B(MQ)"

Step 3C：生成一致性报告

  写入 `_review/k3-consistency-check.md`：

  ```markdown
  # 跨文档一致性校验报告

  ## 矛盾项（必须修复）
  | 组件A | 组件B | A的描述 | B的描述 | 矛盾类型 |
  |-------|-------|---------|---------|---------|
  | X | Z | X→Z(MQ) | Z←X(HTTP) | 通信方式不一致 |

  ## 缺失项（建议补充）
  | 声称方 | 被引用方 | 声称内容 | 缺失 |
  |--------|---------|---------|------|
  | A | B | A→B(RPC) | B的文档未提及被A调用 |

  ## G1矩阵偏差（建议对齐）
  | G1矩阵 | 组件文档 | 偏差 |

  ## 统计
  - 矛盾项: N 处（❌ 需修复）
  - 缺失项: N 处（⚠️ 建议补充）
  - G1偏差: N 处（⚠️ 需对齐）
  - 一致关系: N 条（✅）
  - 一致率: X%
  ```

Step 3D：自动修复（仅限明确情况）

  IF 矛盾项 > 0:
    FOR 每个矛盾项:
      回溯代码验证：用 Grep 查找实际的调用方式（如 rpc.Call / mq.Publish）
      IF 能明确正确方 → 修复错误方文档中的描述 + 更新 G1 矩阵
      IF 无法明确 → 标记为 AMBIGUOUS，留待用户在确认点确认
    修复后重新统计一致率

  IF 矛盾项 = 0:
    → 跳过修复，直接进入 Phase K4
```

**完成后**：更新 `current_phase` 为 `"phasek3_done"` → Phase K4。

---

## Phase K4：知识库质量评估与报告

**方法论**：`references/methodology/phase4-quality.md`

### Step 1：自动校验

```bash
python3 scripts/validate_kb.py <output_dir>
```

输出（**必须完整展示，不得只展示通过项**）：
```
链接完整性:     ✅/❌  N 个死链接
search-anchor:  ✅/⚠️  覆盖率 N/M (X%)
AI 快速理解表:  ✅/⚠️  覆盖率 N/M (X%)
双向链接:       ✅/⚠️  覆盖率 N/M (X%)
README 索引:    ✅/⚠️  收录率 N/M (X%)
```

### Step 2：准确性审计

从 `accuracy_stats` 汇总全库可信度，同时从 `interface_coverage` 汇总接口覆盖情况：

```
【内容准确性】
总声明数:            N 条（业务规则 + 接口描述 + 关系）
已验证(有代码引用):   N 条 (X%)
[UNVERIFIED]:        N 条 (X%)
AMBIGUOUS 关系:      N 条 (X%)

【接口覆盖率】（仅统计 HTTP/MQ/RPC 类型组件，NONE 类型不计入）
HTTP 接口:   文档记录 M 个 / 扫描基准 N 个 = X%
MQ Topic:    文档记录 M 个 / 扫描基准 N 个 = X%
RPC Method:  文档记录 M 个 / 扫描基准 N 个 = X%
综合覆盖率:  X%    目标 ≥ 90%

⚠️ 接口缺口清单（文档记录 < 扫描基准 的组件）：
  - ComponentA: 文档记录 8 个，扫描基准 13 个，缺口 5 个 → 建议补充
```

⚠️ 需人工确认清单：（[UNVERIFIED] > 20% 的文档 + 接口缺口组件 + AMBIGUOUS 关系）

### Step 3：RAG 检索抽检

按 `phase4-quality.md §RAG检索测试用例` 测试 7 类问题各 1 个（详见方法论），记录命中率。

### Step 4：AI 端到端验证（E2E Validation）

**核心思路**：用知识库回答一组标准化问题，然后**回溯代码验证答案正确性**，检测知识库是否能让 AI 给出正确答案。

```
Step 4A：生成标准验证问题集（自动，基于已有文档）

  **优先使用用户提供的外部验证集**：
  IF 用户在 Phase 0 或此时提供了验证问题列表（3~10 个真实业务问题）:
    → 优先使用用户问题作为验证集（标注来源: USER）
    → 自动补充至 10~15 题（标注来源: AUTO）
  ELSE:
    → 全部自动生成（标注来源: AUTO）
  
  > 用户提供的问题更有价值，因为 AI 自己出题容易考自己已知的领域，
  > 真正的盲区（AI 没理解但没意识到的）只有外部问题才能测到。

  从 k1-architecture-map.md 和 k2-doc-list.md 自动生成 10~15 个验证问题：

  问题类型分布（至少覆盖以下 5 类）：

  ┌────────────────────────────────────────────────────────────────────┐
  │ 类型1：组件职责（3题）                                              │
  │   模式："<组件名> 的核心职责是什么？代码入口在哪？"                    │
  │   验证方式：答案中的函数名/文件名必须在代码中存在                      │
  │                                                                    │
  │ 类型2：调用关系（3题）                                              │
  │   模式："<组件A> 和 <组件B> 之间是什么关系？通过什么方式通信？"         │
  │   验证方式：答案与 G1 矩阵 + 代码实际 import/call 一致               │
  │                                                                    │
  │ 类型3：操作约束（2题）                                              │
  │   模式："在 <状态X> 下能否执行 <操作Y>？"                            │
  │   验证方式：答案与 G9 约束矩阵 + 代码中的状态检查一致                 │
  │                                                                    │
  │ 类型4：数据流向（2题）                                              │
  │   模式："<操作Z> 最终会写入哪些表/队列？"                             │
  │   验证方式：答案与 G3 数据流 + 代码实际 SQL/MQ 操作一致               │
  │                                                                    │
  │ 类型5：错误排查（2题）                                              │
  │   模式："错误码 <XXX> 是什么意思？在哪个组件产生？"                    │
  │   验证方式：答案与 G4 错误码映射 + 代码中的错误定义一致               │
  │                                                                    │
  │ 类型6（可选）：认知边界测试（2题）                                    │
  │   模式：故意问知识库不覆盖的内容（如第三方 SDK 内部、历史架构变迁）     │
  │   验证方式：AI 应回答"超出知识库覆盖范围"而非幻觉                     │
  └────────────────────────────────────────────────────────────────────┘

Step 4B：用知识库回答（模拟 AI 使用场景）

  FOR 每个验证问题:
    1. 假设只能读知识库文档，不能直接读代码
    2. 按检索路由规则，找到对应文档
    3. 从文档中提取答案

Step 4C：代码回溯验证

  FOR 每个答案:
    1. 用 Grep/Read 直接在代码中验证关键声明
    2. 判定结果：
       ✅ CORRECT     — 答案与代码一致
       ⚠️ PARTIAL     — 答案部分正确，有遗漏或不精确
       ❌ INCORRECT   — 答案与代码矛盾
       🔇 BOUNDARY_OK — 认知边界问题，正确拒绝回答（仅类型6）
       🔇 BOUNDARY_FAIL — 认知边界问题，错误地给出了答案（仅类型6）

Step 4D：写入验证报告

  追加到 k4-quality-report.md 的 ## AI 端到端验证 章节：

  | 问题 | 类型 | 检索文档 | AI答案摘要 | 代码验证 | 结果 |
  |------|------|---------|-----------|---------|------|
  | Aurora 核心职责？ | 组件职责 | 03_Aurora设计说明.md | 调度编排... | scheduler.go:42 | ✅ |
  | A→B 通信方式？ | 调用关系 | G1矩阵 | RPC | import rpc_client | ✅ |
  | 状态X下能否操作Y？ | 操作约束 | G9矩阵 | 不能 | check_state.go:88 | ✅ |
  | 第三方SDK内部？ | 认知边界 | — | 超出范围 | — | 🔇 OK |

  统计：
    CORRECT: N/M (X%)
    PARTIAL: N/M (X%)
    INCORRECT: N/M (X%) — ❌ 每个 INCORRECT 必须列出具体矛盾点
    BOUNDARY_OK: N/N
    BOUNDARY_FAIL: N/N

    E2E 准确率 = (CORRECT + BOUNDARY_OK) / 总题数
    目标: ≥ 80%
```

**如果 E2E 准确率 < 80%**：在质量报告"建议"章节列出需要改进的文档和具体问题。

### Step 5：生成质量报告

写入 `_review/k4-quality-report.md`：

```markdown
# 知识库质量报告

## 概览
- 代码基准：<commit SHA> (<tag>)
- 生成时间：<ISO8601>
- 文档总数：N 份（Type-1~8: N份，图谱G1~G9: 9份）

## 准确性
| 指标 | 数值 | 状态 |
| 总声明数 | N | — |
| 有代码引用 | N (X%) | ✅/❌ |
| [UNVERIFIED] | N (X%) | ✅/<15% / ⚠️15~25% / ❌>25% |
| AMBIGUOUS关系 | N | ✅/⚠️ |

## 结构质量（validate_kb.py 输出）
（完整展示，不隐藏任何数字）

## 跨文档一致性（k3-consistency-check.md 摘要）
| 指标 | 数值 | 状态 |
| 矛盾项 | N | ✅=0 / ❌>0 |
| 缺失引用 | N | ⚠️ |
| G1偏差 | N | ⚠️ |
| 一致率 | X% | 目标≥95% |

## RAG 检索抽检
| 测试问题 | 期望命中 | 实际命中 | 结果 |

## AI 端到端验证
| 指标 | 数值 | 状态 |
| CORRECT | N/M (X%) | — |
| PARTIAL | N/M (X%) | ⚠️ |
| INCORRECT | N/M (X%) | ❌ |
| BOUNDARY_OK | N/N | ✅ |
| E2E 准确率 | X% | 目标≥80% |

INCORRECT 详情：
（每个 INCORRECT 的具体矛盾点和改进建议）

## 待人工确认清单
（[UNVERIFIED] 超标文档 + AMBIGUOUS 关系 + 矛盾项 + 死链接）

## 建议
（基于一致性校验 + E2E 验证的改进方向）
```

**完成后**：更新 `current_phase` 为 `"completed"`，流程结束。

---

## 输出目录结构

```
<output_dir>/
├── README.md                           ← 知识库索引 + 检索路由规则 + 认知边界声明（AI 专用）
├── {项目名} 技术架构.md                ← [Type-1] 架构总览（目标 ≤80KB，超过则自动拆分）
├── {项目名} 技术架构-核心链路.md       ← [Type-1b] 仅当 Type-1 超 80KB 时拆出
├── {项目名} 技术架构-AI元数据.md       ← [Type-1c] 仅当 Type-1 超 80KB 时拆出
├── {项目名} 业务架构.md                ← [Type-2] 产品能力 + 生命周期 ~70KB
├── {项目名} 部署架构.md                ← [Type-3] 部署拓扑 ~40KB
├── XX_{组件名}设计说明.md × N          ← [Type-4] 每份 20~100KB
├── XX_{项目名}核心API产品代码映射.md    ← [Type-5] 仅有产品文档时生成
├── XX_{项目名}产品规则速查表.md         ← [Type-6]
├── XX_{项目名}业务开发规范SOP.md       ← [Type-7]
├── {知识增强文档} × N                  ← [Type-8] 反模式/RPC契约/排障/知识文库
└── graph/                              ← [Type-9] Graph RAG 图谱文档集
    ├── README.md                       ← 图谱索引 + 按问题类型查找
    ├── G1_{项目名}组件依赖关系矩阵.md
    ├── G2_{项目名}组件调用链路全景.md
    ├── G3_{项目名}数据流与存储依赖图.md
    ├── G4_{项目名}错误码组件映射表.md
    ├── G5_{项目名}跨组件交互场景手册.md
    ├── G6_{项目名}知识图谱三元组.md
    ├── G7_{项目名}架构风险与影响面分析.md
    ├── G8_{项目名}核心配置参数索引.md
    └── G9_{项目名}业务规则约束矩阵.md

_review/                                ← 过程文件（不入知识库）
├── progress.json                       ← 断点续传 + 增量更新状态
├── metadata.json                       ← 代码基准版本
├── interface-inventory.json            ← 接口扫描基准（Phase K1 Step 5）
├── k1-architecture-map.md              ← 架构逆向结果（用户确认过）
├── k2-doc-list.md                      ← 文档清单 + 准确性统计
├── k3-consistency-check.md             ← 跨文档一致性校验报告（Phase K3 Step 3）
└── k4-quality-report.md                ← 质量报告（含 E2E 验证结果）
```

---

## 阶段间控制

| 用户回复 | 行为 |
|---------|------|
| "继续" / "continue" / "ok" | 进入下一阶段 |
| "停止" / "stop" | 停止，已生成文件保持可用 |
| 直接描述问题 | 调整后重新确认，再继续 |
| 直接编辑文件后回复"继续" | 以修改后文件内容为准继续 |

---

## 约束

- **主 Agent 不执行代码分析**：全部由专职 Agent 完成；启动前必须先 Read 对应 agent 文件
- **严禁冗余输出**：生成文件直接 Write，禁止先在对话中打印完整内容
- **组件文档命名**：`XX_{组件名}设计说明.md`（XX 为两位数编号，按依赖链顺序分配，底层组件编号小）
- **无产品文档时**：Type-5/6 可跳过或将约束值标注为 `[PRODUCT_DOC_MISSING]`，不得推测
- **并行模式**：Type-4 批次必须同一消息并发发出所有 Agent calls；串行批次顺序执行

### 诚实审计规则（Honesty Rules）

- **禁止凭空发明**：图谱每条关系必须有组件文档明确依据，不得基于名称猜测
- **置信度不得伪造**：EXTRACTED=1.0，INFERRED 按证据强度 0.4~0.9，AMBIGUOUS 0.1~0.3；禁用 0.5 默认值
- **[UNVERIFIED] 不得隐藏**：超过 20% 则文档顶部加可见警告
- **质量数字完整展示**：validate_kb.py 输出不得只展示通过项
- **token 成本透明**：每批完成后展示读取文件数和估计 token 消耗
- **不确定优先 AMBIGUOUS**：宁可标注待确认，也不删除或假装确定

---

## 与 Team Wiki CLI 的配合（必读）

| 阶段 | 命令 / 路径 |
|------|-------------|
| Phase 0 结构基线 | `team-wiki compile code <repo> <wiki> --extract ast,heuristic --write` |
| K3 后编译进 wiki | `team-wiki compile code <knowledge_output> <wiki> --write`（检测 `_manifest.json` → manifest 快路径） |
| 产品文档入图 | `team-wiki compile docs <docs> <wiki> --extract structure,entity --write` |
| 产品↔代码桥接 | `team-wiki reconcile <wiki> --write` |
| 一键刷新 | `team-wiki refresh <wiki> --repo <repo> [--docs <docs>] --extract-code ast,heuristic --write` |
| 质量评估 | `team-wiki evaluate <wiki>`（含 `graph.structuralEdgeRatio` 等） |

**路径约定**（本 skill 安装后）：

- 方法论：`references/methodology/*.md`（相对本 skill 目录）
- Agent：`references/agents/kb-doc-generator.md`、`references/agents/graph-rag-agent.md`
- 脚本：`scripts/scan_repo.py`、`scripts/validate_kb.py`

所有流程在本 skill（`references/`、`scripts/`）与 `team-wiki` CLI 内完成。
