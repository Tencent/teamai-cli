# Dashboard

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

浏览器打开 `http://localhost:3721`。侧栏是总览、团队执行、团队上下文、团队改进。数据是这台机器上的。

## 人工干预指标（Human Intervention）

每个会话计三种次数：中途打断（`interrupt`）、拒绝工具调用（`toolReject`）、结束后马上用「不对 / 重来 / wrong」这类词纠正（`correction`）。

团队可以加自己的词：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, "no era eso"]
```

改完后下次 `pull` 起的新输入才按新词计算。上报到团队的是次数，不是原文。

## 对话量与 Token 用量

会话行上有对话轮数和 token。拿不到用量的工具，token 显示为 0。

## Session Save（会话存档）

```bash
teamai session save
teamai session save --session-id <id>
teamai session save --push
teamai session save --push --force
```

本地写到 `~/.teamai/session-logs/<年-月>.md`。`--push` 把有摩擦或用了至少 3 种工具的会话交到团队的 `teamai-reports` 分支。默认不带 prompt 原文。

## Session 同步与迁移（Session Sync & Migration）

除了摘要之外，`teamai session` 还能在不同 AI 工具之间迁移完整会话，并把会话归档到团队仓库。`session save` 记录的是脱敏摘要，而这一组命令搬运的是会话的全部消息。

支持的平台：`claude-code`（含 `claude-internal` / `tclaude` 变体）、`codex`（含 `codex-internal` / `tcodex`）、`codebuddy`（CLI）、`codebuddy-ide`（IDE 侧边栏）、`cursor`、`workbuddy`。运行 `teamai session platforms` 查看本机已安装哪些。

```bash
teamai session platforms                                             # 支持 vs 已安装
teamai session migrate <sessionId> -s codebuddy-ide -t claude-code   # 跨工具迁移单条会话
teamai session migrate --all -s codebuddy -t claude-code              # 该源的全部会话（--limit 可限量）
teamai session rollback <targetSessionId> --platform claude-code     # 撤销一次迁移
teamai session push --source codebuddy            # 归档当前目录的会话
teamai session push --source codebuddy --all      # 该平台的全部工作区
teamai session pull                               # 拉取并重建团队会话索引
teamai session list                               # 当前项目的团队会话
teamai session list --all                         # 全部归档项目
teamai session search <query> [--all]             # 全文搜索归档内容
teamai session resume <sessionName> --platform claude-code   # 恢复到本地工具
```

以上命令均支持 `--dry-run` 与 `-v`。`migrate --push` 一步完成迁移 + 归档；`resume` 会打印新的会话 id，用工具自身的 resume 参数继续。

**确认提示。** `--all` 超过 10 条（push 为超过 5 条）会先列清单要求确认；非交互运行（CI / 脚本）直接拒绝并以非 0 退出，避免脚本以为整批都跑完了——用 `-y` 明确确认。同平台迁移会复用原生会话 id 覆盖源会话，必须给 `--target-cwd <dir>`（写到别处）或 `-y`。`push` 在归档未脱敏原文前也会先问一次，`--scrub` 可先脱敏。

**选择会话。** `migrate` 不带会话 id 时每屏列出 10 条：`n` / `p` 翻到下一页 / 上一页，数字直接选择（编号是全局的，所以第二页从 11 开始），回车取消。用 `--all`（可配 `--limit <n>`）无需挑选直接迁移，或给出会话 id 前缀指定某一条。

**归档布局。** 会话按其工作目录的 git 标识归档到团队仓库的 `sessions/repos/<repo>/<author>/`；非 git 目录的会话落入 `_unattributed`。归档键取自会话自身的工作区——而不是执行命令时所在的目录——从别的目录迁入也会归到正确的项目名下。CodeBuddy IDE 中无法还原工作区的会话会带警告归入 `_unattributed`。

**项目级 vs 用户级仓库。** `list` / `pull` / `resume` 按当前目录的 git remote 过滤，项目级团队仓库因此只显示本项目的会话。传入 `--repo-root <任意 clone>`（例如个人仓库）并配合 `--all`，即可跨全部归档项目读取。
