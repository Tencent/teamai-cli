# Scenario: Member — join an existing team

Goal: the user joins a team that already has a TeamAI repo. You need the team
repo's **full URL** (the admin shares it). Do NOT create a new repo.

Run the commands yourself. Only stop to ask when a step says "ASK".

## Step 0 — Get the repo URL (REQUIRED — stop if missing)

A member joins an **existing** repo. You need its full URL from the admin.

If the user has not given a full URL, ask for it:
*"Paste the full team repo URL your admin gave you (e.g.
https://github.com/yourorg/yourrepo)."* Do not proceed with `owner/repo` short
form.

**If the user does not have the URL, STOP here.** Do not guess a URL, do not probe
platforms, and — most importantly — **do not create a new repo.** Tell the user:
*"Ask your team's TeamAI admin for the repository URL, then come back and paste it
here."* A member without a repo URL cannot continue; creating one would fork the
team into a second, empty repo. (Setting up a brand-new team repo is the admin
flow — see `{SKILL_DIR}/references/setup-admin.md` — not this one.)

## Step 1 — Install and verify

```bash
npm install -g teamai-cli
teamai --version
```

If it fails, Node.js ≥ 20 is missing — have them install Node 20+ first.

## Step 2 — Choose scope (ASK)

- **This project only** (default): `cd` into the project directory first.
- **Whole machine**: add `--scope user`.

## Step 3 — Log in to the same platform as the URL

Match the login to the URL's host (do NOT create a second repo):

- **`git.woa.com/...`** (Tencent TGit) → **you run both the `gf` install and
  the `gf … auth login`** (never tell the user to run them). Follow
  `{SKILL_DIR}/references/provider-tgit.md` ("Log in"); the user's only action is
  approving the login URL in their browser / iOA. No `GITLAB_URL` needed. (No headless
  shortcut: `TGIT_TOKEN` is REST-API-only and cannot clone, so the login has to be run
  once on the machine.)
- **`cnb.cool/...`** → install the CNB CLI, then authorize, in this order:
  1. `npm install -g @cnbcool/cnb-cli`
  2. `cnb login` — have the user approve it in the browser (OAuth2 device flow);
     wait until they confirm before continuing.
- **`github.com/...`** → **you run the login yourself; never hand the user a
  command.** Log them in before `teamai init`:
  `gh auth login --web --git-protocol https`. Relay the one-time code and the
  `https://github.com/login/device` URL it prints, and ask the user to open that URL
  and approve — that approval is their *only* action. Confirm with `gh auth status`
  before continuing. (Headless/CI only: pre-set `GITHUB_TOKEN` — a token with `repo`
  scope — instead.)
- **`gitlab.com/...`** or self-hosted GitLab → set `GITLAB_TOKEN` (and `GITLAB_URL`
  for self-hosted, with `api` scope)

If they have no account on that platform, they register there, then ask the admin
to add them to the repo.

## Step 4 — Initialize with the URL (you run it)

```bash
# this project only (run from inside the project)
teamai init https://<platform>/<org>/<repo>

# or whole machine
teamai init https://<platform>/<org>/<repo> --scope user
```

**Set up all their AI tools by default (global rule 9).** Don't add `--agent` to
restrict the install unless the user said to. Omitting it gives a picker — select
**every AI tool already installed**. Afterwards, **tell the user (in their
language) which agents will now auto-sync TeamAI**, and note any detected tool that
was skipped and why.

**Read-only / restricted environments (no Git access):** some sandboxed hosts
cannot use Git. If the admin provides an HTTP endpoint + API key instead, use:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

This is a read-only consumer mode — `push` / `contribute` are not available, but
skills and rules still sync.

**Claude Code kept in a different directory (`CLAUDE_CONFIG_DIR`):** `init` records
that directory (as `toolRoots.claude` in the local config) and syncs every Claude
path there, so run `init` from a shell that has the variable exported. Re-running
`init` after changing it moves the install (the old root's hooks, managed MCP
servers and delivered model credentials are removed; its skills and rules are left
and named in the output). To end the relocation, run `init` once with the variable
set but blank: `CLAUDE_CONFIG_DIR= teamai init …`.

## Step 5 — Verify with doctor

```bash
teamai doctor
teamai hooks list      # per-tool: which AI tools actually got the hooks
```

Fix anything `doctor` reports. **Don't trust the "Hooks injected into all AI tool
settings" message alone** — it prints even for tools where nothing was written;
`teamai doctor` / `teamai hooks list` show the real per-tool status. If it flags
hook problems, load the troubleshooting reference (`"$(teamai skill path core)/references/troubleshooting.md"`),
section "Which tools actually get hooks".

## Step 6 — Confirm the skills actually arrived

Team resources sync on **session start**, so they may be empty right after init.
To confirm now:

```bash
teamai pull        # sync immediately
teamai list        # see the team skills / rules / docs you now have
```

Then tell the user: from now on, **opening a new session in this AI tool
auto-syncs** the latest team resources — no manual step needed. If their tool has
no session-start hook (e.g. Gemini CLI, JoyCode), they run `teamai pull` by hand.

**Reassure them about privacy** (in their language): *"TeamAI does not send any of
your session data to third parties. The only place anything is reported is the team
repo you just joined — usage counts and knowledge you choose to contribute, never
your raw conversation content."* (Team reporting is opt-in and carries counts +
tool names only, on a separate branch of that same repo.)

## Agent-specific note

If this conversation is running in **ChatGPT App** or **WorkBuddy**, the hooks
that drive auto-sync need an extra manual step — load the troubleshooting reference (`"$(teamai skill path core)/references/troubleshooting.md"`), section "Agent-specific caveats" and walk the user through it before finishing.

## If something is denied

Permission errors (can't clone, can't read) usually mean the admin has not added
this user to the repo yet. Have them copy the exact error message to their admin.

## Wrap up in the user's language, and how to leave

Summarize the outcome **in the user's own language** (global rule 1). Cover:

1. **They're done — sync is automatic.** From now on, opening a session in this AI
   tool keeps their team skills up to date; no commands needed.
2. **Sharing a session learning is automatic — no command to remember.** When a
   session produced something worth sharing, TeamAI **prompts them on its own** (at
   the end of the session) and the `share` workflow (`teamai skill get share`) takes over to
   summarize and contribute it. They do **not** invoke `/teamai` for this. (This
   prompt only appears when recall is on — it is off by default; the admin turns it
   on in `teamai.yaml` (`sharing.recall.enabled`), a member with `teamai recall enable` — and the admin has not switched the
   reminder off in `teamai.yaml`. It also stays silent while their teamai config
   cannot be loaded; `teamai skill get share` then names the file and the error.)
3. **They can also contribute a skill — just ask in plain language.** A member does
   not need to be an admin to publish a skill. They tell TeamAI something like
   *"share this xxx skill with my team"*, in their own language, and you
   run the publish for them (see `"$(teamai skill path core)/references/contribute-member.md"`;
   it needs no recall).
4. **How to leave — via the skill, not raw commands.** They can remove TeamAI any
   time by re-invoking the skill; you'll run it for them:
   `/teamai Uninstall TeamAI` (in their language; the `/teamai` prefix stays as-is).
   One line, in their language: *"This only removes things from your machine; the
   team repo stays — rejoin any time with `/teamai` and the repo URL."*
