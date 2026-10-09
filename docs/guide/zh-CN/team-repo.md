# 团队仓库检出

> [English](../team-repo.md) | [简体中文](team-repo.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## Git 子模块

若团队以 git submodule 形式分发 skill，在 `teamai.yaml` 中开启 `submodules: true`：

```yaml
submodules: true
```

每次 pull 时 teamai 会执行 `git submodule update --init`，按团队仓钉住的版本
填充子模块（仅 git 仓后端生效；取完整子模块历史——浅取无法检出较旧的 pin）。
默认关闭。若更新失败，pull 会记录警告并保留旧的同步版本号，下次 pull 会重新
完整同步并自动重试（不会被"版本未变化"的快速路径跳过）。注意：子模块拉取
依赖环境现有的 git 凭据——若宿主机采用按命令注入 token 的认证方式（而非配置
credential helper），私有子模块将无法通过认证。

## Pull 后脚本

团队常常需要部署 teamai 内建面之外的内容（客户端可选模型、本机安装、PATH
shim 等）。在 `teamai.yaml` 中声明 `scripts.postPull`，teamai 会在一次 pull
完全结束后，为**拥有本机部署权的那个团队仓**运行该 Node 入口——项目 scope
激活时是项目仓，否则是用户仓（继承来的用户仓只带资源与知识，不带部署）：

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

路径相对团队仓根目录；解析到仓外（含经 symlink）会被拒绝。会话启动路径上，
脚本作为 pull 进程的子进程运行，并在固定预算内
被等待（导出 `TEAMAI_POSTPULL_TIMEOUT_SEC`，脚本可据此为重步骤自限）；预算
到期时脚本被留在后台继续跑而不是被杀，下次 pull 自会对账。交互式
`teamai pull` 则以 fire-and-forget 方式把脚本拉起进终端。路径非法、文件缺失
或拉起失败只会是 `~/.teamai/debug.log` 里的一行（`postPull: launched /
exited / timed out`），绝不会让 pull 失败。
