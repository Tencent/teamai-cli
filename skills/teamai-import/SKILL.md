---
name: teamai-import
description: "TeamAI 知识导入 — 从代码仓库/MR/iWiki/本地目录导入知识到团队知识库，含 Chat 环境 AI Enrichment 适配。当用户要导入代码知识、分析仓库、生成知识图谱时触发。"
---

# TeamAI 知识导入

将外部知识源（代码仓库、MR、iWiki、本地目录）导入团队知识库。

## 触发条件

- 用户要"导入仓库"、"分析代码"、"生成知识图谱"
- 用户要从 MR/iWiki 提取知识
- 用户提到 `teamai import`

---

## 导入模式

### 1. 从代码仓库

```bash
# 完整导入（含 AI enrichment 分析模块职责）
teamai import --from-repo <git-url>

# 增量更新（复用缓存 clone，只处理新变更）
teamai import --from-repo <git-url> --incremental

# 仅提取，跳过 AI 分析（Chat 环境推荐）
teamai import --from-repo <git-url> --skip-enrich
```

### 2. 批量导入多仓库

```bash
# 第一步：扫描组织，生成仓库白名单
teamai import --from-org <org-name>
# 产出文件：.teamai/repo-whitelist.draft.yaml（可手动编辑筛选）

# 第二步：按白名单批量导入
teamai import --from-repo-list .teamai/repo-whitelist.draft.yaml --incremental
```

### 3. 从本地目录

```bash
teamai import --dir <local-path>
```

适用于已 clone 到本地的仓库，跳过 clone 步骤。

### 4. 从 MR/PR

```bash
teamai import --from-mr <mr-url> --all
```

提取 MR 中的经验和代码建议，`--all` 跳过交互确认。

### 5. 从 iWiki

```bash
# 需要环境变量 TAI_PAT_TOKEN
teamai import --from-iwiki <space-id-or-url>
```

注意：基本模式和 `--iwiki-dual` 模式均会调用 AI CLI（用于分类）。

### 6. 缓存管理

```bash
teamai import --cache-status   # 查看缓存状态
teamai import --cache-gc       # 清理过期缓存
```

---

## Chat 环境 AI Enrichment 适配

`teamai import` 完整模式通过 `callClaude()` spawn 子进程调用 AI CLI（claude/codex/codebuddy）来分析模块职责并生成 `_manifest.json`。

**如果你的环境没有可用的 AI CLI**（IDE Chat 中通常没有），使用以下流程：

### 步骤 1：提取代码知识（无需 AI）

```bash
teamai import --from-repo <git-url> --skip-enrich
```

完成的工作：
- 克隆仓库到本地缓存
- AST 解析提取 CodeFacts（组件、接口、依赖）
- 构建依赖图谱（graph-index.json）
- 生成 evidence 页面（每个模块一个 .md 文档）

注意：`--skip-enrich` 不会生成 `_manifest.json`（该文件由 AI enrichment 产生），但 evidence 文档和图谱已完整可用。

### 步骤 2：手动 Enrichment（由你完成）

阅读生成的 evidence 文件，自行分析每个模块的职责：

```bash
# 查看项目总览
cat <teamwiki>/evidence/code/<project>/overview.md

# 查看各模块文档
ls <teamwiki>/evidence/code/<project>/modules/
cat <teamwiki>/evidence/code/<project>/modules/<module>.md
```

基于分析结果，创建 `_manifest.json`：

```bash
cat > <teamwiki>/evidence/code/<project>/_manifest.json << 'EOF'
{
  "schemaVersion": "team-wiki.codebase-output-manifest.v2",
  "project": "<项目名>",
  "generatedAt": "<ISO时间>",
  "components": [
    {
      "slug": "模块名",
      "docPath": "modules/模块名.md",
      "category": "entry|orchestration|service|data",
      "confidence": "EXTRACTED",
      "responsibilities": ["职责1", "职责2"]
    }
  ],
  "edges": []
}
EOF
```

**字段说明：**
- `slug`：模块标识（与 modules/ 目录下的文件名对应）
- `docPath`：模块文档相对路径
- `category`：架构层级（entry=入口 / orchestration=编排 / service=业务 / data=数据层）
- `confidence`：`EXTRACTED`（来自代码分析）或 `INFERRED`（推断）
- `responsibilities`：核心职责列表（2-5 项）

**分析依据：**
- overview.md 中的项目结构描述
- 各 module.md 中的组件列表和依赖关系
- graph-index.json 中的节点和边信息

### 步骤 3：验证并触发索引重建

```bash
# 验证知识库一致性
teamai codebase --lint

# 重新运行 import 触发全局图谱聚合（使用缓存，不重新 clone）
teamai import --from-repo <git-url> --incremental --skip-enrich
```

第二条命令会利用缓存的 clone 重新执行提取流程，此时已有的 `_manifest.json` 会被保留，全局图谱索引会重新聚合。

---

## 导入后验证

```bash
# 检查知识库一致性
teamai codebase --lint

# 确认可检索
teamai recall "刚导入的仓库名或关键词"
```

## 完整示例

```bash
# Chat 环境导入 hai_api 仓库
teamai import --from-repo git@git.woa.com:HAI/hai_api.git --skip-enrich

# 读取 manifest 做 enrichment
cat ~/.teamai/wiki/evidence/code/tgit__HAI__hai_api/_manifest.json

# (由你分析每个 component 的 category 和 responsibilities，编辑写回)

# 验证
teamai codebase --lint
teamai recall "hai_api 接口"
```
