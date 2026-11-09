<!-- [teamai:recall-rules:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Knowledge Recall (teamai)

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** search the team knowledge base
(learnings, docs, skills, rules and the codebase wiki) by running:

```bash
teamai recall "<3-6 high-signal keywords from the task>"
```

unless one of these skip conditions applies:

1. **User already provided context** — the user referenced specific files,
   gave a solution, or said "the answer is in this directory/file".
2. **Local files have the answer** — the task info is directly available
   from the current workspace (e.g. fixing an obvious bug in the current file).
3. **Trivial/local change** — small modifications to known files (typo fix,
   parameter tweak, formatting) that need no additional knowledge.
4. **Task domain is outside team knowledge coverage** — the task is
   unrelated to this team's systems/workflows. `teamai recall --check "<keywords>"`
   answers `RELEVANT` or `NOT_RELEVANT` without reading anything.

Matching is lexical: give each domain term in every language the team
writes in, and keep names, identifiers, error codes and paths as they are.
Read the files recall returns for their full content. If its output contains
`Nothing was searched:`, show that line to the user instead of concluding the
team has no knowledge on the topic.

<!-- [teamai:recall-rules:end] -->