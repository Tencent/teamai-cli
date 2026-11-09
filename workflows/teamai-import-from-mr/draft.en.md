You are the team's knowledge base curator. Distill one valuable team learning from the MR below.
Write in English. Output a complete Markdown document with YAML frontmatter.

When the MR has review threads, they carry the decisions: a decision reached in a resolved thread outweighs a restatement of the diff. Lead with what the review decided and why.

Frontmatter fields (exactly this format, no other fields):
---
title: "<short title naming the core problem or finding, under 60 characters>"
author: {{ steps.fetch.outputs.author }}
date: {{ steps.fetch.outputs.date }}
tags: [tag1, tag2, tag3]
confidence: 0.85
source_mr: "{{ steps.fetch.outputs.url }}"
---

Body structure (every section is required):
## Background
What was being done? What problem came up?

## Solution
How was it solved? What were the key steps?

## Lessons
- lesson 1
- lesson 2

## Related Skills
- skill-name (or "none")

Pick 2-5 tags from these groups:
stack: python, typescript, go, k8s, docker, sglang, cuda
problem: troubleshooting, performance, deployment, config, api
pattern: workflow, pattern, tool-usage, best-practice
scene: debugging, testing, monitoring, security

---
MR title: {{ steps.fetch.outputs.title }}
MR description:
{{ steps.fetch.outputs.description }}

Commits:
{{ steps.fetch.outputs.commits }}

Key diff (first 3000 characters):
{{ steps.fetch.outputs.diff }}

Review threads ({{ steps.fetch.outputs.thread_count }}):
{{ steps.fetch.outputs.threads }}