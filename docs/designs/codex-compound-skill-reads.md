# Codex skill reads in compound shell commands

> Status: **proposal**. This design is for a follow-up to the direct Codex skill-use support in #1245.

## The problem

Codex can load an installed skill by reading its `SKILL.md` from Bash. The
direct-read path already recognizes a simple reader command, and the prompt
hook recognizes `$skill` mentions. A shell call such as `pwd && cat
.codex/skills/review/SKILL.md`, however, is currently classified as an ordinary
shell call. Skill-use tracking only considers read calls, so it misses the
skill even when the read ran.

The shared shell classifier also feeds recall adoption. Broadening its
`category` or `paths` result to include possible reads would change a contract
that another feature relies on and could claim a read in a branch that never
ran. The existing simple-reader error handling can attribute a reported error
to a particular operand, but compound calls need to preserve that per-file
behavior without assigning an error from one reader to another.

## Goals

- Track a Codex skill only when the command syntax and available outcome
  evidence prove that a supported reader ran on its `SKILL.md`.
- Attribute recognized reader diagnostics to exact operands so a missing file
  does not hide a different skill file that the same reader successfully read.
- Keep installed-skill-root checks and once-per-session-turn credit unchanged.
- Keep the existing `classifyToolCall` result and recall-adoption behavior
  unchanged.

## Not in scope

- Changing prompt mention parsing, hooks, Codex skill installation, or the
  existing simple-read and pipeline rules.
- Treating arbitrary shell execution, script contents, or command output as
  proof that a skill was loaded.
- Supporting shell grammar that the current tokenizer cannot represent safely,
  including `if` blocks, loops, functions, subshells, brace groups, command
  substitutions, here-documents, or background jobs.
- Changing read tracking for other agents or shell tools.

## Design

Add a purpose-built shell-read extractor for Codex skill-use tracking. It uses
the existing tokenizer and reader/operand rules, but it does not change
`classifyShellCommand` or `classifyToolCall`. The new helper is consumed only
by `skill-use`; recall adoption continues to see the current classification.
The existing direct-read path remains the first choice. The new path applies
only to Codex Bash events whose shared classification is not already a read.

The helper accepts a deliberately small, foreground command-list grammar:

- Simple commands separated by `;` or newline are visited in order.
- `&&` and `||` are followed only when the prior command's status is known.
  Exact `true`, `false`, and `:` commands have known status. An event-level
  status constrains the final list only when no later command can mask it; a
  reader is returned only if every execution trace consistent with that
  evidence reaches it. Unknown guards leave the branch uncertain, so readers
  that might have been skipped are not returned. For example,
  `false && cat SKILL.md` is skipped;
  `false && echo skipped || cat SKILL.md` reaches the reader; and
  `pwd && cat SKILL.md` is skipped when no evidence establishes `pwd`'s
  outcome.
- A lone reader pipeline keeps the current classifier's behavior. A pipeline
  embedded in a larger list is outside this proposal.
- Any unsupported control construct, background operator, shell-level early
  terminator (`exit`, `exec`, `return`, `break` or `continue`), dynamic reader
  operand, shell-state or working-directory change (`cd`, `set`, `shopt`,
  `trap`, `source`, `eval`, and similar commands), or output/input redirection
  that makes the read uncertain causes the helper to return no candidate for
  the affected command list.

The helper returns only files belonging to reader commands proven to have run.
For each such reader, diagnostics are parsed using the same command-name and
file-name rules as current simple-read handling. The diagnostic path is
resolved against the hook cwd and compared to operands with the existing
platform-independent path comparison. Only an exact matching failed operand
is removed. If duplicate reads or output make attribution ambiguous, the
affected path is skipped. A reader or operand with an explicit failed status
and no evidence of a successful file read is not credited.

`skill-use` then applies its existing `SKILL.md` suffix extraction and
`isInstalledSkillFile` root check. Thus a path named like a skill outside an
installed root still cannot create usage, and the existing claims file still
deduplicates prompt and tool-call evidence in one turn.

## Test cases

- Preserve the public shell classifier result for compound commands; the new
  extractor alone returns skill-read candidates.
- Count an installed Codex skill read in an unconditional `;` or newline
  sequence, and count the current lone-reader pipeline case exactly as before.
- Follow statically proven branches (`true && cat`, `false && cat`, and
  `false && echo skipped || cat`); skip an unknown guard without sufficient
  outcome evidence.
- With multiple reader operands, exclude only the exact path named by a
  reader error and retain a different successfully read installed skill.
- Skip an explicitly failed skill-file read, ambiguous duplicate-path error
  attribution, unsupported shell constructs, uninstalled skills, files outside
  all skill roots, and non-Codex calls through this new path.
- Retain turn deduplication when a `$skill` prompt mention and a compound
  shell read refer to the same skill.

## Validation

Test the parser/extractor at the shell-tool-call seam and test crediting at the
`skill-use` hook seam. Also run the relevant type check, lint and unit tests.
Because this changes runtime behavior, the PR must include one representative
real-CLI run after build, as required by the repository contribution rules.
