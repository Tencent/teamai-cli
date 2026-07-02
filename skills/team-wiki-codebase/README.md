# team-wiki-codebase — 大型代码库 AI 认知工程

> Team Wiki 插件内置 skill：方法论、脚本与 Agent 规范均随 `team-wiki install` / `upgrade` 部署到项目的 `.codebuddy/`、`.cursor/` 等目录。

## 为什么需要这个 skill

大型项目的 AI 理解困境：

| 痛点 | 具体表现 |
|------|---------|
| **上下文装不下** | 10+ 仓库、数十万行代码，远超 AI 上下文窗口 |
| **关系看不清** | 微服务间的 RPC/MQ/DB 依赖散落在各仓库，没有全局视图 |
| **规则记不住** | 业务约束、状态机、配置参数隐藏在深层调用链中 |
| **回答不准确** | AI 只看到局部代码，缺乏全局架构认知，容易幻觉 |
| **token 消耗大** | 每次提问都要重新读大量源码，效率极低 |

## 怎么解决

通过架构逆向工程，将海量代码**压缩为结构化知识库**：

- 每个结论有代码 `文件:行号` 作为证据
- 每条组件关系有置信度标注（`EXTRACTED` / `INFERRED` / `AMBIGUOUS`）
- 每次生成后有准确性统计，超标自动警告
- AI 读知识库而非读源码，**约 1/50 的 token 消耗**获得全局架构认知
- Phase 0 可用 `team-wiki compile code --extract ast,heuristic` 生成可证据化的结构边（TS/JS/Python/Go）

---

## 产出体系

```
<output_dir>/
├── README.md                           ← 检索路由指引（AI 专用）
├── {项目名} 技术架构.md                ← 系统全貌，~200KB
├── {项目名} 业务架构.md                ← 产品能力 + 生命周期
├── {项目名} 部署架构.md                ← 部署拓扑
├── XX_{组件名}设计说明.md × N          ← 每组件一份，含 AI 快速理解表
├── XX_{项目名}核心API产品代码映射.md    ← 产品约束→代码位置 桥梁文档
├── XX_{项目名}产品规则速查表.md
├── XX_{项目名}业务开发规范SOP.md
├── {反模式/RPC契约/排障记录} × N
├── _manifest.json                      ← 机器可读 manifest（供 team-wiki compile 快路径）
└── graph/                              ← Graph RAG 图谱文档集
    ├── G1 组件依赖关系矩阵
    ├── G2 调用链路全景 + 状态机
    ├── G3 数据流与存储依赖图
    ├── G4 错误码组件映射表
    ├── G5 跨组件交互场景手册（≥10个时序图）
    ├── G6 知识图谱三元组（≥100条，含置信度）
    ├── G7 架构风险与影响面分析
    ├── G8 核心配置参数索引
    └── G9 业务规则约束矩阵 + AI 推理决策树
```

---

## 执行流程

```
Phase 0  → 初始化：收集路径、项目名、产品文档来源；可选 CLI ast+heuristic 结构基线

Phase K1 → 架构逆向：关键文件提取 → 分层分析 → 组件关系矩阵
                                              ⛔ 确认点① 架构理解确认

Phase K2 → 文档生成（分批并行）：
             批次1~4: Type-4 组件文档（并行子 Agent 分发）
                                              ⛔ 确认点② 文档质量抽查
             批次5~7: 架构总览 + 桥梁文档 + 知识增强

Phase K3 → AI-Native 增强：
             search-anchor + 双向链接 + 检索路由规则
             Graph RAG 图谱文档集 G1~G9（置信度三态标注）

Phase K4 → 质量评估：
             validate_kb.py 自动检验
             全库准确性审计（[UNVERIFIED] 统计 + 接口覆盖率）
             跨文档一致性校验（矛盾检测 + 自动修复）
             RAG 检索抽检（7类问题）
             AI 端到端验证（10~15 个标准问题 + 代码回溯）
             生成质量报告
```

支持 `--update` 增量更新（基于文件 hash 缓存，只重跑变更组件）。

---

## 文件结构

```
team-wiki-codebase/
├── SKILL.md                                ← 主执行指令（AI 加载）
├── README.md                               ← 本文件
├── scripts/
│   ├── scan_repo.py                        ← 仓库扫描辅助工具
│   └── validate_kb.py                      ← 知识库质量校验工具
└── references/
    ├── agents/
    │   ├── kb-doc-generator.md             ← Type-1~8 文档生成专职 Agent
    │   └── graph-rag-agent.md              ← G1~G9 图谱文档专职 Agent
    ├── methodology/
    │   ├── phase0-collection.md            ← 源材料采集方法
    │   ├── phase1-reverse-engineering.md   ← 架构逆向工程方法
    │   ├── phase2-document-types.md        ← 九大文档类型规范与质量标准
    │   ├── phase3-ai-enhancement.md        ← AI-Native 增强方法
    │   └── phase4-quality.md               ← 质量评估 Checklist
    └── templates/
        └── project-overview.md             ← 知识库 README 模板（含认知边界声明）
```

---

## 质量标准

| 维度 | 达标标准 |
|------|---------|
| 覆盖率 | ≥90% P0 核心组件有文档 |
| 准确性 | [UNVERIFIED] < 15% |
| 结构质量 | 死链接=0，search-anchor 覆盖率≥95% |
| AI 可用性 | RAG 检索抽检准确率≥85% |
| 关系可信度 | AMBIGUOUS 关系 < 10%，全部列入待确认清单 |
