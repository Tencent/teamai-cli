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
flow — see `setup-admin.md` — not this one.)

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

- **`git.woa.com/...`** (Tencent TGit / 工蜂) → **you run both the `gf` install and
  the `gf … auth login`** (never tell the user to run them). Use the exact
  download/verify commands and login step from `setup-admin.md` (Step 3, Tencent
  TGit). The user's only action is approving the login URL in their browser / iOA.
  No `GITLAB_URL` needed. (Headless only: pre-set `TGIT_TOKEN`.)
- **`cnb.cool/...`** → install the CNB CLI, then authorize, in this order:
  1. `npm install -g @cnbcool/cnb-cli`
  2. `cnb login` — have the user approve it in the browser (OAuth2 device flow);
     wait until they confirm before continuing.
- **`github.com/...`** → `gh auth login`
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

## Step 5 — Verify with doctor

```bash
teamai doctor
teamai hooks list      # per-tool: which AI tools actually got the hooks
```

Fix anything `doctor` reports. **Do not trust the "Hooks injected into all AI tool
settings" message alone** — it prints even for tools where nothing was written.
Check the real per-tool status with `teamai doctor` / `teamai hooks list`. Only the
tool you set up (e.g. `claude`) is expected to show hooks installed; some tools are
skipped by design or not yet supported (CLI behaviour, not a broken setup). If it
flags hook problems, load `troubleshooting.md` ("Which tools actually get hooks").

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
that drive auto-sync need an extra manual step — load `troubleshooting.md`
("Agent-specific caveats") and walk the user through it before finishing.

## If something is denied

Permission errors (can't clone, can't read) usually mean the admin has not added
this user to the repo yet. Have them copy the exact error message to their admin.

## Wrap up in the user's language, and how to leave

Summarize the outcome **in the user's own language** (global rule 1). Cover:

1. **They're done — sync is automatic.** From now on, opening a session in this AI
   tool keeps their team skills up to date; no commands needed.
2. **Sharing a session learning is automatic — no command to remember.** When a
   session produced something worth sharing, TeamAI **prompts them on its own** (at
   the end of the session) and the `teamai-share-learnings` skill takes over to
   summarize and contribute it. They do **not** invoke `/teamai` for this. (This
   prompt only appears if the admin left team sharing enabled — it is on by
   default; the admin can turn it off in `teamai.yaml`.)
3. **They can also contribute a skill — just ask in plain language.** A member does
   not need to be an admin to publish a skill. They tell TeamAI something like
   *"share this xxx skill with my team"* / *"把这个 xxx skill 分享给团队"*, and you
   run the publish for them (see `contribute-member.md`).
4. **How to leave — via the skill, not raw commands.** They can remove TeamAI any
   time by re-invoking the skill; you'll run it for them:
   `/teamai 卸载` / `/teamai Uninstall TeamAI`.
   One line, in their language: *"This only removes things from your machine; the
   team repo stays — rejoin any time with `/teamai` and the repo URL."*
