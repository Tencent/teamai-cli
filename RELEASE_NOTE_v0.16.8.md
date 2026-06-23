# teamai-cli v0.16.8 — 团队 AI 知识飞轮 MVP

本版本实现了团队 AI 知识飞轮的最小闭环：**知识库初始化 → 智能检索 → 贡献反馈**，团队成员从安装到受益只需 5 分钟。

---

## 快速开始（5 分钟上手）

```bash
# 安装（内部）
tnpm install -g @tencent/teamai-cli

# 安装（公网）
npm install -g teamai-cli

# 初始化（首次，配置团队仓库）
teamai init --repo <团队仓库地址>

# 同步团队知识到本地（部署 recall agent + 构建索引 + 注入 hooks）
teamai pull

# 开始编码 — 一切自动生效，无需额外操作
# recall agent 自动在每个任务前检索团队知识库
# hooks 自动追踪使用情况和贡献判断
```

---

## 核心能力详解

### 知识库初始化（Cold Start / import）

**本地文档导入**

```bash
teamai import --dir ./docs       # 扫描本地 Markdown 文档
teamai import --from-claude      # 导入 Claude/Cursor 规则目录
teamai import --workspace        # 从当前 git 仓库生成 codebase.md
```

**远程仓库导入**

```bash
teamai import --from-repo <url>                    # 单仓导入
teamai import --from-repo-list .teamai/repos.yaml  # 批量导入
```

**组织级一键初始化**

```bash
teamai import --from-org <工蜂 group ID>   # 工蜂 group
teamai import --from-org <GitHub 组织名>  # GitHub org
teamai import --from-org <org> --bootstrap # 含交互式域确认
```

- AI 自动聚类仓库为业务域，生成 `domains.yaml`
- 产出仓库白名单 + 业务域字典 + 全量 codebase 文档
- 认证三层兜底：token → SSH → public

**iWiki 导入**

```bash
teamai import --from-iwiki <space-id-or-url>   # 需要 TAI_PAT_TOKEN
```

**MR 历史提炼**

```bash
teamai import --from-mr <MR_URL>
```

从合入的 MR 提取 learning 草稿（confidence: 0.85）和 codebase 更新建议，自动与近期 session learnings 去重。

**增量同步**

```bash
teamai import --from-repo-list .teamai/repos.yaml --incremental
```

SHA 未变化时跳过 AI 扫描；章节级 diff，只覆写变化部分，保留人工批注。

---

### 检索 Subagent（自动可用）

`teamai pull` 后自动部署 `teamai-recall` subagent。主对话通过 Agent tool 自动调用，CLAUDE.md 注入触发规则，无需手动操作。

**检索范围**

| 知识类型 | 说明 |
|---------|------|
| Learnings | 团队成员贡献的经验总结 |
| Docs | 团队文档 |
| Rules | 编码规则 |
| Skills | 技能/Slash Commands |
| Codebase | `import --from-repo` 产物 |

**智能增强**

- Domain 推断加权：technical > neutral > ops > support
- IDF 权重 + Vote 加分排序
- 错误自动检索：Bash 报错时 hook 自动触发知识库搜索

**手动检索**

```bash
teamai recall "k8s pod crashloop"
```

---

### 贡献反馈（contribute-check）

Session 结束时，Stop hook 自动判断是否值得贡献：

- 知识库空白感知：recall 均未命中（`hitCount=0`）时触发更强贡献提示
- 低覆盖感知：命中质量低（`topScore < 5.0`）时温和引导
- git commit 检测：有 commit 的 session 降低触发权重，避免与 MR learning 重复

**贡献流程**

```
/teamai-share-learnings              # AI 生成经验总结
  → teamai contribute --file <path>  # 推送到团队仓库 learnings/ 目录
  → 下次 teamai pull 时所有成员可检索到
```

推送失败时自动本地 commit 保护数据，下次 pull 时重试。

---

### MR 驱动知识沉淀（P4.4）

每次 MR 合入后双路输出：

- learning 草稿（confidence: 0.85，已过 code review）
- codebase.md 变更建议（新服务 / 接口变更 / 架构决策）

SessionStart hook 自动提醒最近合入但未导入的 MR。

```bash
teamai import --from-mr <MR_URL>
```

---

## 团队级 Codebase 知识库

### 业务域字典

域配置存储于 `.teamai/domains.yaml`，支持一键初始化：

```bash
teamai import --from-org <org> --bootstrap
```

AI 聚类仓库为业务域（如"接入层"、"后端服务"、"基础设施"），CLI 交互确认后写入 `domains.yaml`。

### 单仓导入

```bash
teamai import --from-repo <url>              # 不指定域
teamai import --from-repo <url> --domain 接入层  # 显式指定域
```

### 批量导入

```bash
teamai import --from-repo-list .teamai/repo-whitelist.yaml
teamai import --from-repo-list .teamai/repo-whitelist.yaml --concurrency 5
```

默认并发 3 仓，产物按域拆分为 `docs/codebase/domain-*.md`。

### 增量同步

```bash
teamai import --from-repo-list .teamai/repo-whitelist.yaml --incremental
```

仅重扫变更涉及的模块，并自动检测域漂移。

---

## 运维与治理

### 缓存管理

```bash
teamai cache --status                # 查看缓存状态
teamai cache --gc                    # 清理过期缓存（LRU，默认 5GB 上限）
teamai cache --gc --dry-run          # 预览清理结果，不实际删除
```

### Codebase 健康度

```bash
teamai codebase --lint               # 检查文档一致性
teamai codebase --lint --fix         # 自动修复低风险问题
teamai codebase --lint --severity high   # 只报高级别问题
teamai codebase --lint --json        # 机器可读输出（供 CI 消费）
```

### Pending Review

```bash
teamai review                            # 列出待审核项
teamai review <id> --apply               # 接受并应用
teamai review <id> --reject              # 拒绝
teamai review --all-apply --max-risk low # 批量接受低风险项
```

### 域漂移

```bash
teamai domains drift                              # 列出漂移建议
teamai domains drift <repoUrl> --apply            # 接受指定仓库的重分类
teamai domains drift --apply-all --threshold 0.8  # 自动应用高置信项
```

---

## 会话 Dashboard & Analytics

```bash
teamai stats              # 本地 skill 使用统计
teamai dashboard          # 启动 Web UI（默认端口 3721），实时查看团队编码会话
teamai digest             # 生成团队周活动摘要
teamai save-session       # 保存当前会话摘要
```

- `teamai track` / `teamai track-slash`：hook 自动调用，追踪工具使用事件
- `teamai dashboard-report`：hook 自动上报会话状态
- 数据存储路径：`~/.teamai/usage.jsonl`

---

## 支持的 AI 编码工具

| 工具 | Recall Agent | Hooks | CLAUDE.md 规则注入 |
|------|:---:|:---:|:---:|
| Claude Code | ✅ | ✅ | ✅ |
| CodeBuddy | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | — |
| Codex | ✅ | ✅ | — |
| OpenClaw | ✅ | — | — |
| WorkBuddy | ✅ | — | — |

---

## 管理员功能

```bash
# 角色管理
teamai roles init / add / remove / set

# 标签管理
teamai tags add / remove / subscribe / unsubscribe

# 跨团队源
teamai source add / remove / browse

# 环境变量
teamai env add / remove / list

# 成员管理
teamai members list
```

---

## 已知限制与注意事项

- `--from-org` 需要认证：工蜂使用 `~/.netrc` 或 `gf auth login`；GitHub 使用 `GITHUB_TOKEN` 或 `gh auth login`
- `--from-iwiki` 需要设置环境变量 `TAI_PAT_TOKEN`
- AI codebase 扫描大仓库可能需要数分钟，超时上限为 12 分钟
- 搜索索引中 codebase 条目的 Score 可能显示为 NaN，不影响排序，后续版本修复
- Phase 3（Vote 双计数器）和 Phase 4（置信度维护）将在后续版本实现
- 工蜂的 `--from-org` 支持已通过 TGit listOrgRepos 实现

---

## 反馈渠道

- 内部群聊 / issue 跟踪
- `teamai doctor` 可自助诊断配置问题
