# CI Code Erosion (informational)

> [English](ci-code-erosion.md) | [简体中文](ci-code-erosion.zh-CN.md)

The `Code Erosion` workflow (`.github/workflows/code-erosion.yml`) reports two
"code sloppiness" metrics on every pull request, using the official
[`scb-check`](https://pypi.org/project/scb-check/) tool (the SlopCodeBench
reference implementation, from [Measuring the sloppiness of
code](https://earendil.com/posts/measuring-code-sloppiness/)).

It is **informational only — it never blocks a merge.** The numbers are posted
as a PR comment (and mirrored to the run's job summary) for reviewers to
eyeball; they do not gate anything.

---

## What it measures

| Metric | Meaning |
|---|---|
| **Verbosity** | Fraction of source lines that are redundant: `\|clone lines ∪ wrapper lines ∪ ast-grep rule hits\| / SLOC`. |
| **Erosion** | Concentration of complexity in already-complex functions: `mass(f) = CC(f) × √SLOC(f)`; the share of total mass held by functions with cyclomatic complexity `> 10`. |
| **Cognitive erosion** | Same shape as erosion, but weighted by cognitive complexity instead of cyclomatic. An extra signal `scb-check` provides. |

Reference bands from the source post (calibrated on **Python** repos):

| Metric | Human repos | Agent-generated |
|---|---|---|
| Verbosity | 0.15 ± 0.06 | 0.33 ± 0.10 |
| Erosion | 0.31 ± 0.17 | 0.68 ± 0.20 |

---

## Important caveat for this TypeScript repo

`scb-check`'s verbosity signal has three components: clone detection, trivial
wrappers, and **197 hand-authored ast-grep rules**. Those 197 rules are
**Python-only** — they encode Python-specific wasteful patterns (dict idioms,
comprehensions, `for i in range(len(...))`, …) that have no TypeScript
equivalent. On this repo they contribute **0**.

So read the numbers this way:

- **`erosion` / `cognitive erosion` are faithful.** Cyclomatic and cognitive
  complexity are language-agnostic; the TypeScript implementation uses the same
  algorithm as Python.
- **`verbosity` is partial.** It reflects clone + wrapper detection only. The
  source post notes clones drive ~66% of agent slop growth and the ast-grep
  rules only ~15.6%, so the number still captures the larger part — but it is
  **not** directly comparable to the paper's verbosity figures or the
  Python-calibrated bands. Treat the bands as *direction*, not verdict.

---

## Current baseline

Scanned `src/` (tests excluded, see `scb-check.toml`), `scb-check==0.2.0`:

| Metric | Value | Reading |
|---|---|---|
| Verbosity | ~0.092 | below the human band |
| Erosion | ~0.65 | inside the agent band |
| Cognitive erosion | ~0.86 | — |

Erosion sits in the agent band mainly because of a handful of very large
functions (e.g. `pullForScope`, `init`, `pushCore`). That is the actionable
part of this report if the team ever wants to bring the number down.

---

## Details

- **Trigger:** any PR targeting `master` / `main`.
- **Tool version:** pinned to `scb-check==0.2.0` — the first release with
  TypeScript support. The version the paper pins, `0.1.3`, is Python-only.
  Pinning also keeps the numbers comparable across runs (the rule set changes
  between releases).
- **Scope:** `src/`, excluding `**/__tests__/**` and `*.test.ts` / `*.spec.ts`
  (configured in `scb-check.toml`), so metrics reflect the product surface, not
  the far larger test suite.
- **Never blocks:** `scb-check` exits non-zero when it finds any slop (the
  normal case). The workflow deliberately swallows that exit code; the job is
  always green.
- **Fork PRs:** the PR-comment step needs a write token, which fork PRs don't
  get. It degrades gracefully to the job summary — nothing fails.

## Run it locally

```bash
uvx --from 'scb-check==0.2.0' scb-check check src \
  --report --include-all --config scb-check.toml
```

Add `--output-format human` for a readable console table, or drop `--report`
for the default human output.

## Where to read results

1. **PR comment** — one comment per PR, updated in place on each push.
2. **Job summary** — the same table on the workflow run's summary page (the
   only surface on fork PRs).
