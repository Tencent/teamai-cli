# teamai-env-hint

[English](README.md) | 中文

会话开始时，teamai 列出这个范围交付的团队环境变量和密钥，并告诉 agent 需要它们的命令要通过 `teamai env exec` 运行。这个目录保存这条提示的文案。

## 替换它

把目录复制到团队仓库根目录，修改文案后推送。下一次 `teamai pull` 会检查并交付它：

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-env-hint" hooks/
```

这条提示没有参数，所以 `HOOK.yaml` 里只有 `description`。每个 `.md` 文案都要保留：缺少任何一个的替换会被拒绝。pull 也会拒绝 `with:` 键、`command`，以及文案不提供的变量。每次都会指出是哪个字段，并继续使用 teamai 自带的目录。替换必须放在团队仓库根目录，不能放在命名空间里。

## 文案

提示按下面的顺序，用空格把要显示的文案连起来。

| 文件 | 显示时机 | 变量 |
|---|---|---|
| `variables.md` | 这个范围交付环境变量时 | `{{ variables }}`，例如 `API_URL (the staging API), LOG_LEVEL` |
| `secrets.md` | 这个范围交付密钥时 | `{{ secrets }}`，形式相同 |
| `exec.md` | 总是 | 无 |
| `secrets-rule.md` | 这个范围交付密钥时 | 无 |

`teamai.yaml` 里设了 `language: zh` 或 `en` 时，目录里有 `<text>.zh.md` 或 `<text>.en.md` 就打印它，否则打印 `<text>.md`。

## 相关设置

- 这个范围既不交付环境变量也不交付密钥时，提示什么都不显示。
- `language` 决定用哪个文案版本。
