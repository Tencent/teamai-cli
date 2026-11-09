# teamai-recall

English | [中文](README.zh-CN.md)

The rule and the instruction blocks that tell an AI tool to search the team knowledge base before a task.

## Where pull writes each file

```mermaid
flowchart TD
    pull([teamai pull, for each tool]) --> on{Recall on?}
    on -- no --> gone([Writes nothing, and removes the copies it wrote])
    on -- yes --> src["The team's files when pull accepts the team repo's rules/teamai-recall/, else teamai's"]
    src --> rule{language: en?}
    rule -- yes --> r1["RULE.en.md, as the tool's rules/teamai-recall"]
    rule -- no --> r2["RULE.md, as the tool's rules/teamai-recall"]
    src --> sub{The tool has the teamai-recall subagent?}
    sub -- yes --> b1["block.md, or block.en.md with language: en"]
    sub -- no --> b2["block-direct.md, or block-direct.en.md with language: en when it exists"]
    b1 & b2 --> hook{The tool takes instructions from a session-start hook?}
    hook -- yes --> h1([The session-start hook adds the block])
    hook -- no --> h2([The block goes in the tool's instruction file])
    classDef file fill:#3b6ea5,stroke:#2b5079,color:#fff;
    classDef out fill:#2f8f4f,stroke:#1f6b39,color:#fff;
    classDef skip fill:#6b6b6b,stroke:#4a4a4a,color:#fff;
    class r1,r2,b1,b2 file;
    class h1,h2 out;
    class gone skip;
```

| File | Pull writes it |
|---|---|
| `RULE*.md` | To each tool's rules directory, as `teamai-recall<ext>` |
| `block*.md` | Into the instruction file, between the block markers and a `DO NOT EDIT` line |
| `README*.md` | Never |

Pull turns CRLF into LF and drops one trailing newline. The files hold no template variables.

## Replace it

```bash
cp -r "$(npm root -g)/teamai-cli/rules/teamai-recall" rules/
```

Then add your own text to each `RULE*.md`, such as a skip condition:

```markdown
## Skip for generated code

A change under `gen/` needs no team knowledge.
```

Push the folder. The next `teamai pull` gives every member the team's files instead of teamai's. `teamai push` never publishes the rule.

## What a replacement keeps

| File | Must | Why |
|---|---|---|
| `RULE.md`, `block.md`, `block-direct.md` | Exist | A missing language file falls back to the team's base file, never to teamai's |
| Every `RULE*.md` | Contain `Nothing was searched:` and `Recall skips the older index` | Recall prints those lines, and the rule tells the agent what to do with them |
| Every `block-direct*.md` | Contain `Nothing was searched:` | The same |
| Every file | Name no `${TEAMAI_RULE_DIR}` | Pull delivers only the files above, as text. Put an example in the file itself |

When a replacement breaks one of these, pull names the file and keeps teamai's folder.

## Settings that change it

| Setting | Team `teamai.yaml` | Member config | Environment | Effect |
|---|---|---|---|---|
| Recall | `sharing.recall.enabled` | `recallEnabled`, which `teamai recall enable` sets | `TEAMAI_RECALL_DISABLED=1` | When off, pull writes neither the rule nor the blocks |
| Language | `language` | | | `en` picks the `.en.md` files |

The member config is `~/.teamai/projects/<slug>/config.yaml` in a workspace, then `~/.teamai/config.yaml`. The environment wins over the member config, and the member config wins over the team. See [member settings](https://github.com/Tencent/teamai-cli/blob/main/docs/guide/reference.md#member-settings) for the defaults.
