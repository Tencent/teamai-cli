# 成员使用

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

## 成员接入

```bash
npm install -g teamai-cli
cd /path/to/my-workspace
teamai init https://github.com/your-org/your-repo
```

整台机器：

```bash
teamai init https://github.com/your-org/your-repo --scope user
```

不配平台 token，用已有的 SSH Key 或 Git 凭据：

```bash
teamai init https://gitlab.example.com/yourgroup/yourrepo --provider git
```

只影响本机。`push` 会推送分支，PR/MR 需要自己到 Git 平台上创建。

只读、不使用 git：

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

```bash
teamai doctor
teamai list
```

## 日常使用

### 自动同步

会话启动时会 `teamai pull`。工具没有这条 hook 时，自己跑一次。

你改过的 skill、rule、agent，pull 会留下。

```bash
teamai pull
teamai pull --dry-run
```

### 团队包

```bash
teamai packages
```

团队的 `packages` 有变化时，会话启动会提示你跑这条。不会自动安装。

### 排除个人不需要的 Skill

```bash
teamai skill exclude add using-superpowers
teamai pull

teamai skill exclude remove using-superpowers
teamai pull
```

只影响本机。

### 推送本地资源

```bash
teamai push
teamai push --role pm
```

新的 skill、rule、agent 会问放到哪个目录，选项来自你的角色和当前项目。已经开着的 pull request 会更新原来那一个。

### 查看状态

```bash
teamai status
```

### 角色管理

```bash
teamai roles list
teamai roles set hai   # 团队统一分配角色时除外（见下）
teamai pull
```

角色怎么定义，见[分发管理机制](./distribution.md#角色和项目)。如果团队在 `manifest/members.yaml` 里分配角色，你的角色由该文件决定：`roles list` 显示它们，`roles set` 会被拒绝，改动要通过该文件——见[在团队仓库里分配角色](./distribution.md#在团队仓库里分配角色)。

### 标签订阅

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
teamai pull
```

## 提交 Co-Author 署名

团队仓库的 `teamai.yaml`：

```yaml
sharing:
  coAuthor:
    enabled: false
```

`false` 去掉提交尾注，`true` 保留。不写这一项，teamai 不改各工具自己的设置。

本机 `~/.teamai/config.yaml` 的 `coAuthorEnabled` 优先。下一次 `teamai pull` 写入各工具的配置。

## 自动压缩阈值

团队仓库的 `teamai.yaml`：

```yaml
sharing:
  autoCompact:
    tokens: 400000
```

之后上下文达到约 400K tokens 时，各 AI 工具会在下一次压缩检查时压缩对话；长的一轮在检查前可能略超过这个数。各工具按自己的方式换算：

| 工具 | 写入的设置 |
|------|-----------|
| Claude Code、TClaude | `settings.json` 的 `autoCompactWindow` = tokens + 33K |
| CodeBuddy、WorkBuddy | `settings.json` 的 `autoCompactWindow` = tokens ÷ 工具的运行中压缩比例（0.92，WorkBuddy 为 0.9） |
| Codex、TCodex | `config.toml` 的 `model_auto_compact_token_limit` = tokens |
| DeepSeek Harness | `cordis.patch.yml` 中 `compaction-basic` 一行，每个模型一个比例 |

模型自身窗口更小时，工具仍按模型窗口压缩，所以小窗口模型不受影响。工具无法接受这个数时，teamai 跳过它并说明原因：有环境变量覆盖了该设置、CodeBuddy 自定义模型没有 `maxInputTokens`、或 DeepSeek Harness 没有合适的模型。Cursor 没有这类设置。pull 之后重启工具生效。

这些文件是整台机器共用的，所以只由一个 scope 决定：有 user scope 时用它，否则用 pull 所在的 workspace。你自己设的值不会被覆盖。该 scope 配置里的 `autoCompactTokens` 优先，`0` 表示不参与。团队删掉这一项后，下一次 `teamai pull` 移除 teamai 写入的值。

## 让分发的文件不进入 git

```yaml
sharing:
  gitExclude:
    enabled: true
```

`teamai pull` 把下发的路径写进本机 `.git/info/exclude`，不改 `.gitignore`。这些文件工具照常加载，`git status` 看不到。

本机项目配置里的 `gitExcludeEnabled` 优先。下一次 pull 生效。
