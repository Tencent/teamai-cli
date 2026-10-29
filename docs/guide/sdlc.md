# Task documents and human confirmation

TeamAI manages task documents alongside code. Global product, architecture and
deployment documents stay in Octo Docs/Drive; Octo Loop owns task identity and
collaboration. The executing Agent reads Octo through its CLI with an explicitly
chosen profile. TeamAI has no Octo client or server credentials.

Load `teamai skill get sdlc`. Templates and helpers are under the directory returned
by `teamai skill path sdlc`. Use a business repository worktree, even when the team
asset repository is elsewhere. A task's set is
`intent/<workspace-id>/<task-id>/{intent,spec,plan}.md`, created as needed and
committed with code. These filenames follow Anthropic's SDLC playbook; the path
and OKF type names are TeamAI conventions. Shared docs synchronization does not
own this directory.

An Agent writes and commits each stage, runs the packaged `check.mjs` helper,
and requests a review with `review.mjs --request`. Both accept `--workspace`,
`--task`, and `--stage intent|spec|plan` from the Git root. The product owner
reviews intent and spec; the engineering owner reviews plan.

The person runs `review.mjs --workspace <id> --task <id> --respond <request-id>`
in their own interactive terminal and types approve, reject or cancel. The helper
displays committed file versions and records their TeamAI member name. Agent
sessions and noninteractive answers are rejected. This is local attribution,
not SSO or a new organization permission system.

Run `review.mjs ... --stage <stage> --approved` before dependent work and before
PR delivery. Changed intent invalidates spec and plan; changed spec invalidates
plan. Code-only commits leave unchanged document approvals valid. Requests and
answers are append-only in the Git common directory, shared by worktrees.
`--history` returns the audit record. A new clone needs fresh confirmation;
exported history is evidence only. No approval Markdown file is added.

The Agent implements, tests and opens the PR using existing tools. Include the
review summary, file versions and checks actually executed. Failures remain
failures. A requested stop after intent, spec or plan is reported as such.
A PR is not a merge, deployment, authority update or automatic Loop completion.
Loop writes require separate task authorization.

## OKF and migration

New task and managed knowledge documents use YAML frontmatter with a nonempty
`type`; unknown metadata and producer-defined types are preserved. Sources use
OKF objects and ordinary Markdown links. Reserved `index.md` and `log.md` follow
their own rules. Format validity, human review, correctness and test success are
separate. Confidence and votes never imply verification.

Run `check.mjs --file <path>` for diagnostics, or add
`--migrate --type '<owner-selected type>'` for a JSON before/after preview. The
helper writes nothing. Apply reviewed changes in a worktree. Keep ambiguous
metadata and originals; moving authority into Octo is a separate migration.
Skills and Rules keep their native execution format.

## Removed services

Workflow execution, Models catalogs/switching, Dashboard, Scorers and session
ratings (including historical rating readers/publishers) have been removed.
The HTTP/ClawPro reporting, synchronization, resource delivery and project binding
commands are also removed. Existing Git sources still deliver Skills, Rules and
MCP through the tool adapters. A future Octo source can reuse these adapters;
this release implements no Octo distribution API.

Legacy workflow runs cannot resume. Old scoring/settings files do not reactivate
removed features. No user transcript, Git history or original knowledge is
silently deleted. Existing credential exclusions stay protected; native tool
model configuration is no longer managed. Initialize a Git team repository to
replace a legacy HTTP-only setup.
