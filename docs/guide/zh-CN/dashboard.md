# Dashboard

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

浏览器打开 `http://localhost:3721`。侧栏是总览、团队执行、团队上下文、资源、团队改进。数据是这台机器上的。

## 资源（Resources）

资源页列出团队仓库里的每条规则在当前工作区的情况：名称、命名空间、描述，以及 `pull` 是否会把它交付到这里。根规则人人都收到；命名空间规则跟随活跃的知识命名空间；同名根规则被活跃命名空间规则取代时会标注「已取代」；被标签订阅排除的规则也会标注。

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
