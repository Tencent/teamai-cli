# Scenario: Admin — day-to-day management

The user already ran `teamai init`. Do NOT re-init or re-register. Before changing
anything, say what you are about to change. Pick the task below that matches.

Day-to-day management is mostly **publishing and updating team resources — skills,
rules, MCP servers, and env** — plus inviting members and checking the dashboard.

## Publish or update a skill / rule / doc

The user (or you) creates or edits a skill, rule, or doc locally, then publishes it
to the team. The same `teamai push` handles both new resources and updates to
existing ones:

```bash
teamai push            # review the diff, then confirm
teamai push --all      # push everything without per-item confirmation
teamai push --skill <path>   # push one specific skill
teamai push --branch <name> # use an explicit branch for a new push
```

An existing open PR is updated on its recorded branch. TeamAI refuses to reset a
team-repo clone with unrelated modified, staged, untracked, or conflicted files;
commit or stash those changes before retrying.

Members receive it automatically the next time they open a session (or when they
run `teamai pull`).

## Publish or update team MCP servers

```bash
teamai mcp list        # team MCP servers + per-tool install status
teamai mcp inject      # push team MCP servers into every AI tool's config
teamai mcp remove --dry-run # preview removal without changing tool configs or managed records
teamai mcp remove      # remove teamai-managed MCP servers
```

MCP definitions travel with the team repo like skills/rules — edit, then the
members pick them up on sync.

A server with a `${VAR}` the tool cannot expand itself gets the resolved value
written into its project config (`.mcp.json`, `.cursor/mcp.json`, ...). With
`sharing.gitExclude` on, Claude's (not in a single-repo team, whose worktrees
each read their own branch's servers) and CodeBuddy's servers go to their local
scopes in `~/.claude.json` and `.codebuddy.json` instead, outside the project,
and the next pull (on an HTTP-backed team, the local agent's next sync) moves
teamai's servers out of `.mcp.json`. Before
that write, teamai lists the file in the clone's `.git/info/exclude`, inside a
`# [teamai:mcp-exclude:start]` block; the committed `.gitignore` is never touched.
A file under a symlinked directory is listed and checked where the write lands
(`.cursor/` linking to `config/`: `/config/mcp.json`); a config that is itself a
symlink stays one, and its target is listed in, and checked by, its own repository.
When it cannot (git already tracks the file, a rule in the member's git ignore
files re-includes it, `.git/info` is not writable, the exclude file is held by
another teamai command, or git errors), it leaves the file as it was, warns, and
`teamai mcp list` shows `withheld: <tool> — <reason>. <fix>`. Apply the fix it
names (a tracked file: `git rm --cached <file>` and rotate the token; a
re-including rule such as `!/.mcp.json`: remove it), then run `teamai pull`. A pull or `teamai mcp remove` takes a line out
once its file no longer holds a resolved value; `teamai uninstall` does so in
every worktree. A file written under a `toolPaths.<tool>.mcpProject` the team
later changes or removes stays listed until it is deleted or holds no server;
for one an older teamai wrote, the first pull finds the path in the team repo's
history of `teamai.yaml`, or among the built-in paths teamai has since changed
(not one the same tool maps today), and lists it while it holds any server; one
git tracks is recorded instead and listed once the member runs `git rm --cached`
on it. `teamai doctor` checks those paths until that pull. A file written for a
tool the team moved elsewhere (recorded, or found in that history), that another
tool still maps, stays listed while it holds a server that tool did not write,
one of the member's own included. The built-in location of a tool the team drops
from `toolPaths` or moves elsewhere stays listed while it holds any server; one
another tool maps today (CodeBuddy's `.mcp.json`, which Claude maps) while it
holds a server that tool did not write. A file two tools map, with no pull on
this version having recorded it, needs a `managed-mcp.json` record from each of
them. While a worktree has no `managed-mcp.json` at all (lost, or before its
first pull), an untracked config holding a server no record claims is listed,
and that server noted: it keeps the line until it leaves the file. So is the
file of a tool `managed-mcp.json` has no record for, when a pull writes that
tool's first record (its record lost, or teamai's first delivery to it). While that
note cannot be written (another teamai command holds the record), the line stays
until a later pull writes it. A Copilot project config's bare top-level servers
still count once another tool writes `mcpServers` into the file. On an HTTP-backed
team the local agent's `install_mcp` lists a project config before writing a
server with any header, env value, argument or URL (only a bare stdio command is not), fails the install when it cannot, and only
`teamai uninstall` takes that line out. The next sync or `teamai pull` in the
workspace also lists a file an older local agent wrote a credential into; `teamai doctor` checks those files too.

### Pi MCP delivery

Pi 0.99.0+ receives stdio and streamable HTTP servers through the existing MCP commands and `teamai pull`; SSE is skipped. User scope writes `~/.pi/agent/mcp.json`, project scope writes `.pi/mcp.json` (Pi requires project trust). TeamAI keeps Pi's default codemode exposure and converts timeout milliseconds to seconds. Relocated Pi agent directories (`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`) are unsupported. Local exposure/enabled edits on managed servers survive until the team definition changes; doctor reports differences from the team entry. Extensions that replace `/mcp` must be removed to use Pi's built-in MCP.

## Invite a member

There is **no CLI invite flag.** Inviting is done on the Git platform's website:

1. On the platform (GitHub / GitLab / CNB), add the person to the team repo
   (Settings → Collaborators / Members).
2. Send them the **full repo URL** and this line to paste into their AI tool:
   `/teamai Help me join my team's TeamAI, repo URL is <URL>`

(If you want to see who is already registered: `teamai members` /
`teamai members list`.)

## See members and resources

```bash
teamai members list          # registered team members
teamai list                  # all resource types
teamai list skills           # just skills
teamai status                # local vs team differences
```

## Roles (skill namespaces per job function)

```bash
teamai roles list            # roles defined + your current role
teamai roles init            # create the roles manifest (admin, interactive)
teamai roles add <id>        # add a role
teamai roles update <id>     # change a role's namespaces / description
teamai roles remove <id>     # remove a role
```

After editing roles, `teamai push` to publish the manifest. Members re-sync on
their next session.

## Projects (manage several projects from one repo)

`project` is a second dispatch dimension alongside `role` — one team repo can serve
multiple projects, each with its own skills/rules/learnings, without a separate
repo per project:

```bash
teamai projects list         # projects defined + the ones active in this directory
teamai projects set [ids...]     # set the active project(s) for this directory
teamai projects members <id> # who is registered on a project
teamai projects add <id> --namespaces common,<id>   # add a project (creates projects.yaml if needed)
teamai projects update <id> --add-namespaces <ns>   # or --remove-namespaces / --name / --description
teamai projects remove <id>  # remove a project
```

A member gets the union of their role resources and their active project's
resources. Admins declare projects in `manifest/projects.yaml` with the commands
above, each of which opens a PR. `roles init/add/update/remove` and
`projects add/update/remove` support `--dry-run` without pulling the team repo.
Clone previews use the contents after a real pull on the checked-out branch: an
ahead branch stays ahead, a behind branch advances, and a diverged branch uses
origin/current-branch. `roles init` preview checks that manifest before asking
for overwrite confirmation. After `projects remove`,
keep the project's content in the team repo until members have pulled: that is
what lets their next pull clean up the copies they deployed.

`roles init/add/update/remove` and `projects add/update/remove` previews, and resource removal
previews, refuse a team clone with uncommitted changes. Commit or stash them before retrying. Single-repo
previews still work with dirty business files because they read origin. Clone
previews refresh the configured upstream first, even when its branch or remote
name differs. A failed fast-forward or missing upstream uses origin/current-branch
for the real reset fallback. Removal refuses when that refresh also fails.

Every namespace that names a directory — `knowledge`, `skills`, `agents`, `env`,
`hooks`, `mcp`, `models`, `docs` and `wiki` in either manifest, and `learnings` in `projects.yaml` (a role's `learnings:` is
ignored and unchecked) — must be a single path segment: no `/`, `\`, `:` or control character, no trailing
`.` or space, and not a Windows device name (`CON`, `NUL`, `COM1`, …). `team-codebase`
cannot be a `docs` namespace (`docs/team-codebase/` is the legacy codebase output). Two
namespaces of one resource type may not differ only by case, across both
manifests. A manifest that breaks this, does not parse, or is empty stops
members' pull for that scope until it is fixed; the error names the entry. Fix
it rather than deleting it — with no `roles.yaml`, delivery is unfiltered.

An item in an active namespace replaces the root item of the same name, whole:
a skill by directory name (including a root skill a member gets through a tag),
an agent by file stem, a rule by first-level file name (`rules/<ns>/<name>.md`
replaces `rules/<name>.md`), and a `claudemd/<ns>/<name>.md` file replaces
`claudemd/<name>.md`. Use this to give a project its own version of a shared
item under the same name, and keep that shared item at the root rather than in
a namespace every role activates: `rules/code-style.md` is replaced by
`rules/checkout/code-style.md` for checkout members, while a
`rules/common/code-style.md` would reach them alongside it. The same skill or
agent name in two namespaces one member has active is an error naming both
files; two namespace rules or claudemd files of one name are both delivered.
A replacement must be usable to replace anything: a skill directory needs its
`SKILL.md` (pull names one without it), and while an agent file does not parse
the root agent stays installed. `teamai doctor` lists each replacement as a note. Teams without roles or
projects are unaffected.

Docs have no override. A top-level `docs/<ns>/` that any role or project lists
under `resources.docs` reaches only members with that namespace active; a
`docs/<dir>/` nobody lists stays shared with everyone. When a member leaves the
namespace, their next pull removes its docs that still match the team copy and
keeps (and names) the ones they edited. Recall and `teamai doctor` follow the
same filter.

Wiki codebase slugs follow the same rule under `resources.wiki`: once any role
or project lists a `teamwiki/evidence/code/<slug>/` slug there, `recall` only
surfaces it for members with that namespace active; an undeclared slug stays
shared. The slug is whatever `teamai codebase --project <slug>` wrote, not
necessarily the project's manifest id.

## Keep delivered files out of git

With `sharing.gitExclude.enabled: true` in `teamai.yaml`, each member's pull lists
the skills and rules (one file per line, never a skill's directory, so a file a
member adds to a delivered skill stays visible), agents, `teamai-context` files, hook
files and team docs (one file per line) it delivered into a project, and each shared
config file (MCP, `.codex/hooks.json`, OpenCode's) while it holds only teamai's entries,
in teamai's `delivered` block in the clone's
`.git/info/exclude` (local to the clone, never committed), so `git add -A` does
not commit them; a member's own files, and copies they edited, stay visible. `init` writes it for a
new team; an existing team adds the line and commits it through the normal
review flow. A member overrides it on their machine with `gitExcludeEnabled:
true|false` in the project's `config.yaml` (`~/.teamai/projects/<slug>/config.yaml`).
Either takes effect on the next pull, no `--force`; turned off, the next pull
removes only that block. `teamai doctor` says where the setting comes from and
what git still sees; `teamai pull --dry-run` previews the block.

## Team dashboard (web UI)

```bash
teamai dashboard             # start the AI coding session dashboard (default port 3721)
teamai dashboard --port 8080 # custom port
```

Opens a local web UI for team coding-session activity and knowledge-base health.

## Team packages (npm + Claude plugins)

Declare packages once; members get a prompt to install them (TeamAI never runs
third-party package code automatically):

```bash
teamai packages install typescript          # npm dependency
teamai packages install eslint@latest --global   # global CLI tool
teamai packages install code-review@claude-plugins-official   # Claude plugin
teamai push                                 # share the updated teamai.yaml
```

## Shared environment variables, hooks and MCP servers

```bash
teamai env list              # what reaches this directory, each with its namespace (values masked)
teamai env list --reveal     # show variable values in plaintext (never a secret's)
teamai env add <KEY> <VALUE> # add or update in env/env.yaml
teamai env add <KEY> <VALUE> --project <id>   # or --role <ns>: in that namespace's env/<ns>/env.yaml (warns if nothing declares <ns>)
teamai env remove <KEY>      # remove (same --role / --project)
teamai env add <KEY> --secret -d "<what it is for>" --url <where to get one>   # declare a secret in env/secrets.yaml, no value (same --role / --project)
teamai env remove <KEY> --secret   # remove a declared secret (plain `env remove` does too when env.yaml does not set <KEY>)
teamai remove mcp <name>     # root mcp/mcp.yaml if it has the name, else the one namespace file; --role / --project pick a namespace
```

Env variables, team hooks and MCP servers are scoped like skills: the root file
(`env/env.yaml`, `hooks/hooks.yaml`, `mcp/mcp.yaml`) reaches everyone, and
`env/<ns>/env.yaml`, `hooks/<ns>/hooks.yaml`, `mcp/<ns>/mcp.yaml` reach only
members whose role or project lists `<ns>` under `resources.env`, `resources.hooks`
or `resources.mcp`. A namespace entry replaces the root entry of the same key, hook
id or server name. Hooks and MCP servers have no add command, and `teamai push`
does not pick up `hooks/` or `mcp/`: edit the file in the team repo, then commit
and push it with git. `teamai doctor` lists each override.

- A name twice in one file, in two active namespaces, or an active file that does
  not parse: that type is not applied for affected members and their installed
  state is kept. Fix the file the warning names. A hooks or MCP file with none of
  its top-level keys (`server:` for `servers:`) counts as one that does not parse.
- Per-entry `projects:` (and `roles:` on env) no longer works: such an entry reaches
  nobody. `roles:` on hooks and MCP still filters for one more minor release. Pull,
  the list commands (`teamai env list`, `teamai mcp list`, `teamai hooks list`,
  `teamai list <env|hooks|mcp> --source repo`), `teamai status` and
  `teamai doctor` name the namespace file each entry belongs in; move it there.
  When `teamai env add` updates a variable carrying either removed key, it keeps
  the key and warns that pull will not deliver the variable, naming that file.
- An env, hook or MCP entry with a key its schema does not know (a mistyped `role:`)
  also reaches nobody. Pull, the list commands, `teamai status` and
  `teamai doctor` name the file, entry and key; correct the key or remove it.
  A key a later teamai version adds is unknown to an older one, so upgrade every
  member before the team uses a new entry key.
- Team model profiles work the same way: `models/<ns>/models.yaml`, declared under
  `resources.models`, replaces the root profile with the same `id` for members who
  have `<ns>` active. A member's API key is bound to the profile's gateway origin:
  when an override points at another host, their pull leaves the agent alone and
  asks them to run `teamai models switch team:<id>` to set the key for it.
- Secrets are declared with no value in `env/secrets.yaml` or `env/<ns>/secrets.yaml`
  (active through `resources.env`; a namespace entry replaces the root entry with the
  same key): a `secrets:` list of `key`, optional `description` and optional `url`
  (where a member gets one). Never put a value there: `teamai env add <KEY> --secret`
  takes none and rejects one. Declare with it or edit the file in the team repo;
  `teamai push` picks it up. Each member sets their own value with `teamai env set KEY`
  in their terminal (`--global` for every team on their machine; a team value still
  wins). `teamai env list` shows each secret as `team`, `global`, `environment`,
  `missing` or `unreadable` and never shows a value, `--reveal` included. The `description` is what
  agents see: the session-start hook lists each declared key with it and tells the
  agent to run the CLIs that need them through `teamai env exec --`, so say which
  tool or server uses the key. As the agent, run `teamai env add <KEY> --secret`
  yourself and leave the value to each member's own terminal. A key declared as a secret
  and also set in `env.yaml` is a secret: its `env.yaml` value is not delivered. A
  secrets file that does not parse keeps `env.sh` and MCP servers as they were, and
  `teamai doctor` fails a check naming the file.
- Have every member upgrade before declaring `env`, `hooks`, `mcp`, `models`, `docs` or `wiki` in a
  manifest: teamai 0.25.0 and the 0.26.0 betas reject those keys and their pull stops.

## When sync fails

Run `teamai doctor` first. If it reports hook or path problems, load
the troubleshooting reference (`"$(teamai skill path core)/references/troubleshooting.md"`). Have the affected member reopen their session; if their tool
has no session-start hook, they run `teamai pull` manually.

## Capture a lesson learned

Turning a tricky fix into team knowledge is **automatic** once recall is on for
the team (`sharing.recall.enabled: true` in `teamai.yaml`, then `teamai push`; it is
off by default, and `teamai recall enable` turns it on for one machine only): at the end of a session
worth sharing, TeamAI prompts the member and the dedicated
`share` workflow (`teamai skill get share`) summarizes the session and runs
`teamai contribute`. Nobody has to invoke it by hand. (A member whose teamai config
cannot be loaded gets no prompt; `teamai skill get share` names the file and the error.)
(Publishing a **reusable skill** someone authored is a different task — any member
can do it, see `"$(teamai skill path core)/references/contribute-member.md"`.)

### Turn the sharing prompt on or off (admin)

The auto-share prompt is **on by default once recall is on**, and only shows in directories set up
with teamai (never on a read-only HTTP source, or while a member's teamai config cannot be loaded).
To disable it team-wide, set this in
`teamai.yaml` and `teamai push`:

```yaml
sharing:
  contributeHint:
    enabled: false      # team-wide default; members can still override locally
```

Resolution order: `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` env kill switch > a member's
local override > this team setting > default (on). Turning it off here only removes
the nudge; members can still contribute on request.

## Don't

- Don't hand-run raw `git` commands.
- Don't create a second team repo.
- Don't use `owner/repo` short form — always the full URL.
