# Graph RAG Agent

## 职责

从已生成的知识库组件文档中抽取跨组件关系信息，生成结构化图谱文档集（G1~G9），解决 RAG 检索在"跨组件关系查询"场景下的信息分散问题。

**此 Agent 在 Phase K3 中被主 Agent 单次串行启动。**

## 输入包

```
all_kb_docs_dir:  知识库输出根目录（包含所有 Type-1~8 文档）
architecture_map: _review/k1-architecture-map.md 完整内容
doc_list:         _review/k2-doc-list.md（文档清单）
project_name:     项目名称（用于文档命名）
output_dir:       图谱文档输出目录（<all_kb_docs_dir>/graph/）
methodology_file: references/methodology/phase2-document-types.md §Type-9 内容
```

## 执行步骤

### Step 1：关系抽取

扫描 `all_kb_docs_dir` 下所有组件文档（Type-4），从 AI 快速理解表和正文中提取：

```
扫描维度:
├── 调用关系 (上游组件→本组件, 本组件→下游组件, 通信方式)
├── 存储依赖 (读写了哪些 DB/Redis/MQ)
├── 消息拓扑 (发布/消费的 Exchange/Topic/Queue/RoutingKey)
├── 状态流转 (操作→起始状态→中间状态→终态, 状态字段值)
├── 约束条件 (操作→前置状态要求→硬件约束→计费约束→配额)
├── 配置映射 (配置项→影响行为→变更风险)
└── 错误码归属 (错误码段→组件→排查方向)
```

**置信度三态标注**（每条关系/三元组必须标注，不得省略）：

| 标签 | 含义 | 来源依据 | 置信度分值 |
|------|------|---------|-----------|
| `EXTRACTED` | 组件文档中明确描述的关系（如"上游组件: Aurora(RPC)"）| 代码/文档显式记录 | 1.0 |
| `INFERRED` | 合理推断的关系（如架构图中隐含的依赖链）| 结构性证据 + 合理推断 | 0.6~0.9 |
| `AMBIGUOUS` | 存在不确定性的关系，需人工确认 | 弱证据或相互矛盾 | 0.1~0.3 |

> ⚠️ **禁止用 0.5 作为默认分值**。每条关系都要独立评估：有直接代码引用的 INFERRED 用 0.8~0.9，仅靠命名推断的用 0.6~0.7，真正模糊的才用 AMBIGUOUS。

构建中间数据结构（内存，不写文件）：
- `relations[]`：(from, to, protocol, scenario, **confidence: EXTRACTED|INFERRED|AMBIGUOUS**, **confidence_score: 0.1~1.0**)
- `state_transitions[]`：(entity, from_state, to_state, trigger_op, state_field_value, **confidence**, **confidence_score**)
- `constraints[]`：(operation, state_req, hardware_req, billing_req, quota_req, **confidence**, **confidence_score**)
- `config_items[]`：(key, default, component, behavior, change_risk, effect_mode)
- `error_codes[]`：(code_range, component, meaning, debug_direction)
- `triples[]`：(subject, predicate, object, protocol, scenario, **confidence: EXTRACTED|INFERRED|AMBIGUOUS**, **confidence_score: 0.1~1.0**)

### Step 2：逐份生成图谱文档

按顺序生成 G1~G9（串行，每份完成后立即 Write）：

---

#### G1：组件依赖关系矩阵

```markdown
# {project_name} 组件依赖关系矩阵
<!-- search-anchor: 组件依赖, 依赖矩阵, 通信方式, 调用关系 -->
## 🤖 AI 快速理解要点
| 文档定位 | 解决"谁依赖 X？X 依赖谁？"的检索问题 |
| 核心价值 | N×N 通信矩阵 + 正向/反向依赖索引 |
| 使用场景 | 变更影响评估、服务依赖梳理、架构重构规划 |

## N×N 组件通信矩阵
（行：调用方，列：被调方，值：`RPC`/`MQ`/`DB`/`—`，括号内标注置信度标签）
示例：`RPC[E]` = EXTRACTED，`MQ[I:0.8]` = INFERRED 0.8，`RPC[A]` = AMBIGUOUS

## 正向依赖索引（A 依赖谁）
| 组件 | 依赖组件 | 通信方式 | 置信度 | 典型场景 |

## 反向依赖索引（谁依赖 A）
| 组件 | 被依赖来自 | 通信方式 | 置信度 | 典型场景 |

## 外部服务依赖
| 外部服务 | 被哪些组件依赖 | 通信方式 | 置信度 | 降级策略 |

## 置信度统计
| 标签 | 条数 | 说明 |
|------|------|------|
| EXTRACTED | N | 来自代码/文档直接描述 |
| INFERRED | N | 合理推断，标注分值 0.6~0.9 |
| AMBIGUOUS | N | 不确定，需人工确认 |
```

---

#### G2：组件调用链路全景 + 状态机

```markdown
# {project_name} 组件调用链路全景与状态机
<!-- search-anchor: 调用链路, 状态机, 端到端链路, API链路 -->
## 🤖 AI 快速理解要点
| 文档定位 | 解决"API X 经过哪些模块？实体状态如何流转？"的检索问题 |
| 核心价值 | 核心API端到端链路 + 完整状态机 + 操作-状态约束矩阵 |

## 核心 API 端到端调用链路
（对每个核心 API，用标准调用链格式 + mermaid 时序图）

## 核心实体完整状态机
（mermaid stateDiagram-v2，标注状态字段值和触发操作）

## 操作-状态约束速查矩阵
| 操作 \ 当前状态 | 状态A | 状态B | ... |
（✅ 允许 / ❌ 禁止 / ⚠️ 有条件）

## AI 状态判断推理规则
（mermaid graph TD 决策树）
```

---

#### G3：数据流与存储依赖图

```markdown
# {project_name} 数据流与存储依赖图
<!-- search-anchor: 数据流, 存储依赖, MQ拓扑, 缓存 -->
## 存储系统依赖矩阵
| 组件 | MySQL | Redis | MQ | 对象存储 | 其他 |

## MQ 队列拓扑
| Exchange/Topic | Routing Key | 生产者 | 消费者 | 消息含义 |

## 缓存策略矩阵
| 组件 | 缓存键模式 | 过期时间 | 失效策略 |
```

---

#### G4：错误码组件映射表

```markdown
# {project_name} 错误码组件映射表
<!-- search-anchor: 错误码, 错误映射, InvalidParameter -->
## 错误码段分配
| 错误码范围/前缀 | 归属组件 | 含义范围 |

## 外部→内部错误码映射
| 外部错误码 | 内部组件 | 内部含义 | 排查方向 |
```

---

#### G5：跨组件交互场景手册

对每个核心业务场景，生成：
```markdown
## 场景N：{场景名称}
<!-- 典型场景：创建/删除/修改资源、配额检查、计费、状态变更等 -->
```mermaid
sequenceDiagram
    actor User
    participant A as {组件A}
    participant B as {组件B}
    ...
```
**正常流程**：步骤描述
**异常处理**：各异常分支
```

要求：≥10 个场景，覆盖主要写操作和关键读操作。

---

#### G6：知识图谱三元组

```markdown
# {project_name} 知识图谱三元组
<!-- search-anchor: 知识图谱, 三元组, 多跳推理 -->

## Ontology 定义
### 实体类型: Service, Handler, Config, Table, Queue, API, ErrorCode
### 关系类型: CALLS, PUBLISHES, CONSUMES, READS, WRITES, CONFIGURES, MAPS_TO

## 显式三元组（≥100条）
| Subject | Predicate | Object | Protocol/Scenario | Confidence | Score |

> 每条三元组的 Confidence 必须是 `EXTRACTED` / `INFERRED` / `AMBIGUOUS`，Score 不得省略，不得用 0.5 作默认值。

## 多跳依赖路径索引
| 查询模式 | 路径示例 |
| "A 最终写入哪些表？" | A→(CALLS)→B→(WRITES)→Table |

## 反向可达索引
| 目标节点 | 可达路径 |
```

---

#### G7：架构风险与影响面分析

```markdown
# {project_name} 架构风险与影响面分析
<!-- search-anchor: 架构风险, 爆炸半径, 影响面 -->
## 组件风险等级总表
| 组件 | 风险等级 | 爆炸半径 | 备注 |
（🔴高/🟡中/🟢低）

## 关键组件爆炸半径分析（≥3个高风险组件）
组件 X 故障时的影响链路分析

## 关键路径与瓶颈识别
## 聚类分析（哪些组件形成强耦合簇）
## 变更风险评估矩阵
```

---

#### G8：核心配置参数索引

```markdown
# {project_name} 核心配置参数索引
<!-- search-anchor: 配置参数, 配置索引, 配置变更 -->
## 分层配置架构图（mermaid）

## 各层配置参数表
| 配置项 | 所属组件 | 默认值 | 影响行为 | 变更风险 | 生效方式 |
（变更风险: 🟢低/🟡中/🔴高；生效方式: 热生效/需重启）

## 配置变更影响面速查
| 变更类型 | 影响范围 | 生效方式 | 回滚策略 |

## AI 回答"怎么修改 XX 配置"时必须同时告知：
1. 配置文件位置
2. 影响范围
3. 生效方式
4. 回滚策略
5. 变更风险
6. 是否需要灰度
```

---

#### G9：业务规则约束矩阵

```markdown
# {project_name} 业务规则约束矩阵
<!-- search-anchor: 业务规则, 约束矩阵, 操作约束, AI推理 -->
## 操作前置条件矩阵
| 操作 | 状态要求 | 硬件约束 | 计费约束 | 配额约束 | 其他约束 |

## 约束决策树（mermaid graph TD）
（覆盖主要操作的多层约束检查流程）

## 特殊实例类型约束汇总
| 实例/资源类型 | 限制操作 | 原因 |
（✅允许 / ❌禁止 / ⚠️有条件）

## AI 推理规则速查
（mermaid 流程图：AI 判断"某操作能否执行"时的逐层检查顺序）
```

---

### Step 3：生成图谱目录 README

写入 `{output_dir}/README.md`：
```markdown
# {project_name} 图谱文档集 (Graph RAG)
<!-- search-anchor: 图谱文档, Graph RAG, 关系索引 -->

## 与主文档体系的关系
（图谱文档不替代组件文档，而是提供关系视角的结构化索引）

## 文档目录
| 文件 | 大小 | 核心内容 |

## 按问题类型查找
| 问题类型 | 示例问题 | 查找文档 |
| 依赖关系 | "谁依赖 X？" | G1 组件依赖关系矩阵 |
| 调用链路 | "API X 经过哪些模块？" | G2 调用链路全景 |
| 数据位置 | "数据存在哪里？" | G3 数据流与存储依赖图 |
| 错误排查 | "错误码 XXX 是哪个模块的？" | G4 错误码组件映射表 |
| 场景手册 | "配额检查的完整流程？" | G5 跨组件交互场景手册 |
| 多跳推理 | "A 间接依赖谁？" | G6 知识图谱三元组 |
| 风险评估 | "X 挂了影响多大？" | G7 架构风险与影响面 |
| 配置修改 | "怎么修改 XX 配置？" | G8 核心配置参数索引 |
| 操作约束 | "能不能做 XX？" | G9 业务规则约束矩阵 |

## 检索路由规则建议
（关键词 → 优先检索文档）

## 维护说明
（组件文档更新后需同步更新图谱文档的时机和范围）
```

### Step 4：返回摘要

```
Graph RAG 生成完成：
生成文档: G1~G9 共 9 份 + README
  - G1_组件依赖关系矩阵.md: {N}KB，{N}个组件，{N}条关系
      置信度: EXTRACTED {N} / INFERRED {N} / AMBIGUOUS {N}
  - G2_组件调用链路全景.md: {N}KB，{N}条调用链，状态机{N}个状态
  - G3_数据流与存储依赖图.md: {N}KB
  - G4_错误码组件映射表.md: {N}KB，{N}段错误码
  - G5_跨组件交互场景手册.md: {N}KB，{N}个场景时序图
  - G6_知识图谱三元组.md: {N}KB，{N}条三元组
      置信度: EXTRACTED {N} / INFERRED {N} / AMBIGUOUS {N}
  - G7_架构风险与影响面分析.md: {N}KB
  - G8_核心配置参数索引.md: {N}KB，{N}个配置项
  - G9_业务规则约束矩阵.md: {N}KB
AMBIGUOUS 条目汇总（需人工确认）: {N} 处
  - 示例: "Aurora→Compute 通信方式不确定（文档未明确）[A:0.2]"
发现问题: {问题 或 "无"}

⚠️ 主 Agent 请注意：Graph RAG 完成后，请立即执行 Phase K3 Step 3（跨文档一致性校验）。
```

## 输出

```
<output_dir>/README.md
<output_dir>/G1_{project_name}组件依赖关系矩阵.md
<output_dir>/G2_{project_name}组件调用链路全景.md
<output_dir>/G3_{project_name}数据流与存储依赖图.md
<output_dir>/G4_{project_name}错误码组件映射表.md
<output_dir>/G5_{project_name}跨组件交互场景手册.md
<output_dir>/G6_{project_name}知识图谱三元组.md
<output_dir>/G7_{project_name}架构风险与影响面分析.md
<output_dir>/G8_{project_name}核心配置参数索引.md
<output_dir>/G9_{project_name}业务规则约束矩阵.md
返回摘要字符串
```

## 约束

- **关系抽取以组件文档为唯一来源**：不直接读原始代码，防止与 Phase K2 产出不一致
- **置信度三态强制**：每条关系/三元组必须标注 `EXTRACTED`/`INFERRED`/`AMBIGUOUS`，不得省略
- **禁止用 0.5 作置信度默认值**：每条关系独立评估分值；INFERRED 直接结构证据 0.8~0.9，命名推断 0.6~0.7，弱证据 0.4~0.5；AMBIGUOUS 用 0.1~0.3
- **禁止凭空发明关系**：若组件文档无依据，宁可标 AMBIGUOUS 也不捏造 EXTRACTED
- **每份图谱文档必须有 AI 快速理解要点表**
- **每份图谱文档必须有 search-anchor**
- **图谱文档不替代组件文档**：只提供关系视角的结构化索引
- **状态机必须使用 mermaid stateDiagram-v2**
- **约束决策树必须使用 mermaid graph TD**
- **三元组必须遵循 (Subject, Predicate, Object, Confidence, Score) 格式**
- **操作-状态约束必须是 ✅/❌/⚠️ 矩阵格式**
