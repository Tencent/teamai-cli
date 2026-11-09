# teamai-todowrite-hint

[English](README.md) | 中文

agent 用 TodoWrite 规划任务后，teamai 建议它通过 `teamai-recall` subagent 检索一次团队知识库，每个会话一次。这个目录保存这条建议的文案。

## 替换它

把目录复制到团队仓库根目录，修改 `message.md` 后推送。下一次 `teamai pull` 会检查并交付它：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-todowrite-hint" hooks/
```

这条提示没有参数，所以 `HOOK.yaml` 里只有 `description`。每个 `.md` 文案都要保留：缺少任何一个的替换会被拒绝。pull 也会拒绝 `with:` 键、`command`，以及文案不提供的变量。每次都会指出是哪个字段，并继续使用 teamai 自带的目录。替换必须放在团队仓库根目录，不能放在命名空间里。

## 文案

| 文件 | 显示时机 | 变量 |
|---|---|---|
| `message.md` | TodoWrite 调用之后 | 无 |

`message.md` 是中英双语的。`teamai.yaml` 里设了 `language: en` 时，teamai 打印只有英文的 `message.en.md`。设了 `language: zh` 时，目录里有 `message.zh.md` 就打印它，否则打印 `message.md`。

## 相关设置

- `TEAMAI_RECALL_DISABLED=1` 会连同 recall 一起关闭这条提示。
- `language` 决定用哪个文案版本。
