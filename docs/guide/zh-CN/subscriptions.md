# 跨团队 Skill 订阅

> [English](../subscriptions.md) | [简体中文](subscriptions.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

`teamai source` 让你订阅其他团队的公共 skill 仓库，pull 时自动获取最新 skills：

```bash
# 添加订阅源
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# 查看订阅列表
teamai source list

# 浏览订阅源的 skills
teamai source browse other-team

# 移除订阅（同时清理其 skills）
teamai source remove other-team
```

订阅源的 skills 在 `teamai pull` 时自动同步到本地，与团队自有 skills 共存。`teamai source add`/`remove` 会立即更新当前 scope 的团队仓，因此改动尚未提交时，本机的 `list`、`browse` 和 `pull` 也会使用它。订阅配置存储在该仓库 `teamai.yaml` 的 `sources` 字段中。运行 `teamai push` 会开一个包含配置改动的 PR；合入后，每位成员的 `teamai pull` 都会自动获取到新的订阅源。

订阅源的 skills 与团队自有 skills 落在同一位置，且只送达已启用的工具。

订阅 skill 路径上你自己的文件会保留并点名，不会被覆盖。`source remove` 只清理当前这次安装。缓存、锁，以及 pull 拒绝删除文件的情况，见[跨团队订阅源的安装归属](../../designs/data-directory-layout.md#cross-team-source-installation-ownership)。

源仓只会共享它在自己 `teamai.yaml` 的 `publicSkills` 列表里显式声明的 skill。如果对方仓库没有 `teamai.yaml`，或没有声明 `publicSkills`，`teamai source add` 仍会成功，但会警告该源将同步 **0 个 skill**——需要对方团队先发布 `publicSkills` 列表，才会有内容流转过来。

## HTTP 源

除了 git 订阅源，还可以在已有 git 主仓的基础上附加一个 HTTP 源——适用于服务端管理的 skill 下发：

```bash
# 附加 HTTP 源（git 主仓不受影响）
teamai source add-http https://your-team-host/api --token <api-key>

# 查看（在 "HTTP source" 下显示）
teamai source list

# 解绑并卸载其资源
teamai source remove-http
```

HTTP 源通过 hook dispatch 上报状态并拉取 skill 指令。其他 HTTP 源操作持有锁时，hook 同步会跳过，后续 hook 事件会再次尝试。每个安装仅支持一个 HTTP 源。若主仓本身已是 HTTP 模式（`init --http`），则 `add-http` 不可用（主仓已占用 HTTP 配置）。

`source remove-http` 会等待正在运行的 HTTP 同步或插件协调结束，最多等待 30 秒。若无法获得共享锁，命令以退出码 1 结束且不开始清理；请等当前操作结束并检查目录权限后重试。获得锁后，命令会先禁用源，再清除 endpoint、凭据和缓存，并保留禁用配置，防止旧配置或环境变量重新连接。若某个 hook 无法移除，其记录会保留，命令以退出码 1 结束。修好命令指出的 settings 文件后再次运行即可。`source add-http` 或 `init --http` 可重新启用源。

自建后端要实现的 `teamai init --http` 接口见 [HTTP 契约](./http-contract.md)。
