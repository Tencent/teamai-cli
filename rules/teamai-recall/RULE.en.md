# Team Knowledge Recall (teamai)

> **Self-exemption (must read first):** If you ARE the `teamai-recall` subagent yourself, this rule does NOT apply to you — do not invoke `teamai-recall` (or any recall) again. Proceed directly to performing the knowledge search that is your task. This prevents infinite subagent recursion in tools (e.g. Cursor) whose always-apply rules leak into subagent sessions.

## Rule: search the team knowledge base before a task (recommended)

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** search the team knowledge base
— unless one of the skip conditions below applies.

### Skip conditions (any one is enough to skip the search)

1. **The user already provided context** — the message names files, gives a solution, or says the answer is in the current directory or this file
2. **The local files already have the answer** — the task can be done from the current workspace (for example, an obvious bug in the file being edited)
3. **A small or local change** — a narrow edit to a known file (a typo, a parameter value, formatting) that needs no extra background

### Option 1: Subagent (preferred when the tool has an Agent tool)

Call the `teamai-recall` subagent (in the agents/ directory) with a natural-language description of the task.
It returns a structured summary of team knowledge (skills, learnings, docs, rules, codebase).

### Option 2: Bash command (works in every tool)

```bash
teamai recall "<keyword1> <keyword2> ..."
```

Extract 3-6 high-signal keywords from the task description.

If the output contains `Nothing was searched:`, this project's teamai config cannot be
read and no team knowledge was searched: show that line to the user rather than
concluding the team has no knowledge, and do not move the file or run `teamai init`
without their consent. If it contains `Recall skips the older index`, that scope was not
searched: relay that warning rather than conclude the team has no knowledge there.

**Search in both languages (cross-language recall):** the knowledge base mixes English and Chinese, and search is lexical, so a query in one language misses documents written only in the other. Give each domain term in both languages in the same query. Translate only terms whose English and Chinese forms actually differ. Leave every language-independent token unchanged — proper nouns, brand and product names, abbreviations, code identifiers and symbols, error codes, versions, file paths, commands, and API names (`AppID`, `Kubernetes`, `GPU`, `RuntimeError`, `v2.1.3`, `oauth`). Translating those only hurts matching.
