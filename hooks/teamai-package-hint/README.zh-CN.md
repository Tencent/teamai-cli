# teamai-package-hint

[English](README.md) | 中文

会话开始时，如果 `teamai.yaml` 里团队的包声明在这台机器上次应用之后有变化，teamai 会告诉 agent 去查看它们并运行 `teamai packages`。这个目录保存这条提示的文案。

## 替换它

把目录复制到团队仓库根目录，修改 `message.md` 后推送。下一次 `teamai pull` 会检查并交付它：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-package-hint" hooks/
```

这条提示没有参数，所以 `HOOK.yaml` 里只有 `description`。每个 `.md` 文案都要保留：缺少任何一个的替换会被拒绝。pull 也会拒绝 `with:` 键、`command`，以及文案不提供的变量。每次都会指出是哪个字段，并继续使用 teamai 自带的目录。替换必须放在团队仓库根目录，不能放在命名空间里。

## 文案

| 文件 | 显示时机 | 变量 |
|---|---|---|
| `message.md` | 声明有变化时 | `{{ summary }}`，例如 "2 npm packages and 1 Claude plugin" |

`{{ summary }}` 保持英文。`teamai.yaml` 里设了 `language: zh` 或 `en` 时，目录里有 `message.zh.md` 或 `message.en.md` 就打印它，否则打印 `message.md`。

## 相关设置

- `TEAMAI_PACKAGE_HINT_DISABLED=1` 在单台机器上关闭这条提示。
- `language` 决定用哪个文案版本。
