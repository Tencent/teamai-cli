# 成员使用

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

## 成员接入

```bash
npm install -g teamai-cli
cd /path/to/my-project
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

新的 skill、rule、agent 会问放到哪个目录。已经开着的 pull request 会更新原来那一个。

### 查看状态

```bash
teamai status
```

### 角色管理

```bash
teamai roles list
teamai roles set hai
teamai pull
```

角色怎么定义，见[配置示例](./admin-setup.md#角色和项目)。

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

## 让分发的文件不进入 git

```yaml
sharing:
  gitExclude:
    enabled: true
```

`teamai pull` 把下发的路径写进本机 `.git/info/exclude`，不改 `.gitignore`。这些文件工具照常加载，`git status` 看不到。

本机项目配置里的 `gitExcludeEnabled` 优先。下一次 pull 生效。
