# teamai command reference

Every public command the installed CLI accepts, rendered from its own command
table. Hidden commands are left out: they are hook plumbing the CLI runs itself,
never something to type. Flags marked `(hidden)` work but are absent from
`--help`, so treat this file — not `--help` — as the complete list of flags.

Generated: do not edit by hand. Regenerate with
`npx vitest run commands-reference -u` after changing a command or a flag.


## Global options

- `-V, --version` — output the version number
- `--dry-run` — Preview mode, no changes made
- `-v, --verbose` — Verbose output

## init

- `teamai init [repo]` — Initialize teamai (configure Git provider, clone repo, register member)
  - `--repo <repo>` — Team repo (alias of the positional argument)
  - `--http <url>` — Git-free HTTP team repo (read-only consumer; only needs an API key)
  - `--self` — Single-repo mode: the current git repo is the team repo (equivalent to `teamai init .`). Knowledge lives on main under .teamai/; reports go to the teamai-reports orphan branch.
  - `--token <key>` — API key for HTTP team repo / status reporting (stored 0600, never committed). Also reads TEAMAI_API_TOKEN.
  - `--scope <scope>` — Install scope: project (default, <cwd>/.teamai + <cwd>/.claude) or user (~/.teamai + ~/.claude)
  - `--inherit-user-scope` — In project scope, also sync safe user-scope resources and search its knowledge
  - `--no-inherit-user-scope` — Disable user-scope inheritance for this project
  - `--role <id>` — Primary role ID (e.g. hai_dev) for non-interactive setup
  - `--project <ids>` — Active logical project(s) from manifest/projects.yaml (comma-separated); scopes which project resources and learnings this directory syncs. Pass "all" to activate every project the manifest declares (a snapshot taken now)
  - `--agent <name>` — AI tools to set up (e.g. claude, codex, cursor, codebuddy, workbuddy, dsh). Repeatable or comma-separated. In single-repo mode, selects which tool dirs to create; omit for an interactive picker. Additive on repeated runs.
  - `--force` — Overwrite existing config without confirmation

## push

- `teamai push` — Push local resources to team repo
  - `--all` — Push all without confirmation
  - `--skill <path>` — Push a specific skill by path (e.g., ~/.claude/skills/hai/my-skill or skills/hai_dev/my-skill)
  - `--role <id>` — Namespace for new skills, rules and agents (skills/<id>/, rules/<id>/, agents/<id>/)
  - `--project <id>` — Target a project: each new resource goes to that project's namespace for its own type — skills, knowledge for rules, agents (from manifest/projects.yaml)
  - `--branch <name>` — Push to this destination branch instead of a generated teamai/push branch

## pull

- `teamai pull` — Pull team resources and inject into local AI tools
  - `--silent` — Silent mode (for hooks)
  - `--force` — Force full sync even if repo is unchanged

## status

- `teamai status` — Show local vs team repo diff
  - `--all` — List every project data partition under ~/.teamai/projects (flags stale/orphan ones)

## list

- `teamai list [type]` — List resources (skills|rules|docs|env|agents|hooks|mcp). For skills, --source local/all also scans installed AI agent skill directories.
  - `--source <src>` — Where to look for skills: repo | local | all
  - `--agent <name>` — Filter local agents by id (only applies to skills)
  - `--reveal` — Show env values in plaintext (default: masked)

## skill

- `teamai skill` — List and inspect skills (default: repo + installed agents, then the CLI-served catalog)
  - `teamai skill list` — List team and installed skills, then the built-in catalog the CLI serves
    - `--json` — Output the CLI-served built-in skill catalog as JSON
  - `teamai skill get [names...]` — Print built-in skill content served by the installed CLI
    - `--full` — Append the skill's references/ and templates/ files
    - `--all` — Print every skill the CLI serves
  - `teamai skill path <name>` — Print the packaged directory of a built-in skill (for scripts and templates)
  - `teamai skill show <name>` — Show skill metadata: source / contributors / installed agents / description
  - `teamai skill exclude` — Manage per-user skill exclusion (skip sync without affecting team repo)
    - `teamai skill exclude list` — List excluded skills
    - `teamai skill exclude add <skills...>` — Add skill(s) to the exclude list
    - `teamai skill exclude remove <skills...>` — Remove skill(s) from the exclude list

## members

- `teamai members` — Manage team members
  - `teamai members list` — List team members

## remove

- `teamai remove <type> <names...>` — Remove resource(s) from team repo and all local AI tools (type: skills|rules|agents|mcp)
  - `--force` — Skip confirmation prompt

## packages

- `teamai packages [target]` — Install team npm packages and Claude plugins declared in teamai.yaml
  - `-g, --global` — Install an npm target globally (for CLI tools)
  - `--registry <url>` — Use a specific npm registry for this target
  - `--npm` — Treat an ambiguous target as an npm package
  - `--claude` — Treat the target as a Claude plugin
  - `teamai packages install [target]` — Install team npm packages and Claude plugins declared in teamai.yaml
    - `-g, --global` — Install an npm target globally (for CLI tools)
    - `--registry <url>` — Use a specific npm registry for this target
    - `--npm` — Treat an ambiguous target as an npm package
    - `--claude` — Treat the target as a Claude plugin

## doctor

- `teamai doctor` — Diagnose configuration issues
  - `--json` — Output the report as JSON (suitable for CI)

## roles

- `teamai roles` — Manage team roles and resource namespaces
  - `teamai roles init` — Create a roles manifest for the team repo (admin)
  - `teamai roles list` — List all defined roles and your current role
  - `teamai roles set <primary>` — Set your primary role (updates local config)
    - `--add <roles...>` — Additional roles to include
  - `teamai roles add <id>` — Add a new role to the manifest (admin)
    - `--namespaces <ns>` — Comma-separated resource namespaces (e.g. common,hai)
    - `-d, --description <desc>` — Description for the role
  - `teamai roles remove <id>` — Remove a role from the manifest (admin)
  - `teamai roles update <id>` — Update a role in the manifest (admin)
    - `--add-namespaces <ns>` — Comma-separated namespaces to add
    - `--remove-namespaces <ns>` — Comma-separated namespaces to remove
    - `-d, --description <desc>` — New description for the role

## projects

- `teamai projects` — Manage multi-project resource distribution (orthogonal to roles)
  - `teamai projects list` — List defined projects and the ones active in this directory
  - `teamai projects set [ids...]` — Set the projects active in this directory (comma-separated or repeated; empty to clear)
  - `teamai projects add <id>` — Add a project to manifest/projects.yaml, creating the file if needed (admin)
    - `--namespaces <ns>` — Comma-separated namespaces for every project resource type (e.g. common,checkout)
    - `--name <name>` — Display name for the project
    - `-d, --description <desc>` — Description for the project
  - `teamai projects update <id>` — Update a project in manifest/projects.yaml (admin)
    - `--add-namespaces <ns>` — Comma-separated namespaces to add to every resource type
    - `--remove-namespaces <ns>` — Comma-separated namespaces to remove from every resource type
    - `--name <name>` — New display name for the project
    - `-d, --description <desc>` — New description for the project
  - `teamai projects remove <id>` — Remove a project from manifest/projects.yaml (admin)
  - `teamai projects members <id>` — List members registered for a project

## tags

- `teamai tags` — Manage tag-based skill/rule filtering
  - `teamai tags list` — List all available tags and subscription status
  - `teamai tags subscribe <tags...>` — Subscribe to tags (only matching skills/rules will be synced)
  - `teamai tags unsubscribe <tags...>` — Unsubscribe from tags
  - `teamai tags add <type> <name> <tags...>` — Add tags to a skill or rule in tags.yaml (admin)

  <type>  Resource type: "skills" or "rules"
  <name>  Name of the skill or rule (directory name)
  <tags>  One or more tags to add

  Examples:
    $ teamai tags add skills hai-deploy hai infra
    $ teamai tags add rules common-coding-style coding best-practices

  - `teamai tags remove <type> <name> <tags...>` — Remove tags from a skill or rule in tags.yaml (admin)

  <type>  Resource type: "skills" or "rules"
  <name>  Name of the skill or rule (directory name)
  <tags>  One or more tags to remove

  Examples:
    $ teamai tags remove skills hai-deploy infra
    $ teamai tags remove rules common-coding-style best-practices


## source

- `teamai source` — Manage cross-team skill sources
  - `teamai source add <repo>` — Add a cross-team source repo
    - `--name <name>` — Alias for this source
  - `teamai source remove <name>` — Remove a source and clean up its skills
  - `teamai source add-http <endpoint>` — Add an HTTP source (report/sync/ack) alongside a git main repo
    - `--token <key>` — API token for the HTTP endpoint (stored 0600, never committed)
    - `--force` — Overwrite an existing HTTP source config
  - `teamai source remove-http` — Remove the HTTP source and clean up its resources
  - `teamai source list` — List all configured sources
  - `teamai source browse <name>` — Browse public skills from a source

## update

- `teamai update` — Check for updates and upgrade teamai CLI
  - `--check` — Only check if an update is available, do not install

## uninstall

- `teamai uninstall` — Remove all teamai-managed resources and hooks from this machine
  - `--force` — Skip confirmation prompt
  - `--agent <name>` — Only uninstall this agent's resources; shared resources go only if it is the last tool

## env

- `teamai env` — Manage team environment variables
  - `--reveal` — Show env variable values in plaintext (default: masked)
  - `teamai env list` — List team environment variables
    - `--reveal` — Show env variable values in plaintext (default: masked)
  - `teamai env add <key> <value>` — Add or update a team environment variable
    - `-d, --description <desc>` — Description for the variable
  - `teamai env remove <key>` — Remove a team environment variable

## hooks

- `teamai hooks` — Manage teamai hooks in AI tool settings
  - `teamai hooks list` — List hook install status + effective built-in (A) and team (B) hooks
  - `teamai hooks inject` — Inject teamai hooks into all AI tool settings
    - `--silent` — Silent mode (suppress success message)
  - `teamai hooks remove` — Remove teamai hooks from all AI tool settings

## mcp

- `teamai mcp` — Manage team MCP servers across AI tools
  - `teamai mcp list` — List team MCP servers and their per-tool install status
  - `teamai mcp inject` — Inject team MCP servers into all AI tool configs
    - `--dry-run` — Show what would change without writing
    - `--force` — Overwrite servers that collide with user-owned entries
  - `teamai mcp remove` — Remove all teamai-managed MCP servers from AI tool configs

## webhook

- `teamai webhook` — Manage webhook integrations for team notifications
  - `teamai webhook list` — List configured webhook endpoints
  - `teamai webhook test` — Send test event to webhook endpoints
    - `--url <url>` — Test specific endpoint URL

## models

- `teamai models` — Share gateway model profiles and switch agents to them
  - `teamai models list [profile]` — Show team and personal model profiles, or one profile, and the agents using them
  - `teamai models add <id>` — Add a personal model profile stored only on this machine
    - `--name <name>` — Display name
    - `--protocol <protocols>` — Comma-separated: anthropic, openai-chat-completions, openai-responses
    - `--base-url <url>` — Gateway root URL (without /v1)
    - `--model <ids>` — Comma-separated model IDs; the first is the default
    - `--from-env <name>` — Read the API key from this environment variable
    - `--api-key-stdin` — Read the API key from stdin without placing it in shell history
  - `teamai models configure <profile>` — Set the API key of a profile, or edit a personal profile
    - `--from-env <name>` — Read the API key from this environment variable
    - `--api-key-stdin` — Read the API key from stdin without placing it in shell history
    - `--name <name>` — Personal profiles: new display name
    - `--base-url <url>` — Personal profiles: new gateway root URL
    - `--protocol <protocols>` — Personal profiles: serve models over these protocols too
    - `--model <ids>` — Personal profiles: add model IDs
  - `teamai models switch <profile>` — Point agents at a model profile (every compatible agent by default)
    - `--agent <name>` — Only switch this agent. Repeatable or comma-separated.
    - `--model <id>` — Default model to select (defaults to the first in the profile)
    - `--dry-run` — Show what would change without writing
  - `teamai models restore` — Restore agent model settings captured before the first TeamAI switch
    - `--agent <name>` — Only restore this agent. Repeatable or comma-separated.
    - `--dry-run` — Show what would change without writing
  - `teamai models remove <profile>` — Remove a personal model profile without changing agent settings

## stats

- `teamai stats` — Show local skill usage statistics
  - `--by-repo` — Break the local event log down per repository
  - `--by-time` — Show local event log activity by hour of day

## session

- `teamai session` — Record and inspect coding-session summaries
  - `teamai session save` — Record a privacy-scrubbed summary of a coding session to a local monthly log
    - `--session-id <id>` — Session to record (default: most recent, or $CLAUDE_SESSION_ID)
    - `--push` — Also push the summary to the team repo (feeds `teamai digest`)
    - `--force` — Push even if the session is not flagged as valuable
    - `--include-prompt` — Include the redacted first-prompt line in the pushed summary (default: off)
    - `--scope <scope>` — Config scope for --push: user | project (default: auto-detect)

## digest

- `teamai digest` — Generate weekly team activity digest

## dashboard

- `teamai dashboard` — Start the AI coding session dashboard (Web UI)
  - `-p, --port <port>` — Port number

## bind-project

- `teamai bind-project` — Bind the current workspace to a ClawPro project for HTTP local-agent sync
  - `--project-id <id>` — Project ID from /projects/mine
  - `--skip` — Mark current workspace as skipped (never prompt again)

## contribute

- `teamai contribute` — Contribute session knowledge to team repo
  - `--file <path>` — Path to the contribution document
  - `--title <title>` — Title for the contribution document
  - `--session-id <id>` — Session ID for dedup tracking
  - `--scope <scope>` — Target scope: user or project

## recall

- `teamai recall [query...]` — Search team learnings knowledge base
  - `--depth <level>` — Recall depth: route (entry-points only) | context (module-level, default) | lookup (full graph traversal)
  - `--check` — Relevance precheck only: print RELEVANT/NOT_RELEVANT + top score; no file reads, no upvote
  - `teamai recall disable` — Disable automatic knowledge-base recall
  - `teamai recall enable` — Enable automatic knowledge-base recall
  - `teamai recall status` — Show recall feature status
  - `teamai recall feedback` — Record manual feedback for a recalled document
    - `--positive <docId>` — Upvote a document (marks as actually useful)
    - `--negative <docId>` — Record negative signal for a document
  - `teamai recall maintenance` — Automatic maintenance of team knowledge base
    - `--prune` — Remove low-confidence learnings
    - `--threshold <n>` — Confidence threshold for pruning (default 0.15)
    - `--archive` — Move to archive/ instead of deleting
    - `--confidence-writeback` — Update frontmatter confidence scores
    - `--update-quality` — Find stale docs/rules/skills and suggest updates
    - `--dry-run` — Show what would be done without making changes
  - `teamai recall promote [learningId]` — Promote a high-confidence learning to formal knowledge (docs/skills/rules)
    - `--category <cat>` — Target category: skills | rules | docs
    - `--dry-run` — Show what would be done without making changes

## import

- `teamai import` — Import knowledge from local directories, remote repos, organizations, MRs, or iWiki
  - `--dir <path>` — Extract code knowledge from a local directory (same as --from-repo but no clone)
  - `--from-claude` (hidden) — Scan Claude/Cursor rule directories (the Claude root's rules/ — ~/.claude or the recorded toolRoots.claude — and ~/.cursor/rules)
  - `--from-mr <url>` — Extract learning from merged MR/PR and trigger incremental teamwiki update
  - `--from-iwiki <space-id-or-url>` — Import documents from iWiki Space ID or page URL (requires TAI_PAT_TOKEN)
  - `--resume` (hidden) — Resume an interrupted import session
  - `--all` — Accept all suggestions without interactive confirmation
  - `--output <path>` (hidden) — Write drafts to this directory instead of pushing to team repo
  - `--from-repo <url>` — Clone a remote repo and generate per-repo codebase summary
  - `--ssh` (hidden) — Force SSH clone even if HTTPS token is available
  - `--domain <name>` (hidden) — Skip AI recommendation and assign repo to this domain explicitly
  - `--from-repo-list <path>` — Batch import repos from a YAML whitelist
  - `--concurrency <n>` (hidden) — Concurrent repos for --from-repo-list (default 3)
  - `--incremental` — Use cached clone with fetch+reset (with --from-repo or --from-repo-list)
  - `--skip-enrich` — Skip AI enrichment (only clone + extract + graph, no LLM calls)
  - `--from-org <org>` — List repos under an org and generate a repo whitelist
  - `--max-repos <n>` (hidden) — Cap on repos pulled from --from-org (default 200)
  - `--exclude-archived` (hidden) — Exclude archived repos from --from-org (default true)
  - `--include-pattern <re>` (hidden) — Regex to include repos by full name (used with --from-org)
  - `--exclude-pattern <re>` (hidden) — Regex to exclude repos by full name (used with --from-org)
  - `--skip-import` (hidden) — Only write drafts; skip the actual --from-repo-list run
  - `--iwiki-dual` (hidden) — Enable dual-output mode for --from-iwiki (write codebase sections in addition to learning)
  - `--require-review` (hidden) — Defer codebase section writes to .teamai/pending-review.jsonl for human review
  - `--cache-status` — Show import cache status (repos cached, disk usage)
  - `--cache-gc` — Garbage-collect stale import cache entries
  - `--json` — Output cache status or GC result as JSON
  - `--max-bytes <n>` (hidden) — Override capacity cap for --cache-gc
  - `--stale-days <n>` (hidden) — Threshold for stale-eviction in days (default 30)

## codebase

- `teamai codebase` — Inspect and maintain team-codebase outputs
  - `--extract [path]` — Extract code knowledge and build graph from source
  - `--incremental` (hidden) — Only re-extract changed files (requires prior manifest)
  - `--project <name>` (hidden) — Project slug for --extract (defaults to directory name) and required for --deep-enrich
  - `--max-files <n>` (hidden) — Max source files to scan (default: 200)
  - `--upgrade-wiki` (hidden) — Migrate docs/team-codebase/ to teamwiki/ graph format
  - `--lint` — Run global consistency lint over the teamwiki knowledge graph
  - `--reconcile` — Reconcile product and code knowledge in teamwiki
  - `--deep-enrich` — Generate deep knowledge docs from extracted evidence
  - `--fix` (hidden) — Deprecated: teamwiki lint has no autofix; runs lint in report-only mode
  - `--status` — Show knowledge-base git baseline (headSha / repoUrl / branch)
  - `--severity <level>` (hidden) — Minimum severity to report: high|medium|low|info
  - `--json` — Output report as JSON (suitable for CI)
  - `--output <path>` (hidden) — Custom teamwiki output root directory

## review

- `teamai review [id]` — Inspect and process .teamai/pending-review.jsonl items
  - `--apply` — Apply the change for the given id (only for codebase-section)
  - `--reject` — Reject the given id without applying
  - `--reason <msg>` — Reason for reject
  - `--all-apply` — Apply all items at or below --max-risk
  - `--max-risk <level>` — Risk ceiling for --all-apply: high|medium|low (default medium)
  - `--json` — Machine-readable output

## ci

- `teamai ci` — CI pipeline integration commands
  - `teamai ci extract-mr` — Extract knowledge from MR/PR and post as comment or write to team repo
    - `--url <url>` — MR/PR web URL
    - `--mode <mode>` — Operation mode: comment | write | both
    - `--team-repo <path>` — Team knowledge repo path (required for write mode)
    - `--comment-marker <marker>` — HTML comment anchor for idempotent updates
    - `--write-mode <mode>` — Write strategy: direct | pending-review
    - `--output <dir>` — Write artifacts to directory
    - `--individual-comments` — Post each suggestion as separate comment with reaction/resolve support
