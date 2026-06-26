# Phase 0: 源材料采集与预处理

## 仓库发现与分类

从入口仓库出发，递归发现所有相关仓库：

1. **依赖分析**: 解析项目依赖文件（如 `requirements.txt`, `package.json`, `pom.xml`, `Cargo.toml`, `go.mod` 等，按检测到的语言选择）
2. **配置引用**: 解析流程编排配置中引用的模块名 → 仓库映射
3. **RPC 服务发现**: 从服务注册配置提取服务名 → 仓库映射
4. **按架构层级分类**: API接入层 / 流程引擎层 / 服务执行层 / 资源调度层 / 数据适配层 / 基础执行层
5. **标记核心度**: 根据代码行数、被依赖数、Handler 数量计算优先级

## 关键文件提取清单

| 文件类型 | 匹配模式 | 提取目的 |
|---------|---------|---------|
| **入口文件** | `main.py`, `main.go`, `cmd/*/main.go`, `app.ts` | 服务启动方式和初始化流程 |
| **路由/Handler** | `handler.*`, `router.*`, `controller.*` | API 接口和消息处理入口 |
| **配置文件** | `*config*.*`, `conf/`, `*.yaml`, `*.toml` | 流程编排、参数配置 |
| **Proto/IDL** | `*.proto`, `*.thrift`, `*schema*` | RPC 接口契约和数据结构 |
| **数据库操作** | `*db*.*`, `*dao*.*`, `*model*.*`, `*repository*.*` | 数据模型和表结构 |
| **常量/错误码** | `*const*`, `*error*`, `*code*`, `*enum*` | 错误码体系和业务常量 |
| **测试文件** | `*_test.*`, `test_*.*` | 预期行为和边界条件 |

## 构建代码知识图谱

在正式生成文档前，构建代码知识图谱作为中间表示：

**节点类型**: `[Service]` / `[Handler]` / `[Config]` / `[Table]` / `[Queue]` / `[API]` / `[ErrorCode]`

**边类型**: `[CALLS]`(同步RPC/HTTP) / `[PUBLISHES]`(异步MQ) / `[CONSUMES]`(MQ消费) / `[READS]`(DB读) / `[WRITES]`(DB写) / `[CONFIGURES]`(配置驱动) / `[MAPS_TO]`(产品→代码)

**构建方法**（按可用性排序）:
1. **`team-wiki compile code --extract ast,heuristic --write`** — Tree-sitter 结构边（**TS/JS/Python/Go** 等）+ 多语言 heuristic 事实页
2. Grep + Read（Agent K1/K2）— 补充动态路由、配置驱动调用
3. 解析编排配置 → 模块→命令映射
4. 解析 Proto/IDL/DDL → 数据结构和表关系（结构化文件，可精确解析）
5. MQ 拓扑推断 → Exchange/Topic/Queue/Routing Key
6. API 映射 → 外部 API 名称 → 内部 Handler 入口

> `code-ast` 对相对 import 可产出 `DEPENDS_ON` 边；包级/动态调用仍可能遗漏，标 `[UNVERIFIED]` 或 `AMBIGUOUS`。
> 能力 ID 与边优先级见插件内 `GRAPH-CAPABILITIES.md`。

## 输入源优先级

| 优先级 | 输入源 | 具体内容 | 产出文档类型 |
|--------|--------|---------|------------|
| **P0 必须** | 代码仓库 | 目录结构、入口文件、配置、Proto | Type-1,4 |
| **P0 必须** | 流程编排配置 | workflow_config / 状态机 | Type-1,4,5 |
| **P0 必须** | 产品 API 文档 | 接口参数、错误码 | Type-5,6 |
| **P1 重要** | 数据库 Schema | DDL、表结构 | Type-4 |
| **P1 重要** | 产品使用文档 | 使用限制、FAQ | Type-6,8a |
| **P2 增强** | Git 历史 | Commit/MR 记录 | Type-8b |
| **P2 增强** | 故障记录 | 事故报告 | Type-8d |
