# teamai-recall

[English](README.md) | 中文

这个目录里是让 AI 工具在开始任务前检索团队知识库的 rule，以及在各工具指令文件里说同一件事的指令块。recall 开着时（`teamai recall enable`、`recallEnabled`），pull 会写入它们。

| 文件 | pull 怎么处理它 |
|---|---|
| `RULE.md` | 这条 rule。`language` 未设置或为 `zh` 时，以 `teamai-recall<ext>` 写入每个工具的 rules 目录 |
| `RULE.en.md` | `language: en` 时用的 rule |
| `block.md`、`block.en.md` | 给有 `teamai-recall` subagent 的工具的指令块 |
| `block-direct.md` | 给没有该 subagent 的工具的指令块，任何语言都用它；如果有 `block-direct.en.md`，`language: en` 时会用它 |
| `README.md`、`README.zh-CN.md` | 不处理：它们从不交付 |

pull 会在指令块周围加上块标记和 `DO NOT EDIT` 行。这些文件里没有模板变量。pull 会把 CRLF 换成 LF，并去掉末尾的一个换行。

## 替换它

把这个目录复制到团队仓库根目录的 `rules/teamai-recall/`，然后修改。之后每个成员拿到的都是团队的文件。

- `RULE.md`、`block.md` 和 `block-direct.md` 是必需的。
- 缺少某个语言文件时，回退到团队自己的基础文件，不会回退到 teamai 的。
- 每个 `RULE*.md` 都必须包含 `Nothing was searched:` 和 `Recall skips the older index`，每个 `block-direct*.md` 都必须包含 `Nothing was searched:`。recall 会打印这些行，rule 告诉 agent 遇到它们时该怎么做。
- pull 只以文本形式交付上面这些文件，所以任何文件都不能写 `${TEAMAI_RULE_DIR}`。示例或检查清单请直接写进文件里。

不符合以上要求的替换会被 pull 拒绝，pull 会指出是哪个文件，并继续使用 teamai 自带的目录。push 从不发布这条 rule。
