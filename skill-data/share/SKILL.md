---
name: share
description: >-
  Turn a session into a team learning: summarize what was solved, discovered or worked around,
  and publish it to the team knowledge base with `teamai contribute`. Loaded on demand by the
  teamai discovery stub, by the learning step of the session-close workflow, and by the friction
  reminder where session-close is not offered.
---

# Contribute — share what a session taught you with the team

Summarize what this AI coding session taught you and push it to the team knowledge base.

## Who sent you here

- **The `learning` step of a `session-close` run** (its brief names this skill): work steps 1–3 of
  How It Works with the person, in this session rather than a sub-agent, and save the document
  outside the repository. Return its path, title and learnings namespace as the brief says. Do
  not run `teamai contribute`: the run's `contribute` step runs it after its approval.
- **The friction reminder** (its `[teamai]` text names `teamai skill get share`): teamai already
  found that `session-close` cannot run here. Follow How It Works to the end.
- **The person asked to share a learning, or to close, publish or score this session**: start the
  `session-close` workflow. Run `teamai workflow start --describe session-close --driver skill`,
  give the person each proposed input with its `why`, and start it with those values once they
  confirm or change them (`teamai skill get workflow` covers the run). Its `learning` step brings
  you back here. When describe refuses it (`invoke_denied`, `unattended_denied`,
  `nested_workflow`), tell the person why and follow How It Works to the end.
- **Anything else in When to Use**: follow How It Works to the end.

**Write the document in Simplified Chinese**, as earlier releases required. Commands, flags,
URLs, paths and code identifiers stay as they are.

## When to Use

- When teamai suggests this session has valuable content worth sharing
- When you've solved a tricky problem and want to document the solution
- When you've discovered a useful workflow or pattern
- After a long session with diverse tool usage
- When `teamai score` printed a label that did not pass: read the reasoning file it names
  (`<dataHome>/scores/reasoning/<labelVersion>.md`) and turn what went wrong into a learning,
  contributed with the `--session-id` that line gives, if any. Summarize it; do not paste the file

## How It Works

1. **Summarize**: review the tools used, the problems solved and the patterns found in this session
2. **Write the document**: a Markdown document (language as above) covering:
   - What the task or problem was
   - The key decisions and why they were made
   - The solution, workaround or pattern discovered
   - Which tools or skills proved especially useful
   - Pitfalls and things to watch out for
3. **Save it**: write the document to a temporary file
4. **Push it to the team**: run `teamai contribute --file <path> --title "<title>"`

## Document Template

Copy the template, the frontmatter field table and the tag taxonomy from
`{SKILL_DIR}/references/doc-template.md`. The frontmatter is required: it is what
makes the document searchable.

## Example

```bash
# After writing the summary to /tmp/session-summary.md
teamai contribute --file /tmp/session-summary.md --title "Debugging K8s pod startup timeouts"
```

## Important

- Outside a `session-close` run, run this as a **sub-agent** (Agent tool) to avoid polluting the main session's context
- The document is pushed to the team repo's `teamai-learnings` branch, under `learnings/`, with no pull request
- Team members will see it on their next `teamai pull`
- Keep summaries concise and actionable — this is a knowledge base, not a diary

## Publishing a reusable skill instead

A member asking to publish a skill ("share this xxx skill with my team") is a
different flow, and it does not need recall: it lives in the `core` skill, at
`"$(teamai skill path core)/references/contribute-member.md"`. This file
is for turning a *session* into a learning.

## References

In the files below, `{SKILL_DIR}` is the directory `teamai skill path share` prints; a reference file you open on its own writes that directory as `SKILL_DIR` in braces.

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/doc-template.md` | Writing the learning document: template, frontmatter fields, tag taxonomy. |

`teamai skill get share --full` prints this skill with its reference appended.
