# Contribute — Share Session Knowledge with Team

Summarize what you learned or accomplished in this AI coding session, then push it to the team knowledge base.

## When to Use

- When teamai suggests this session has valuable content worth sharing
- When you've solved a tricky problem and want to document the solution
- When you've discovered a useful workflow or pattern
- After a long session with diverse tool usage

## How It Works

1. **Summarize**: Review what happened in this session — tools used, problems solved, patterns discovered
2. **Generate document**: Write a concise Markdown document covering:
   - What was the task/problem
   - Key decisions and why
   - Solutions, workarounds, or patterns discovered
   - Tools/skills that were particularly useful
   - Gotchas or pitfalls to avoid
3. **Save to temp file**: Write the document to a temporary file
4. **Push to team**: Run `teamai contribute --file <path> --title "<title>"`

## Document Template

```markdown
# <Title>

**Author:** <username>
**Date:** <date>
**Tags:** troubleshooting | workflow | pattern | tool-usage | deployment

## Context
What were you trying to do?

## Solution
How did you solve it?

## Key Learnings
- Learning 1
- Learning 2

## Related Skills
- skill-name-1
- skill-name-2
```

## Example

```bash
# After AI generates the summary document at /tmp/session-summary.md
teamai contribute --file /tmp/session-summary.md --title "K8s pod startup timeout troubleshooting"
```

## Important

- Run this as a **sub-agent** (Agent tool) to avoid polluting the main session's context
- The document is pushed directly to master in the team repo's `ai-docs/` directory
- Team members will see it on their next `teamai pull`
- Keep summaries concise and actionable — this is a knowledge base, not a diary
