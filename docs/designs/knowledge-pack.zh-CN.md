# 固定 Git 版本的知识预览

[English](knowledge-pack.md)

## 1. 范围

这是需求—会议—代码追溯的 A/B 开发增量：TypeScript 生产器与仅依赖标准库的 Go 校验/查询引擎。本增量**不实现**[管理后端](management-backend.zh-CN.md)、网页、SSO、资源处理器、发布、MCP 或自动接入 `recall`。生成的包均为未发布的本地 **preview**；所有关系均为候选，适用性未知。

PRD 先按原流程提交到已有资料 Git 仓库，生产器读取指定完整 commit 的文件，再生成派生对象、关系和证据。Git 提交不等于 PRD 获得业务批准，也不等于知识发布。流程不修改来源、不切换分支、不提交或推送。来源策略引用仅记录依赖，**不构成**权限证明或对用户的授权。

## 2. 构建预览

先构建 CLI（`npm ci --ignore-scripts && npm run build`）。在本地资料仓和代码仓旁创建输入 manifest。将下例每个 commit 占位符替换成对应仓库的完整 40 或 64 位 commit ID；不接受分支、标签或缩写 hash。

```json
{
  "schema_version": "teamai.knowledge-input.v1",
  "project_id": "course-export",
  "sources": [
    {
      "source_id": "export-prd",
      "repo": "./documentation",
      "commit": "FULL_DOCUMENTATION_COMMIT",
      "path": "requirements/export.md",
      "kind": "requirements",
      "policy_ref": "course-documents"
    },
    {
      "source_id": "export-review",
      "repo": "./documentation",
      "commit": "FULL_DOCUMENTATION_COMMIT",
      "path": "meetings/export.srt",
      "kind": "transcript",
      "policy_ref": "course-meetings"
    },
    {
      "source_id": "export-code",
      "repo": "./application",
      "commit": "FULL_CODE_COMMIT",
      "path": "src/export.ts",
      "kind": "code",
      "policy_ref": "course-source"
    }
  ]
}
```

`repo` 相对于 manifest 文件所在目录解析，与执行命令的工作目录无关；必须是本地可用 Git 仓库，生产器不 clone/fetch。每条来源选择一个已提交的普通 UTF-8 文件，拒绝符号链接、子模块、路径穿越、缺失 Git 对象和过大输入。包内包含所选材料的完整提交正文以核验证据，分享前应检查材料范围。产物不复制 manifest 的本地仓库路径或运行时认证配置。来源正文按原样保留，所选文件正文已有的敏感值也会进入快照；此工具不承担密钥脱敏。

```bash
node dist/index.js codebase --knowledge-manifest input.json --output out --json
node dist/index.js --dry-run codebase --knowledge-manifest input.json --output out --json
```

首条命令写入 `out/knowledge-pack-<package_hash>.json` 并返回路径。输出不可变：同内容可重复构建，已有不同内容文件不会被覆盖。dry-run 在内存中构建并校验，不创建输出目录。包最大 16 MiB，最多选择 200 个来源版本，单来源文件最大 1 MiB。

PRD 建议使用显式稳定编号，例如：

```markdown
## REQ-23: Export accessible courses

ExportService exports only courses accessible to the current user.
```

确定性解析保留带编号的需求段落、来源文档、选中的相关会议/逐字稿片段和现有抽取器产生的代码事实。准确需求编号及无歧义的代码符号提及可生成候选关联，SRT 证据保留时间码和原始行号。自然语言建议不会被提升为已批准决策；本增量不提供通用 PRD 语义理解，也不调用 LLM。未解析、歧义和未纳入材料参见 `coverage.warnings`。文本变更后的可靠连续追溯需要显式稳定需求编号。

PRD 或会议再次提交后，维护者手动选择新的固定来源版本，再构建新预览。事件触发重建、关系核对与正式知识发布属于后续接入工作。

## 3. 用 Go 校验与查询

在装有 Go 1.24 及以上的源码 checkout 中执行：

```bash
cd server
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --query 'REQ-23'
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --object REQ-23 --version OBJECT_VERSION
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --object REQ-23 --version OBJECT_VERSION --relations incoming
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --trace REQ-23 --version OBJECT_VERSION --depth 2 --max-nodes 100
```

`HASH` 使用生产器输出，`OBJECT_VERSION` 使用搜索返回的准确版本。校验返回数量和 `state: "preview"`；搜索返回带 ID、版本、证据引用的完整对象及截断标记；对象查询读取准确版本，关系查询返回版本化端点；路径查询返回节点、边、证据及截断原因。查询有界，路径最多 3 跳、100 个节点，并限制文本预算。

`--local-preview` 明确表示开发工具读取操作者本地已有材料。它不是企业授权边界、离线租约、网络 API 或来源鉴权替代品；不能把开发产物当作正式获授权的团队知识分发。引擎的 `Authorizer` 接口在每次查询前检查全部来源策略依赖；决策缺失、拒绝或不可用时拒绝查询。真实权限权威及所有公共下载/查询入口仍需在管理后端中接通。

## 4. 对象版本与包内闭包

对象引用为 `{object_id, object_version}`，一个包可以同时包含两个 commit 的 REQ-23。每条关系的准确端点和证据必须在包内解析；查询不回退到默认/新版，也不暗中查找其他包。旧对象带入自身证据及来源策略依赖，但不递归引入全部历史关系。

manifest 可用 `default_object_versions` 指定未来导航默认版本；Go 对象/关系/路径命令仍要求显式版本。查看两个版本后，可以添加有证据的替代断言：

```json
{
  "default_object_versions": {"REQ-23": "NEW_OBJECT_VERSION"},
  "assertions": [{
    "type": "SUPERSEDES",
    "from": {"object_id": "REQ-23", "object_version": "NEW_OBJECT_VERSION"},
    "to": {"object_id": "REQ-23", "object_version": "OLD_OBJECT_VERSION"},
    "evidence_refs": ["EVIDENCE_ID_FROM_PACKAGE"]
  }]
}
```

将这些字段加到输入 manifest，并选中两版来源。断言仍为 `human_assertion` / `candidate` / `unknown`，录入不等于确认业务决策；时间较新不会自动生成替代关系。端点、证据或默认对象版本缺失，重复版本、端点类型不匹配和替代循环都会导致校验失败。

## 5. 交换格式与后端边界

v1 包结构为 `{schema_version, package_hash, payload}`。`package_hash` 是 **payload 值原始 UTF-8 JSON 字节**的 SHA-256，不是外层文档或 Go 重新序列化结果的 hash。生产器输出确定性的紧凑 JSON；格式化 payload 会改变摘要，读取器拒绝不匹配。摘要只验证完整性，不证明生产者身份或发布批准。

payload 包含来源快照、来源策略引用、准确对象版本、逐行证据、候选关系、可选导航默认及覆盖提示。严格 Go 读取器还拒绝未知字段、重复 JSON 键、无效编码与尾随数据；校验来源/对象 hash、证据原文行、关系及策略依赖闭包。

接入共享服务前，Go 管理后端必须独立建立可信的来源策略依赖、注册资源类型，让**全部** content/blob/snapshot/query 入口执行当前来源鉴权，并通过公共 ChangeSet → Review → Release 发布。本地生产器提供的 `policy_ref` 不能建立上述授权。本模块不增加独立发布指针或第二套团队管理 API。

## 6. 验证

```bash
npm run build
npx tsc --noEmit
npx vitest run
(cd server && go test ./...)
npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/knowledge-pack-cli.test.ts
```

定向 E2E 创建真实临时 Git 仓库，在已有更新提交和 dirty 文件时读取旧 commit，验证不可变输出，再用 Go 可执行程序读取 Node 产物，检查准确对象版本、关系、搜索和路径。Agent/provider 组合验证本地配置独立性，不访问 GitHub/GitLab，也不代表 Agent runtime、身份提供方或管理后端集成已验证。
