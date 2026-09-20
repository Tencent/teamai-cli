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
```

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
teamai projects set <id>     # set the active project(s) for this directory
teamai projects members <id> # who is registered on a project
```

A member gets the union of their role resources and their active project's
resources. Admins declare projects in `manifest/projects.yaml`, then `teamai push`.

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
`troubleshooting.md`. Have the affected member reopen their session; if their tool
has no session-start hook, they run `teamai pull` manually.

## Capture a lesson learned

Turning a tricky fix into team knowledge is **automatic**: at the end of a session
worth sharing, TeamAI prompts the member and the dedicated
**`teamai-share-learnings`** skill summarizes the session and runs
`teamai contribute`. Nobody has to invoke it by hand.
(Publishing a **reusable skill** someone authored is a different task — any member
can do it, see `contribute-member.md`.)

### Turn the sharing prompt on or off (admin)

The auto-share prompt is **on by default**. To disable it team-wide, set this in
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
