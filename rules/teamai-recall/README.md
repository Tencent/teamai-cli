# teamai-recall

English | [中文](README.zh-CN.md)

The rule that tells an AI tool to search the team knowledge base before a task, and the instruction blocks that say the same in each tool's instruction file. Pull writes them while recall is on (`teamai recall enable`, `recallEnabled`).

| File | What pull does with it |
|---|---|
| `RULE.md` | The rule, written to each tool's rules directory as `teamai-recall<ext>` when `language` is unset or `zh` |
| `RULE.en.md` | The rule with `language: en` |
| `block.md`, `block.en.md` | The block for tools with the `teamai-recall` subagent |
| `block-direct.md` | The block for tools without it, in every language; a `block-direct.en.md` would take `language: en` |
| `README.md`, `README.zh-CN.md` | Nothing: they are never delivered |

Pull adds the block markers and the `DO NOT EDIT` line around a block. The files hold no template variables. Pull turns CRLF into LF and drops one trailing newline.

## Replacing it

Copy this directory to `rules/teamai-recall/` at the root of the team repo and edit it. Every member then gets the team's files instead.

- `RULE.md`, `block.md` and `block-direct.md` are required.
- A missing language file falls back to the team's base file, never to teamai's.
- Every `RULE*.md` must contain `Nothing was searched:` and `Recall skips the older index`, and every `block-direct*.md` must contain `Nothing was searched:`. Recall prints those lines, and the rule tells the agent what to do with them.
- Pull delivers only the files above, as text, so no file names `${TEAMAI_RULE_DIR}`. Put an example or a checklist in the file itself.

Pull refuses a replacement that breaks this, names the file, and keeps teamai's folder in force. Push never publishes the rule.
