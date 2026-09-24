# Learning document template

**Required: the document must start with YAML frontmatter.** It feeds the search index
and is how other members discover the learning.

```markdown
---
title: "<short title naming the core problem or finding>"
author: <username>
date: <YYYY-MM-DD>
tags: [tag1, tag2, tag3]
---

## Context
What were you doing? What problem did you hit?

## Solution
How did you solve it? What were the key steps?

## Lessons
- Lesson 1
- Lesson 2

## Related Skills
- skill-name-1
- skill-name-2
```

### Frontmatter fields

| Field | Required | Meaning | Example |
|------|------|------|------|
| title | yes | Short title (under 60 characters) | "Diagnosing K8s Pod OOM kills" |
| author | yes | Contributor's username | jeffyxu |
| date | yes | Date as YYYY-MM-DD | 2026-03-28 |
| tags | yes | 2-5 key tags | [k8s, oom, troubleshooting] |

### Choosing tags

Pick 2-5 from these categories:
- **Stack**: python, typescript, go, k8s, docker, sglang, cuda
- **Problem type**: troubleshooting, performance, deployment, config, api
- **Pattern**: workflow, pattern, tool-usage, best-practice
- **Scenario**: debugging, testing, monitoring, security
