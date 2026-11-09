<!-- [teamai:recall-rules:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Knowledge Recall (teamai)

> **Self-exemption (must read first):** If you ARE the `teamai-recall` subagent yourself, this rule does NOT apply to you — do not invoke `teamai-recall` (or any recall) again. Proceed directly to performing the knowledge search that is your task. This prevents infinite subagent recursion in tools (e.g. Cursor) whose always-apply rules leak into subagent sessions.
>
> **自豁免（务必先读）：** 如果你自己就是 `teamai-recall` subagent，本规则对你不适用——不要再调用 `teamai-recall`（或任何 recall），直接执行你本职的知识检索任务。此举防止在（如 Cursor 等）会把 always-apply 规则泄漏进 subagent 会话的工具中发生无限递归。

**Before** starting a task that involves code changes, debugging,
or design decisions, you **SHOULD** invoke the `teamai-recall`
subagent via the Agent tool with a concise natural-language
description of the task — unless one of these skip conditions applies:

1. **User already provided context** — the user referenced specific files,
   gave a solution, or said "the answer is in this directory/file".
2. **Local files have the answer** — the task info is directly available
   from the current workspace (e.g. fixing an obvious bug in the current file).
3. **Trivial/local change** — small modifications to known files (typo fix,
   parameter tweak, formatting) that need no additional knowledge.
4. **Task domain is outside team knowledge coverage** — the task is
   unrelated to this team's systems/workflows (e.g. generic language
   questions, pure frontend styling with no team-specific context).
   The recall subagent also runs a relevance precheck and returns fast
   for unrelated tasks, but skipping outright saves a subagent round-trip.

The subagent will return a compact summary of relevant team knowledge
(skills, learnings, docs, rules) without polluting this conversation
with raw content. For **feature/large tasks**, recall returns a
"Candidate change files" list — check your planned changes cover all
listed files before starting. For **bugfix/small tasks**, recall runs
a lighter pass and you may skip it entirely per condition 2–3 above.

**Important constraints on agent sequencing (when recall is invoked):**
1. Invoke `teamai-recall` subagent **first and alone** — never
   launch it in parallel with Explore or other research agents.
2. After recall returns results, use Read to get full content of the
   returned files if you need more detail. Do NOT launch Explore agents
   to search for the same topics — recall results + Read is the complete
   workflow for accessing team knowledge.
3. Explore/research agents have their own scope and must NOT overlap
   with recall:
   - **recall subagent covers:** team learnings, codebase docs, skills,
     rules, and anything under `.teamai/`, `learnings/`, `docs/team-codebase/`.
   - **Explore agents cover:** navigating source code in the current
     working directory, and web search for external information.
   - Explore agents must never search paths covered by recall.

<!-- [teamai:recall-rules:end] -->