# Scenario: Admin — set up a new team repo from scratch

Goal: the user becomes the first admin of a brand-new TeamAI team. At the end they
have a working team repo URL to share with members.

Run the commands yourself. Only stop to ask when a step says "ASK".

## Step 1 — Install and verify

```bash
npm install -g teamai-cli
teamai --version
```

If `teamai --version` fails, Node.js ≥ 20 is missing. Tell the user to install
Node 20+ (from https://nodejs.org), then retry. Do not continue until the version
prints.

## Step 2 — Pick a Git platform (only when the user gave NO repo URL)

If the user already gave a full repo URL, skip to Step 4. Otherwise, TeamAI needs a
place to store the team's skills/rules. The user does not need to know Git. Work
through these sub-steps **in order**:

### 2a — Ask which platform they know

**Tencent-internal first:** before asking, probe whether TGit (工蜂) is reachable
on this machine — see `provider-tgit.md` ("Probe reachability") for the one-line
`x-env: tgit` check. If it says `tgit: OK`, **list Tencent TGit (工蜂) first** and
prefer it. Then ask: *"Have you heard of / do you have an account on any of these —
Tencent TGit (工蜂), GitHub, GitLab, or CNB (cnb.cool)?"*

- **Tencent TGit (工蜂)** — https://git.woa.com (Tencent-internal only; shown
  first when the probe above says `tgit: OK`)
- **GitHub** — https://github.com
- **GitLab** — https://gitlab.com (or a self-hosted company GitLab)
- **CNB** — https://cnb.cool

If they name one, use that platform and go to sub-step 2c.

### 2b — If they've heard of NONE, auto-probe reachability

Test which sites this network can actually reach (probe each, ~3s timeout each).
The TGit probe checks the `x-env: tgit` header, not just reachability (see
`provider-tgit.md`); the others just check reachability:

```bash
curl -sS -m 3 -D - -o /dev/null https://git.woa.com 2>/dev/null | grep -qi '^x-env:[[:space:]]*tgit' && echo "tgit: OK" || echo "tgit: unreachable"
curl -sSf -m 3 -o /dev/null https://github.com  && echo "github: OK"  || echo "github: unreachable"
curl -sSf -m 3 -o /dev/null https://gitlab.com  && echo "gitlab: OK"  || echo "gitlab: unreachable"
curl -sSf -m 3 -o /dev/null https://cnb.cool     && echo "cnb: OK"     || echo "cnb: unreachable"
```

- **TGit reachable (`tgit: OK`)** → prefer Tencent TGit (工蜂); it is the
  Tencent-internal default.
- **Exactly one reachable** → use that one.
- **Several reachable** → list them (TGit first when present) and let the user pick.
- **None reachable** → stop. Tell the user to ask their own admin for a ready-made
  repo URL, then switch to `join-member.md`.

Choose by **account + reachability only — never by region**.

### 2c — Give the sign-up / create link and let them create the project

Once the platform is decided, hand the user the direct link to sign in and create
the repository, then continue to the next step:

| Platform | Sign in / sign up            | Create a new repo (do this)        |
|----------|------------------------------|------------------------------------|
| Tencent TGit (工蜂) | https://git.woa.com | https://git.woa.com/projects/new |
| GitHub   | https://github.com/login     | https://github.com/new             |
| GitLab   | https://gitlab.com/users/sign_in | https://gitlab.com/projects/new |
| CNB      | https://cnb.cool             | https://cnb.cool/new/repos (org first: https://cnb.cool/new/groups) |

> **Tencent TGit (工蜂):** don't send the user to the browser to create the repo —
> prefer letting `teamai init` create it via the API in Step 5. See
> `provider-tgit.md` ("When you `teamai init` on TGit").

Tell the user to sign in, create an **empty** repo (suggested name
`TeamAi-<team-name>`), and give you the resulting repo URL. Explain in one
sentence: *"The repo on the website is where the team's skills and rules live; your
computer only holds a synced copy — you never put business code in it."*

> You may instead let `teamai init` create the repo from the CLI in Step 5 (it
> offers to create a missing repo on GitHub/GitLab). Creating it in the browser
> first is the simplest path for a user who does not know Git, and is required on
> CNB (see the CNB caveat in Step 5).

## Step 3 — Log in from the CLI

Signing in on the website (Step 2c) is not enough — `teamai init` also needs the
platform's CLI credentials. Have the user complete the matching CLI login:

### Tencent TGit (工蜂)

See `provider-tgit.md` ("Log in") — you install `gf` and run `gf auth login`
yourself; the user only approves in the browser / iOA. No `GITLAB_URL` needed.
Then return here for Step 4.

### CNB — install the CLI, authorize, then read the repo (in this order)

Once the user has created their repo on cnb.cool and given you the URL, do these
three steps **in order**:

1. **Install the CNB CLI** (needed to talk to cnb.cool):
   ```bash
   npm install -g @cnbcool/cnb-cli
   ```
   (`teamai init` also installs it automatically if it is missing, but running it
   here first makes the next step predictable.)
2. **Ask the user to authorize.** Start the login and have them approve it in the
   browser (OAuth2 device flow):
   ```bash
   cnb login
   ```
   Wait for them to confirm they finished authorizing before continuing.
3. **Then read their repo** — proceed to Step 4/5 (`teamai init <their CNB URL>`),
   which can now clone and read the repo with the authorized CLI.

(Headless/CI alternative: set `CNB_TOKEN` instead of `cnb login`.)

### GitHub — YOU run the login; user only clicks approve

**Don't hand the user a `gh` command to run** — you run the login, they only approve
it in the browser. Log them in before `teamai init`:

```bash
gh auth login --web --git-protocol https
```

The flow prints a one-time code and a `https://github.com/login/device` URL.
**Relay both to the user and ask them to open that URL and approve** — that approval
is the *only* thing they do; the command finishes on its own once they do. Confirm
with `gh auth status` before continuing.

(Headless/CI only: skip the interactive login and pre-set `GITHUB_TOKEN` — a token
with `repo` scope — instead.)

### GitLab (gitlab.com)

Set a Personal Access Token with `api` scope:
```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx
```
Self-hosted GitLab: also set the instance URL first —
`export GITLAB_URL=https://git.example.com`.

For GitHub/GitLab, `teamai init` installs any helper CLI it needs automatically.

## Step 4 — Decide the scope (ASK)

One choice — project-only or whole machine?

- Default (project): resources land in the current project's `.claude/` etc.
  `cd` into the project first.
- Whole machine: add `--scope user` so every project gets the team resources.

(The repo name was already chosen when the user created the repo in Step 2c —
suggested form `TeamAi-<team-name>`.)

## Step 5 — Initialize (you run it)

Use the **full URL**, never `owner/repo`:

```bash
# project scope (default) — run from inside the project directory
teamai init https://<platform>/<org>/<repo-name>

# or whole machine
teamai init https://<platform>/<org>/<repo-name> --scope user
```

If the repo does not exist yet, `init` offers to create it — accept the prompt.

- **Tencent TGit (工蜂):** `gf` and login are already done, so init creates the
  repo via the API when it's missing — see `provider-tgit.md` ("When you
  `teamai init` on TGit").
- **CNB caveat:** a `cnb login` token **cannot create** an org or repo — that is
  exactly why the CNB flow has the user create the repo on the website first
  (Step 2c). If the org/repo is still missing here, `init` prints web links
  (`https://cnb.cool/new/groups`, `https://cnb.cool/new/repos`) — have the user
  create them in the browser, then re-run `teamai init`. By this step the CNB CLI
  should already be installed and authorized (Step 3). (A `CNB_TOKEN` with
  `group-manage:rw` + `group-resource:rw` lets the CLI create them directly.)
- **GitHub caveat:** if a push later fails, check the repo's default branch is
  `main` (not `master`).
- If `init` detects an unknown GitLab host, it stops and asks you to set
  `GITLAB_URL` + `GITLAB_TOKEN`, then retry.

If the repo has roles enabled, `init` may ask for a primary role — pick one with
the user, or pass `--role <id>` for a non-interactive run. Without a terminal
(or with `CI` / `TEAMAI_NONINTERACTIVE` set) `init` never waits: a provider that
would need a browser login fails at once and names the credential to prepare —
a token for GitHub / CNB / GitLab / GitCode, and for TGit a prior `gf auth
login` run in an interactive shell (see Step 3).

**Which AI tools to set up — all of them by default (global rule 9).** Do not add
`--agent` to restrict the install unless the user explicitly said to (e.g. "only
Claude Code"). Omitting `--agent` gives an interactive picker — select **every AI
tool already installed** on the machine. Then **report back which agents were set
up**, in the user's language: name the tools that will now auto-start TeamAI, and
any detected tool that was skipped and why (e.g. Codex trust-gate,
CodeBuddy/WorkBuddy by design — see `troubleshooting.md`).

## Step 6 — Verify with doctor

```bash
teamai doctor
teamai hooks list      # per-tool: which AI tools actually got the hooks
```

Resolve everything `doctor` flags before continuing.

**Don't trust the "Hooks injected into all AI tool settings" message on its own** —
it prints even for tools where nothing was written. `teamai doctor` / `teamai hooks
list` show the real per-tool status. Only the tool you set up (e.g. `claude`) is
expected to show hooks installed; others are skipped by design or not yet supported,
which is normal. Full table in `troubleshooting.md` ("Which tools actually get
hooks").

## Step 7 — Grant members repo access (required before they can join)

TeamAI has **no permission model of its own** — it rides the Git platform's
access control. After you initialize the repo, **each member must be granted
read/write access to it on the platform website**, or their `teamai init` / `pull`
/ `push` will fail with a permission error.

Tell the admin (in their language) to add every member on the repo's website:

- **Tencent TGit (工蜂):** repo → 成员管理 / Members → add each member with at
  least **Developer** (read/write) access.
- **GitHub:** repo → Settings → Collaborators → add with **Write**.
- **GitLab:** repo → Settings → Members → add with **Developer** or above.
- **CNB:** repo → members → grant read/write.

Do this **before** handing off the invite line below — otherwise the member hits a
"permission denied / can't clone" error on their very first step.

## Step 8 — Hand off to members

Everything you show here goes **in the user's language** (global rule 1). Only the
`/teamai …` line, URLs, and commands stay verbatim.

**First, reassure them about privacy** (say this in their language): *"TeamAI does
not send any of your session data to third parties. The only place anything is
reported is the team repo you just set up — usage counts and knowledge go there,
and raw conversation content is never uploaded."* (Team reporting is opt-in and
carries counts + tool names only, on a separate branch of that same repo.)

1. Give the user their **repo web URL** to share.
2. Give them a ready-to-forward invite line **written in their language**, with the
   URL filled in. The `/teamai` prefix stays as-is; translate the rest. For a
   Chinese-speaking user, that is:
   `/teamai 帮我加入团队的 TeamAI，仓库地址是 <URL>`
   (English user: `/teamai Help me join my team's TeamAI, repo URL is <URL>`.)
   Tell them to send the URL + this line to each member.
3. Remind them (in their language): **new resources appear only after opening a
   fresh session** in the AI tool. Right after init the skills folder may look
   empty — that is expected. To sync now, run `teamai pull`.

## Step 9 — What's next (guide them, don't just list commands)

Wrap up **in the user's own language** (global rule 1).

The user may not be comfortable with the command line, so **don't just hand them a
list of `teamai …` commands.** Instead, point them back to *this skill* for
day-to-day work — they can keep letting the AI run things for them:

- To manage the team later, they run:
  `/teamai 我已经装好了，帮我管理` (Chinese) /
  `/teamai I already have TeamAI set up, help me manage it` (English) — this loads
  the daily-management flow (`manage-admin.md`): publishing skills, inviting
  members, roles / packages / env.
- To share a reusable skill with the team, they run:
  `/teamai 把这个 xxx skill 分享给团队` (Chinese) /
  `/teamai Share this <skill-name> skill with my team` (English) — see
  `contribute-member.md`.
- Sharing a **session's learnings** is **automatic** — do **not** send them to
  `/teamai` for it. TeamAI prompts on its own at the end of a session worth
  sharing, and the separate **`teamai-share-learnings`** skill takes over. (Only
  when the admin left team sharing on — the default.)

Mention the underlying commands (`teamai push`, `teamai roles`, …) only as a note
for users who *do* want them — the primary path is re-invoking `/teamai`.

## Step 10 — Tell them how to leave (via the skill, not raw commands)

Finish by telling the user, **in their language**, that they can remove TeamAI any
time — and that they don't need the command line to do it. They just re-invoke the
skill and you'll handle it:

`/teamai 卸载` (Chinese) / `/teamai Uninstall TeamAI` (English)

One line, in their language: *"That removes the hooks and synced resources from
your machine; your team repo on the website is untouched — you can rejoin any time
with `/teamai` and the repo URL."*

(If they ask right now, load `uninstall.md` and run it for them.)
