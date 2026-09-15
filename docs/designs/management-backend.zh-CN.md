# 管理后端设计

[English](management-backend.md)

状态：[#341](https://github.com/Tencent/teamai-cli/issues/341) 的设计提案。
本文描述未来能力，不增加 Go 服务、Web 控制台或 CLI 选项，也不改变现有 Git
或 ClawPro HTTP 实现。本阶段交付物仅为本文及英文版本；实现前需要确认下文的
开放决策并满足各阶段验收条件。

## 1. 范围与现有实现

对照基线为 main 提交 `3f7fa1dedbccac1416fe329bdd308bb45de30b0e`。
后端需要同时覆盖已发布资源和成员产生的数据。普通用户无需安装 Git，
也不应看到 Git 凭据、仓库地址或基于 Git 的贡献流程。

[ResourceHandler](../../src/resources/base.ts) 为七个
[已注册处理器](../../src/resources/index.ts) 定义扫描、复制、差异和删除接口。
[pull](../../src/pull.ts) 还负责解析命名空间、编译文化与指令、协调 hooks/MCP、
维护召回索引和上报活动。[push](../../src/push.ts) 准备隔离的变更和审核请求；
[remove](../../src/remove.ts) 当前只暴露 skills、rules、agents 和 MCP 的删除。
后端覆盖更多资源，不代表当前每个 CLI 处理器已经支持所有写操作。

现有 [local-agent](../../src/local-agent.ts) 使用
`/api/projects/mine`、`/api/local-agent/report`、`/api/local-agent/sync`、
`/api/local-agent/commands/ack` 和 `/api/local-agent/get-config`，
负责命令与资源下发及工作区绑定，并不生成完整的版本化团队仓快照。
这些路由保留为独立兼容适配器，不作为新 API 的别名。
[#469](https://github.com/Tencent/teamai-cli/pull/469) 提议的 Provider 抽象若获合入，
可以承载未来的管理后端适配器；本文不假设该 PR 已经落地。

[数据目录设计](data-directory-layout.md) 区分机器上的工作区分区与逻辑项目。
[多项目设计](multi-project-management.md) 通过项目和角色选择器决定资源命名空间。
本地选择结果和命名空间名称都不能充当授权凭据。

## 2. 能力映射

每个导入项记录原始路径和来源 revision，便于审计。已发布资源面保存经过审核的
不可变内容；上报数据面接收与身份绑定的事件，使用独立的保留规则和写权限。

| 现有数据 | 现有代码 / 行为 | 后端映射提案 |
| --- | --- | --- |
| `teamai.yaml` | 配置、共享策略、工具路径及审核人（`src/config.ts`、`src/types.ts`） | 版本化策略/配置记录；审核后的变更生成兼容视图 |
| `skills/` | SkillsHandler、命名空间及 marketplace 元数据 | 不可变文件和依赖组成的资源包，派生 marketplace 视图 |
| `rules/` | RulesHandler 及强制规则选择 | 版本化规则，并单独执行强制策略约束 |
| `docs/` | DocsHandler 及文档索引 | 版本化文档、授权物化及召回索引 |
| `env/env.yaml` | EnvHandler、本地覆盖和环境注入 | 非密钥模板及密钥引用，解析密钥时单独授权 |
| `agents/` | AgentsHandler 及工具格式转换 | 版本化 agent 定义，复用现有工具适配器渲染 |
| `hooks/hooks.yaml` | HooksHandler 及 hook 协调，不支持通用逐项 push | 可审核的声明式 hooks、客户端同意及类型验证 |
| `mcp/mcp.yaml` | McpHandler 及 MCP 协调，贡献通过直接编辑 YAML 完成 | 可审核的服务定义、transport 策略及密钥引用 |
| `learnings/` | `src/contribute.ts`、项目命名空间及 `src/utils/search-index.ts` | Learning 草稿、批准后的内容版本、命名空间 ACL 和本地召回索引 |
| `culture.md` | `src/pull.ts` 中的 `compileCulture` | 版本化组织/团队上下文及派生客户端视图 |
| `claudemd/` | `src/pull.ts` 的 `compileClaudemd` 及召回/指令注入 | 版本化指令，只从已授权命名空间选择 |
| `tags.yaml` | 标签发现及本地订阅 | 版本化分类及用户订阅，与访问控制分离 |
| `manifest/roles.yaml` | `src/roles.ts` 资源选择器 | 角色/资源选择的兼容视图，后端 RBAC 独立 |
| `manifest/projects.yaml` | `src/projects.ts` 逻辑项目命名空间 | 稳定项目 ID 映射到已授权命名空间，保留角色/项目并集语义 |
| `sources` / `publicSkills` | `src/source.ts` 的订阅、优先级及安装 manifest | 固定到已授权资源版本及所有权记录的可审计来源引用 |
| `members/` | 成员注册及元数据 | User/Membership/Device 记录，客户端不能自行授予成员身份 |
| `stats/` | `src/team-push.ts` 累计使用/会话汇总 | 去重后的 UsageEvent revision、派生汇总和确认后的游标 |
| `votes/` | `src/votes.ts` 及识别增量的上报合并 | 与身份绑定的投票记录/事件及确定性重试语义 |
| `sessions/` | `src/save-session.ts` 摘要与导出、本地会话事件 | 受策略约束的会话 revision、同意、脱敏和独立保留期 |
| `<type>/.removed` | ResourceHandler tombstone 及本地清理 | 版本化删除操作、tombstone 及保护所有权的删除 |

导入审计必须列出未知文件，不能静默丢弃。未知类型以不可执行的不透明附件保留，
等待管理员分类。密钥不能按普通资源导入。

| 现有命令 | 未来管理适配器 |
| --- | --- |
| `teamai init` | 认证、接入设备、选择已授权项目并绑定工作区 |
| `teamai pull` | 获取授权快照/增量，物化、协调并建立索引 |
| `teamai push` | 扫描本地资源、上传验证后的 blob、提交变更集审核 |
| `teamai contribute` | 提交附带来源/会话归属的 learning 草稿，保留离线草稿 |
| `teamai remove` | 准备需审核的显式删除，发布 tombstone 后执行本地清理 |
| `teamai team-push` | 发送已认证的使用/投票/会话 revision，持久确认后推进游标 |
| `teamai recall` | 仅搜索活跃绑定的授权本地索引并记录待上报投票 |
| `teamai source` | 通过审核后的配置和能力检查管理已授权来源订阅 |

这些是现有命令未来的能力映射，不代表新增命令或选项已经可用。
初始化可以复用现有交互入口；具体选项名称仍需 CLI 设计确认。
管理端导入可以在服务端使用 Git，但成员接入和日常使用不能依赖它。

## 3. 领域模型与授权

管理层级为 `Organization -> Team -> Project`。
项目使用稳定的不透明 ID，不依赖显示名称、文件路径或现有命名空间选择器。
用户可以加入多个组织。`WorkspaceBinding` 将已认证用户和设备、本地工作区标识，
以及一个或多个已授权项目 ID 关联起来。CLI 本地保存绝对路径；
服务端通常只接收不透明工作区 ID 和显示名称。

核心记录包括 `Organization`、`Team`、`Project`、`User`、`Role`、
`Membership`、`Device`、`WorkspaceBinding`、`Resource`、`ResourceVersion`、
`Revision`、`ChangeSet`、`Review`、`Release`、`Learning`、`Vote`、
`UsageEvent`、`Session` 和 `AuditEvent`。租户所属记录和 blob 引用都携带组织 ID，
外键及仓储查询也包含该 ID；猜测资源 ID 不能绕过项目授权。

授权独立于现有角色和资源选择器。建议权限为 `project:read`、
`resource:write`、`review:decide`、`release:publish`、`membership:manage`、
`telemetry:write`、`audit:read`、`organization:manage`、`project:manage`、
`identity:manage` 和 `secret:read`。贡献者不能审核自己的变更；发布者需要单独的
发布权限，并且审核必须对应准确的内容摘要。组织管理员只能通过明确策略获得项目权限。
设备及服务账号的项目范围应比其所有者更窄。

对每个已授权项目，资源按组织、团队、项目及允许的用户偏好逐层解析。
资源键为 `(resource_type, canonical_name)`，不能只用文件名。
用户覆盖不能降低上层强制策略、放宽禁用的 transport 或获得额外密钥权限。
更具体层级的 tombstone 屏蔽继承资源；删除该 tombstone 后恢复继承版本。

角色和逻辑项目选择器仍取已授权命名空间的并集，彼此不覆盖。
若同一具体层级的两个项目提供相同资源键但版本不同，同步应报告冲突并保留旧快照。
用户必须明确选择符合策略的绑定级来源优先级，不能由遍历顺序决定。
跨项目复用固定到已授权来源的 `ResourceVersion`，不能引用可变的 latest。
来源权限变化会使受影响绑定失效，并阻止新的读取。

## 4. 四条端到端用户旅程

**J1：企业用户首次登录。** 管理员配置可信身份提供方及组织、用户组映射。
新用户在控制台或 CLI 选择企业登录，完成公司认证后，
按 `(issuer, subject)` 映射到稳定内部用户。
组织成员身份只能来自管理员批准的映射。
界面展示有权访问的团队、项目，或明确的申请权限状态，不要求填写仓库。

**J2：非 Git 用户首次加入项目。** 管理员创建项目、发布首批资源，
生成限定该项目、单次使用且有有效期的接入码。
成员安装 CLI 并进入初始化流程，通过浏览器批准设备；
无浏览器设备则展示短码，由另一台设备打开验证页面。
接入码本身不授予 bearer token，仍需检查登录身份与申请项目权限是否匹配。
确认后，CLI 将设备凭据保存到操作系统保护的存储中，绑定当前工作区，
验证首份快照并调用现有资源处理器。结果只展示项目、revision 和同步状态，不出现 Git 概念。
过期接入码可以重新签发；拒绝接入不会创建绑定。

**J3：同一成员管理多个项目。** 成员通过相同流程加入第二个已授权项目，
为其选择独立工作区，或加入已有绑定。选择结果及同步状态按绑定隔离。
切换工作区时激活对应项目集合；在同一绑定内切换项目时，
先预览将新增、替换和删除的资源。同名冲突遵循第 3 节。
项目不可用不能导致另一项目的缓存被空快照覆盖。
退出项目时撤销绑定，只删除仍保持已应用内容的受管资源，
保留个人修改并报告冲突。解绑设备、卸载时撤销凭据，
清理本地凭据、索引和受管状态，不删除无关用户文件。
若处于离线状态，本地清理完成，但远程撤销必须明确显示为待处理，
直到重新联网提交或在控制台完成。

**J4：管理员跨项目审核发布。** 管理员为同一组织内多个项目准备变更集，
查看有效资源差异及受影响成员后提交审核。
审核者批准准确版本；发布者再次验证权限及所有预期项目 head。
同一个数据库事务创建不可变 release，并更新全部目标 head。
任意 head 过期、审核缺失或授权失败都会拒绝整次发布。
客户端只能看到旧 release 或新 release 的完整 manifest，不能看到混合状态。
回滚通过新 release 引用选定的历史版本，遵循相同的授权与审核规则。
跨组织原子发布不在本文范围内。

所有旅程的重试保留操作 ID，权限在服务端检查，身份服务故障不能降级成匿名访问。
普通用户看到加入、提交、审核、发布、恢复等操作，不接触 branch、commit、merge
或文本冲突标记。

## 5. 状态机与版本语义

`Revision` 是服务端签发的不透明、不可变 manifest 标识。
客户端只比较是否相等，不能按大小排序，也不采用 Git SHA 语义。
`ResourceVersion` 标识不可变字节及其 SHA-256 摘要。
`Release` 关联多个项目 revision；项目 head 的每次变化都产生审计事件。

```text
ChangeSet: DRAFT -> IN_REVIEW -> APPROVED -> PUBLISHED
           IN_REVIEW -> CHANGES_REQUESTED -> DRAFT
           IN_REVIEW -> REJECTED
           DRAFT | IN_REVIEW | APPROVED -> CANCELLED
Project:   ACTIVE -> ARCHIVED -> ACTIVE
           ARCHIVED -> DELETION_PENDING -> DELETED
Device:    PENDING -> ACTIVE -> REVOKED
Enrollment: PENDING -> APPROVED | DENIED | EXPIRED
Binding:   ACTIVE -> SUSPENDED -> ACTIVE
           ACTIVE | SUSPENDED -> REVOKED
Sync:      IDLE -> DOWNLOADED -> APPLYING -> APPLIED
           APPLYING -> PARTIAL -> APPLYING
           DOWNLOADED | APPLYING | PARTIAL -> BLOCKED_AUTHORIZATION
```

提交审核后继续修改会产生新草稿摘要，并使之前审核失效。
发布失败时，已批准变更集仍未发布，返回可恢复的冲突，不部分应用资源操作。
修改内容或目标 head 后不能复用旧审核。
归档项目按策略允许读取，但拒绝写入和新接入。
删除先撤销绑定并记录 tombstone，保留和清除是独立的可审计管理操作。

快照包含准确的解析后项目 revision、资源来源、版本 ID、hash、字节数、
策略版本及 tombstone。manifest 使用接入时建立信任的部署密钥签名。
blob hash 验证字节；签名和授权验证谁可以提供和接收这些字节。
只要保留的 release、审核、草稿或绑定仍有引用，
回滚及跨项目复用所需 blob 就不能被清理。

## 6. 版本化 API 契约

新资源 API 的建议前缀为 `/v1`，采用 HTTPS、JSON、
服务端请求 ID、明确权限校验及不透明 ID。
认证端点遵循所选协议，不用自定义资源错误包装 OAuth 错误。
任何端点都不能接收要求在成员设备执行的 shell 命令。

| 方法 | 拟定路由 | 语义 |
| --- | --- | --- |
| GET | `/v1/capabilities` | 发现版本、操作、资源类型及限制 |
| GET | `/v1/auth/authorize; /v1/auth/callback` | 浏览器授权及已验证回调 |
| POST | `/v1/auth/device/authorizations` | 启动 Device Flow，限制轮询并等待用户批准 |
| POST | `/v1/auth/token` | 授权码/设备授权或刷新，轮换 refresh 凭据 |
| POST | `/v1/auth/revocations` | 撤销自己的凭据/设备会话，或管理权限内的目标 |
| POST | `/v1/enrollments` | 管理员签发单次项目接入意向 |
| POST | `/v1/enrollments/{id}/decisions` | 绑定身份及申请 scope 的认证批准/拒绝 |
| GET, POST | `/v1/organizations; /v1/organizations/{id}/teams` | 列出授权层级，或在明确组织权限下管理 |
| GET, POST | `/v1/teams/{id}/projects` | 按团队/组织策略列出或创建项目 |
| GET, PATCH, DELETE | `/v1/projects/{id}` | 读取、归档/恢复或请求可审计删除，修改需条件请求 |
| GET | `/v1/projects/{id}/members` | 列出有权查看的项目成员 |
| PUT, DELETE | `/v1/projects/{id}/members/{user_id}` | 按成员管理权限授予/撤销成员身份 |
| GET, PATCH, DELETE | `/v1/devices/{id}` | 查看自己/有权管理的设备，改名或撤销 |
| POST | `/v1/bindings` | 将已认证设备绑定到允许的项目 |
| GET, PATCH, DELETE | `/v1/bindings/{id}` | 读取/改变项目选择或撤销绑定，修改需条件请求 |
| GET | `/v1/bindings/{id}/snapshot` | 返回单份签名有效 manifest 及授权 blob 引用 |
| GET | `/v1/bindings/{id}/changes` | 返回授权游标后的增量，包含 tombstone |
| GET | `/v1/projects/{id}/resources` | 分页资源、版本和来源元数据 |
| GET | `/v1/resource-versions/{id}/content` | 返回授权不可变内容或限定范围下载地址 |
| POST | `/v1/blobs` | 暂存有界二进制内容，验证声明字节数和 hash |
| POST | `/v1/change-sets` | 创建固定项目 head 且包含明确操作的草稿 |
| PATCH | `/v1/change-sets/{id}` | 用 If-Match 编辑草稿，使旧审核失效 |
| POST | `/v1/change-sets/{id}/submit` | 验证并固定待审核摘要 |
| POST | `/v1/change-sets/{id}/reviews` | 记录针对精确摘要的批准/要求修改/拒绝 |
| POST | `/v1/releases` | 跨变更集目标项目原子发布已批准内容 |
| POST | `/v1/releases/{id}/rollback` | 准备需审核的恢复变更集，不改写旧 revision |
| GET | `/v1/projects/{id}/releases` | 分页不可变历史及差异 |
| POST | `/v1/projects/{id}/learnings` | 创建可审核 learning 草稿，不直接发布 |
| POST | `/v1/reports/events` | 去重已认证设备的使用、投票和会话 revision |
| POST | `/v1/secret-resolutions` | 仅在线、可审计地为授权设备和资源解析密钥 |
| GET | `/v1/operations/{id}` | 在相同授权条件下按客户端预生成操作 ID 查询，首次响应丢失后仍可恢复 |
| GET | `/v1/audit/events` | 按 audit:read 权限分页查询租户/项目审计 |

所有租户及资源读取都重新检查成员权限，包括 blob 下载、游标翻页、
审计查询和操作状态。blob 下载地址有短有效期，并限制在已授权版本和组织内，
不暴露存储凭据。暂存上传通过验证后才能被变更集引用。
会话上报端点不授予资源写权限。

创建变更集时指定预期项目 revision 和明确操作。
删除是显式操作，不能通过省略资源表示：

```json
{
  "client_operation_id": "op_client_001",
  "projects": [{"project_id": "prj_a", "base_revision": "rev_a_24"}],
  "operations": [
    {"op": "put", "project_id": "prj_a", "type": "skills",
     "name": "release-check", "blob_id": "blob_verified_1"},
    {"op": "delete", "project_id": "prj_a", "type": "rules",
     "name": "retired-rule"}
  ]
}
```

**并发。** 可变记录返回强 `ETag`，修改必须提供 `If-Match`。
缺失条件返回 `428 PRECONDITION_REQUIRED`，
过期条件返回 `412 REVISION_MISMATCH`。
变更集还固定各目标项目的基础 revision。
发布在更新所有 head 的同一事务内再次验证这些 revision。
客户端获取新差异，请用户解决资源修改冲突，不能静默覆盖。

**幂等。** 资源修改在首次请求前生成并持久化 `client_operation_id`，
并将同一值作为 `Idempotency-Key`；不向 OAuth 协议端点附加该自定义 header 要求。
ID 的作用域包括组织、主体、方法、路由及目标。
服务端在状态修改事务内保存请求摘要及持久操作/结果记录；
建议的 24 小时 HTTP 响应缓存仅用于优化重试。
相同 ID 配合不同内容返回 `409 IDEMPOTENCY_CONFLICT`。

`GET /v1/operations/{id}` 接受这个客户端预生成 ID，因此即使第一次响应及其中所有
服务端生成的 ID 都丢失，仍可对账。
客户端重试原 ID 或按原 ID 查询，不能因超时或缓存过期而换一个新 ID。
终态操作 ID 和结果引用的可查询期限超过响应缓存有效期。
结果保留期结束后仍保留精简的过期 ID 标记，返回
`410 OPERATION_HISTORY_EXPIRED`。
客户端保留待处理意图，对照资源 revision 和审计证据，
只有经过明确对账决策后才能创建真正的新操作。
历史未知或过期不等于先前写入从未发生。

**分页与限制。** 列表返回 `items` 和 `next_cursor`。
签名游标绑定主体、组织、筛选条件和快照 revision，建议有效期为 24 小时。
每一页仍重新检查权限。默认每页 50 项，最多 200 项。
暂定每个变更集最多 100 个操作，每个 blob 最多 32 MiB，
快照解压后最多 1 GiB，同时限制文件数、路径长度、嵌套深度和压缩比。
部署负责人需要在 P1 前确认这些限制；CLI 从服务端发现限制，
不能硬编码另一套值。大型操作先暂存，再原子发布。

**资源错误。** 错误响应包含 `error.code`、受长度限制的 `error.message`、
`request_id`，以及可选的结构化冲突资源 ID。
稳定错误码包括 `AUTH_REQUIRED`（401）、`ACCESS_DENIED`（403）、
`NOT_FOUND`（404，也用于隐藏的跨租户对象）、`CURSOR_EXPIRED`、`OPERATION_HISTORY_EXPIRED` 或 `EVENT_WINDOW_EXPIRED`（410）、
`PAYLOAD_TOO_LARGE`（413）、`VALIDATION_FAILED`（422）、
`RATE_LIMITED`（429）和 `IDENTITY_UNAVAILABLE`（503）。
重试遵循 `Retry-After` 并使用抖动。
验证错误不得回显密钥、文件系统路径或上游堆栈。

**兼容。** 能力发现返回协议版本、支持的资源类型、可写操作、
客户端版本范围及限制。不支持的主版本在修改前停止。
忽略未知可选响应字段，但未知操作或必需资源类型必须明确报错。
增量游标过期后重新获取已授权完整快照，不能猜测遗漏的删除项。

## 7. 身份与企业鉴权接入

默认适配器使用 OIDC 登录；具备浏览器的客户端使用带 PKCE 的授权码流程。
无浏览器客户端采用
[OAuth 设备授权流程](https://www.rfc-editor.org/rfc/rfc8628)，
处理等待、减慢轮询、拒绝和过期响应。
短码单次使用、有有效期且受限流保护；审批页面明确展示设备、组织、
项目及申请权限。

Go 的 `IdentityProvider` 边界将提供方认证标准化为
`issuer`、`subject`、已验证 claims 和凭据有效期。
独立身份服务进一步解析为 `UserID` 和已批准组织成员关系。
业务模块只接收内部主体和授权决策。
非标准企业适配器先验证企业签名或会话、受众及有效期，再做标准化，
不能任意断言内部用户 ID 或角色。原始企业 token 只停留在适配器内。

管理员配置明确优先级和拒绝规则的用户组到角色映射。
首次登录验证 issuer 后才创建稳定用户；
邮箱只用于展示或联系，不能作为身份主键。
用户组变化、停用事件更新成员/认证版本，撤销 refresh token 并使活跃设备会话失效。
周期性对账补偿遗漏事件，并生成可审计差异报告。

建议 access token 有效期为五分钟；refresh token 轮换且在服务端以 hash 保存，
检测到重用则撤销整个 token family。每台设备独立记录撤销状态和最近活动时间。
服务账号是独立主体，限制项目 scope 并支持轮换，不能使用交互接入码。
凭据存放在工作区外，不嵌入接入命令、日志或快照。

身份服务无法验证时，新认证、接入、刷新和写操作全部拒绝。
已授权的非密钥缓存资源仅可在建议的 15 分钟授权租约到期前使用；
密钥获取和新的高权限操作始终要求在线授权。
离线撤销不能抹去已读取的信息，文档及验收必须承认这一边界。
下次成功检查到撤销后清理本地物化内容属于尽力而为，不是远程擦除保证。

## 8. CLI 同步与贡献流程

管理后端适配器将完整验证的快照物化到每个绑定/revision 的不可变缓存目录，
提供兼容资源树。实现需要明确的后端 capability/schema 扩展，
不能伪装成 `repo.kind: git`，也不能复用现有 ClawPro 的 `repo.kind: http` 语义。

同步先在暂存区下载并验证完整 manifest、blob、来源权限和删除集合。
原子提升不可变缓存只更新 `downloaded_revision`，不更新 `applied_revision`。
本地工具配置与召回索引横跨多个处理器和文件系统，不能组成单个原子事务；
应用期间可能暂时出现新旧内容混合。

修改目标前，在工作区锁内持久化 apply journal，记录绑定、目标 revision、
操作 ID、目标路径、预期旧 hash、新 hash/删除操作及每步状态。
适配器只有具备可幂等执行的逐目标操作后才能接入该流程。
每步检查目标的实际 hash，在支持的地方使用原子替换，再记录完成状态。
若写入后、journal 更新前崩溃，恢复时目标匹配新 hash 即确认该步已完成。
不匹配且属于非受管内容或用户修改的 hash 必须成为冲突，不能静默覆盖。

处理器或索引重建失败时记录 `PARTIAL` 并保留 journal。
只有全部目标操作及索引重建成功后，才推进 `applied_revision` 和活跃召回索引指针。
在此之前 CLI 展示部分应用状态及待处理/冲突目标，不宣称同步成功。
旧索引只有在其授权租约仍有效时才可继续使用。
重启后从 journal 恢复，并在每个敏感操作前重新检查授权；
撤销后转为 `BLOCKED_AUTHORIZATION`。
不承诺整个工作区回滚。下载失败保持原已应用状态。

写盘前拒绝符号链接、绝对路径、路径穿越、Windows 盘符/UNC 路径、
保留名称及大小写不敏感名称冲突。

物化的 `teamai.yaml`、`manifest/roles.yaml` 和 `manifest/projects.yaml`
是从已授权服务端记录生成的兼容视图，不能把任意资源 blob 当成授权依据。
绑定上下文提供 `dataHome` 和 `projectRoot`，不要求执行 `git rev-parse`。
self 模式和普通 Git 来源维持现有行为。

push 时，处理器扫描本地候选并将文件写入临时树，
manifest 差异转换为上传 blob 和变更集。
本地复制不能隐式发布资源。
处理器尚不支持的写操作，在明确实现前应通过控制台编辑。
hooks 和 MCP 仍遵循客户端策略及用户同意，
资源下发本身不是执行远程命令的授权。

ownership ledger 记录 provider、绑定、资源 ID/版本、目标路径和上次应用 hash。
删除或切换项目只能移除仍匹配该 hash 的受管内容，
保留个人修改并报告冲突。
自动回退到其他来源前，多个 provider 必须共用 ownership 和冲突裁决层。
在该层实现之前，不能承诺移除 HTTP provider 后会恢复其他 provider 的内容。

遥测在入队前持久化 `event_id` 和每设备序号。
其去重 ledger 独立于 HTTP 响应缓存，保留期覆盖公布的最长离线窗口及重试窗口。
ledger 压缩后，过期事件 ID/已关闭序号窗口返回
`410 EVENT_WINDOW_EXPIRED`，要求明确对账；CLI 不能给旧事件换新 ID。
持久确认标识已接收的事件 revision，避免重试静默重复计数。
恢复会话后的修正引用原事件/会话并替换其 revision，
不能再次递增成功会话总数。
Learning 属于可审核内容；投票和使用事件不能编辑已发布资源。
离线队列限制容量，对敏感内容加密，对用户可观察；
只有确认事务完成或用户明确选择后才可丢弃。

## 9. Go monorepo 与存储边界

以一个可部署 Go 服务和一个事务边界起步：

```text
server/
  go.mod
  cmd/teamai-server/
  internal/
    identity/
    organizations/
    projects/
    resources/
    changesets/
    reviews/
    sync/
    telemetry/
    audit/
    platform/
  migrations/
  api/
  tests/
```

`platform` 提供 HTTP 中间件、配置、时钟、ID 及数据库基础设施。
领域包依赖窄接口：`MetadataRepository`、`BlobStore`、
`TransactionManager`、`EventPublisher`、`IdentityProvider` 和 `AuditSink`。
跨域流程通过应用服务编排，HTTP handler 不直接访问其他模块的数据表。

建议的参考部署使用 PostgreSQL 元数据和兼容 S3 的 blob 存储。
一个事务同时更新 revision、审核、项目 head、幂等结果及 audit/outbox 记录。
blob 上传先于发布，未引用暂存 blob 到期清理。
outbox 分发可以重试，但重复事件不能创建第二次 release。
替换存储实现必须通过相同并发、持久化和隔离测试；
内存适配器仅作为测试夹具，不代表生产持久化。

设计获批后，`server/api` 保存 OpenAPI 和兼容性夹具；
`server/tests` 使用真实数据库/blob 适配器及模拟身份提供方。
本设计 PR 不创建 server 目录或引入依赖。

## 10. 安全与运维

每条读写路径、导出、来源订阅、blob 下载和上报都执行租户及项目授权。
密钥值保存在独立加密密钥服务中，仅在下发时为已授权设备解析。
审计和遥测默认对密钥及内容脱敏。
现有 env 资源映射为模板和密钥引用，不作为公开明文密钥。

上传执行类型验证、字节/数量限制、安全归档路径和完整性检查。
来源导入只允许批准的 HTTPS 源；除非租户明确配置，否则禁止跳转到私网，
并使用受限服务凭据。
服务端下发可执行插件或任意命令不属于新 API。
用户编写的 hooks/MCP 只有通过现有明确的信任及同意控制才能在本地执行。

限流覆盖主体、设备、组织及高成本操作，配合有界队列和背压。
若无法将审计记录或持久 outbox 与状态原子提交，则拒绝高权限修改；
遥测故障不阻断无关资源读取。
指标覆盖鉴权失败、发布延迟、同步滞后、队列年龄和 blob 错误，
不记录资源内容或无界用户/项目标签。日志和 trace 携带请求/操作 ID。

备份包含元数据、被引用的不可变 blob 和加密密钥材料。
恢复演练验证引用完整性，并验证 outbox 重放不会重复发布。
垃圾回收保留全部有效 release/草稿和活跃同步租约所需数据。
tombstone 保留期必须超过支持的离线/增量窗口，
超出窗口后客户端只能获取完整快照。
具体保留周期、RPO/RTO、密钥轮换和数据驻留区域仍需部署方明确决策。

## 11. 分阶段实施与验收

| 阶段 | 交付物 | 阶段验收 |
| --- | --- | --- |
| P0 | 本中英设计，确认第 12 节决策 | 完成能力映射、四条旅程及协议语义评审 |
| P1 | 身份、组织/项目成员、schema 与契约 | 租户隔离、Device Flow、token 撤销及并发测试通过 |
| P2 | 只读快照、物化、绑定隔离与召回 | 未安装 Git 的干净机器完成 J1/J2/J3 读取及离线恢复 |
| P3 | 全部资源写入、审核、发布、回滚及来源引用 | 精确摘要审核、跨项目原子发布和保护所有权的删除通过 |
| P4 | Learnings、投票、使用/会话上报及管理端导入 | 幂等重放、会话修正、完整能力往返及可审计导入通过 |
| P5 | Web 控制台、运维加固及试点迁移 | 通过控制台完成 J4，通过恢复演练和部署安全评审 |

P2 是只读试点，不是 Git 的完整替代。
所有映射能力通过验收后才能宣称完整零 Git 管理。
调整顺序时必须明确更新依赖关系及验收证据。

| ID | 必须提供的验收证据 |
| --- | --- |
| A01 | 第 2 节每行均覆盖导入/读取/修改/审核/发布/删除/恢复，或明确适用的上报生命周期；不能静默遗漏路径 |
| A02 | J1：OIDC 和非标准企业适配器产生相同内部主体结构；伪造 issuer/用户组映射被拒绝 |
| A03 | J2：Git 不可用机器上的浏览器及无浏览器接入；过期、复用、拒绝的短码不能创建绑定 |
| A04 | J3：两个组织、多个项目和工作区；未授权资源不能进入 manifest、缓存、召回索引或 blob 响应 |
| A05 | J4：双项目发布期间并发改变成员权限/head；全部 head 同时改变或全部不变 |
| A06 | 审核后修改内容、用新请求体重用幂等 key、提交过期 ETag；按约定错误码拒绝 |
| A07 | 中断下载、缓存提升、每个目标写入、journal 确认及索引重建；区分 downloaded/applied revision，展示 PARTIAL，按 hash 恢复且不覆盖个人修改 |
| A08 | 登录、刷新、同步过程中撤销用户/用户组/设备；执行在线检查及文档规定的离线租约边界 |
| A09 | 拒绝畸形归档、无效 hash/签名、含密钥日志及跨租户游标/blob 访问 |
| A10 | 有个人修改和重叠来源时删除/切换/卸载；保留非受管文件并展示冲突 |
| A11 | 丢失首次修改响应，并在 24 小时响应缓存过期后重放；按客户端操作 ID 恢复。跨支持的离线窗口重放/修正遥测不重复计数，历史/事件过期后必须明确对账 |
| A12 | 备份恢复、密钥轮换和 outbox 重放；保留的 release 可复现且不会重复发布 |
| A13 | 中英章节、API 名称、状态机、阶段及验收 ID 等价 |

## 12. 开放决策与非目标

实现前由维护者确认：参考存储与部署方式；SSO 提供方及用户组同步机制；
租户管理员权限；资源覆盖策略和跨项目来源优先级；审核人数及紧急回滚规则；
密钥下发和存储；所有大小、时间和保留限制；身份故障与离线租约策略；
签名 manifest 的密钥分发；迁移归属，以及与待合入 Provider 抽象的兼容方式。

本 PR 明确不实现 Go 服务、Web 控制台，不改变 CLI 行为，
不宣称生产 OAuth/安全认证，也不修改描述当前行为的 usage guide。
微服务、跨组织原子发布、任意远程执行、面向用户模拟 Git 历史和透明离线撤销，
均不是完成本设计的要求。

HTTP 条件请求遵循 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)，
设备授权遵循 [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)。
实现必须用独立客户端验证契约，不能只依赖服务端自行定义的模型。
