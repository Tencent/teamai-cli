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
teamai mcp remove      # remove teamai-managed MCP servers
```

MCP definitions travel with the team repo like skills/rules — edit, then the
members pick them up on sync.

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
```

A member gets the union of their role resources and their active project's
resources. Admins declare projects in `manifest/projects.yaml`, then `teamai push`.

Every namespace that names a directory — `knowledge`, `skills` and `agents` in
either manifest, and `learnings` in `projects.yaml` (a role's `learnings:` is
ignored and unchecked) — must be a single path segment: no `/`, `\`, `:` or control character, no trailing
`.` or space, and not a Windows device name (`CON`, `NUL`, `COM1`, …). Two
namespaces of one resource type may not differ only by case, across both
manifests. A manifest that breaks this, does not parse, or is empty stops
members' pull for that scope until it is fixed; the error names the entry. Fix
it rather than deleting it — with no `roles.yaml`, delivery is unfiltered.

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

## Shared environment variables

```bash
teamai env list              # list (values masked)
teamai env list --reveal     # show values in plaintext
teamai env add <KEY> <VALUE> # add or update
teamai env remove <KEY>      # remove
```

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
