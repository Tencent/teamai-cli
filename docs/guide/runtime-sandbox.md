# Sandbox runtime

The `sandbox` [step runtime](workflow-advanced.md#driver-definitions-and-step-runtimes) runs each attempt of a workflow step in a sandbox of its own: a Docker Sandboxes microVM, a container from an image your team builds, a sandboxed process on this machine, or a Vercel Sandbox. The agent works on the step's worktree and cannot touch the rest of your machine. The sandbox starts the tool there and keeps the step's limits; teamai reads the result, and commits and pushes on the host.

This version runs `sbx` ([Docker Sandboxes](#sbx-docker-sandboxes)), `docker`, `podman`, `seatbelt`, `bwrap` and `vercel`. It ships with teamai as the executable `teamai-runtime-sandbox`.

## Quick start

**1. Build an image that holds the tools.** The checkout is never copied into the image: it is mounted when the step runs.

```dockerfile
# Containerfile in your infra repo
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2
```

```sh
docker build -t ghcr.io/acme/agent:1 -f Containerfile .
docker push ghcr.io/acme/agent:1
```

**2. Add a sandbox profile and a driver definition** to the team repo, then push them. The profile says what the sandbox is built from; the definition runs it and names the credentials.

```yaml
# sandboxes/containers.yaml
provider: docker                  # or podman
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
description: Run each step in a container from the team image, on the member's Claude subscription.
tool: claude
runtimes:
  - use: sandbox
    sandbox: containers
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

**3. Each member creates a token once.** A Claude login kept in the macOS Keychain does not reach a container, and a token does.

```sh
claude setup-token                       # prints a long-lived token for your subscription
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…   # in your shell profile or secret manager
```

Without it, the start stops before any step runs:

```text
{"error":{"code":"credential_missing","message":"Runtime \"sandbox\" of driver definition drivers/containers.yaml in the team repo declares credential CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN is not set in your environment. Set CLAUDE_CODE_OAUTH_TOKEN, then start again."}}
```

**4. Run a workflow on it.**

```sh
teamai pull
teamai workflow start review --driver containers
```

```text
ℹ Run r7c41d09e2b6a5f13 started. If it stops before it ends, continue it here with: teamai workflow resume r7c41d09e2b6a5f13, or hand it to another machine with: teamai workflow publish r7c41d09e2b6a5f13
{"data":{"done":{"run":"r7c41d09e2b6a5f13","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

While a step runs, its container is there to look at:

```sh
docker ps --filter label=teamai.run=r7c41d09e2b6a5f13 --format '{{.Names}}  {{.Image}}  {{.Status}}'
```

```text
teamai-r7c41d09e2b6a5f13-a3e9b0c51  ghcr.io/acme/agent:1  Up 41 seconds
```

When the attempt ends, teamai removes its container. A `teamai workflow cancel` stops the step and removes it too.

## Sandbox profiles

A sandbox profile says what a sandbox is built from: its provider and that provider's options. The team keeps one as `sandboxes/<name>.yaml`, or as a folder `sandboxes/<name>/` holding a `SANDBOX.yaml` and the files it builds from, such as a `Containerfile`. An entry with `use: sandbox` (or `through: sandbox`) names it with `sandbox: <name>`, and with none it runs the profile `default`. teamai looks for the name in your `~/.teamai/sandboxes/`, then in the team repo, then among its own, where `<name>` is also found as `teamai-<name>`: `default` is teamai's `teamai-default`, an sbx microVM, and `sbx`, `docker`, `podman`, `seatbelt`, `bwrap` and `vercel` are one each to name or copy (`teamai-docker` and `teamai-podman` name no image, so copy them and set one). A folder of the name in your `~/.teamai/sandboxes/` or the team repo with no `SANDBOX.yaml` (missing or misspelt) fails the run naming the folder, rather than passing to the next place. A profile of yours or the team's that takes the name of one of teamai's is said once when a run starts. Each attempt's record names the profile it ran, where it came from, its revision, its provider, and what the sandbox runtime says it enforces there: its isolation, and whether it keeps the network, token and turn limits.

The entry keeps what teamai reads itself, `credentials` and `max_parallel`, in its `options`; any other key there fails before any step runs and names the profile file to move it to. A profile that cannot be read, names an unknown provider, or, as a folder, holds a link, fails the same way and names its file.

| Key | Example | Meaning |
| --- | --- | --- |
| `provider` | `docker` | `sbx`, `docker`, `podman`, `seatbelt`, `bwrap` or `vercel` |
| `agent` | `claude` | `sbx` only: the agent template each sandbox starts from, `claude` or `codex`, or a kit reference that brings the tools. Leave it out to start each attempt from its own tool's template: a Claude step from `claude`, a Codex step from `codex`, a command step from the bare `shell`. `agent: shell` is refused, since that template holds no agent. |
| `image` | `ghcr.io/acme/agent:1` | `docker` and `podman` only: the prebuilt image. It needs `/bin/sh` and the tools your steps run: `claude`, `codex` or `codebuddy`. Add `git` for steps that read history. A step runs with `TZ` set to your time zone, which the image applies only with its zoneinfo (`tzdata`), so that a tool's "try again at <time>" is read in your zone: the quick start's image, on Debian's `node:22-bookworm-slim`, has it, and an Alpine image needs `apk add tzdata`. |
| `warm` | `prepare: npm ci --ignore-scripts` | An image with your package manager's store filled, made once and used by every attempt. See [A warm image](#a-warm-image). |
| `credentials` (on the entry) | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | Read by teamai from your environment when the run starts, and given only to the step's tool, never to a command step. See [Credentials from your environment](workflow-advanced.md#credentials-from-your-environment). |

A key the provider does not take fails before any step runs:

```text
{"error":{"code":"bad_option","message":"Sandbox profile sandboxes/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image, warm. Fix it, push it, run teamai pull, and start again."}}
```

## A warm image

With `warm`, each attempt starts from an image whose package manager's store is already filled, so the workflow's setup installs from it instead of downloading every package in every step:

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
warm:
  prepare: npm ci --ignore-scripts
  cache: [package.json, package-lock.json]
```

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
description: Run each step in a container from the team image, with the package store filled once.
tool: claude
runtimes:
  - use: sandbox
    sandbox: containers
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

The first step that opens makes it: teamai copies the `cache` files to a scratch directory outside the checkout, runs `prepare` there in a container of `image` with no credential, and saves the result as `teamai-warm:<key>`. The key comes from the image as it is on this machine (its id, so pulling a new push of its tag counts), the recipe and the bytes of the `cache` files, so a change to the lockfile makes a new image and an unchanged one reuses it, in this run and later runs. A `cache` file that is a link to a file outside the checkout is refused. Steps that open at the same time wait for one build. The image keeps only what `prepare` leaves outside that directory, such as the store in its home (`~/.npm`) or tools it installs: the directory, with any `node_modules` made there, is not in it, and neither is any file of the checkout. Install in the workflow's setup as usual (`npm ci --prefer-offline`), which takes the packages from the store. List them with `docker image ls teamai-warm`. The last `teamai uninstall` on this machine removes each one teamai's sandbox recorded making here, and names any it cannot remove with the command that does. One an earlier teamai made, before it kept that record, stays: remove it with `docker image rm`. The step's run details show the image its container ran, `teamai-warm:<key>`, beside the base, and the sandbox profile with its revision.

On `docker` and `podman`, `containerfile: ci/deps.Containerfile` builds that file instead of running `prepare`, with only the `cache` files in its context; the image holds what the file copies of them. On `sbx`, `warm` takes `prepare` only and saves a template (`sbx template ls`), keyed by the template and sbx's version. sbx 0.53 also keeps the same image as a `sandbox-kit-assembled:<hash>` template of its own, which any sandbox of that kit starts from: uninstall removes only `teamai-warm:<key>`, and names that template, so you can free its disk with `sbx template rm --force` if no sandbox of yours needs it. On `vercel`, `warm` takes `prepare` and an optional `expiration` (`30d`, `12h`; at least `1h`, 30 days when unset): `prepare` runs in a scratch sandbox of `runtime`, and the result is saved as a Vercel snapshot that each attempt's sandbox starts from. Vercel keeps it for `expiration` after its last use, and the next open makes it again once it is gone. A `prepare` that fails stops the step with `sandbox_failed` and its last lines; no step runs until you fix it.

In a profile kept as a folder, `containerfile: ./Containerfile` names a file of the folder itself, never a link or a path out of it. The build, or `prepare`, sees the folder's files at the top of its directory beside the `cache` files, so `prepare: ./prepare.sh` runs a script the folder holds, and a folder that holds a link is refused. The key also holds the folder's revision, so a change pushed to the folder makes a new image:

```text
sandboxes/node-deps/
  SANDBOX.yaml       provider: docker, image: ghcr.io/acme/agent:1, warm: { containerfile: ./Containerfile, cache: [package-lock.json] }
  Containerfile      FROM ghcr.io/acme/agent:1, then COPY package-lock.json and RUN npm ci
```

## What the step sees

```text
in the container                                        from the host
/home/me/acme/app/.teamai/workflow-worktrees/…          the step's worktree, read-write
/home/me/acme/app/.git                                  git directories, read-only
~/.teamai/projects/…/attempts/a3e9b0c51/out             where the tool writes its result, read-write
~/.teamai/projects/…/attempts/a3e9b0c51/tool-home/claude   CLAUDE_CONFIG_DIR: the session, read-write
~/.teamai/projects/…/runs/r7c41d09e2b6a5f13/scratch        TEAMAI_RUN_DIR: the run's shared files, read-write
~/.teamai/projects/…/folders/4be1c07d…                     TEAMAI_WORKFLOW_DIR: the files of a workflow folder, read-only
/tmp/teamai-home                                        HOME, private to the container
```

- Every path keeps its host path, so nothing is copied back and `git status` works. That holds for every `workspace`: `new`, `continue`, `read-only`, and the `clone` or team-repo copy teamai prepares, whose own `.git` is the read-only git directory.
- `git commit` in the container fails, because the git directories are read-only. teamai commits on the host with hooks turned off, so a hook the step plants never runs.
- The step runs as you: `--user <your uid>:<gid>` on Docker, `--userns keep-id` on Podman. Files it writes are yours. On a host with SELinux, mounts get the shared label (`:z`).
- The tool keeps its session in the attempt's tool home, so the pass's `teamai-score` run judges it from its transcript, and a later step with `session: { from: … }` resumes it.
- The sandbox starts a prompt step's tool itself, in the container, and stops it there at the step's `budget`, `timeout` or idle limit. A step its budget stopped with `on_limit: end_turn` keeps its session.
- Command steps run in the container too, also in a definition that lists `tools` after the sandbox. Only teamai's own bookkeeping, such as a `teamai-score` run's evidence and label steps, runs on this machine.

**A tool runs only where it can sign in.** A Claude login in the macOS Keychain or in `~/.claude`, or your daily `~/.codex`, never crosses into a container. So the sandbox offers a tool only when `credentials` names one of its sign-in keys (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude; `OPENAI_API_KEY`, `CODEX_API_KEY` or `codex: login` for Codex), or, on sbx, when sbx keeps a login for it. A step on a tool it cannot sign in fails before it starts, with how to sign that tool in, instead of at Claude's own "Not logged in":

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude cannot sign in inside this docker sandbox, so a step there would stop at its "Not logged in": a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox's credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY). Then start again. Or remove tool from the step.
```

Command steps still run in the sandbox: they need no sign-in. A `tools` listed after the sandbox does not take such a prompt step either: it fails as above, so a step never runs on this machine's tool because its tool could not sign in in the sandbox. `tools` still takes the judge and interactive steps.

On sbx, a tool sbx keeps a login for signs in on that login, even when your shell sets one of its variables, such as `ANTHROPIC_BASE_URL` for a gateway. A variable the definition names in `credentials` still goes to the step's tool.

When your shell sets `ANTHROPIC_BASE_URL`, the first Claude step each teamai command runs in the sandbox says so, once:

```text
⚠ Step runtime "sandbox", operation op-3c1e9a7f2b40: claude signs in here on the login sbx keeps (anthropic in `sbx secret ls`), so the gateway ANTHROPIC_BASE_URL names in your shell is not used in this sandbox. To use it there, add ANTHROPIC_BASE_URL: env:ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN: env:ANTHROPIC_AUTH_TOKEN to the sandbox's credentials.
```

**Your team's tool instances run here too.** An instance such as `tools/acme-claude.yaml` (`extends: claude`, `command: acme-claude`) is offered when its tool signs in in the sandbox and the sandbox holds its command, even without the `claude` executable itself: the image, or on sbx a kit (`agent: ./kits/acme`). teamai then runs `acme-claude` in the sandbox, with the instance's home variable at the attempt's tool home. An instance with no `command` of its own, or whose command is its tool's, runs wherever its tool does. sbx's own templates hold only their agent, so on `teamai-sandbox` such a step stops before it starts, rather than running `acme-claude` on this machine through `tools`:

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: sandbox: acme-claude runs acme-claude, which is not in sbx's claude template: set agent to a kit that brings it, or run the step with --driver local. Or remove tool from the step.
```

Only the names a step is given cross into the container: its `requires.env` keys, the workflow's `env`, teamai's attempt marker, the tool home variable, and, for the step's tool only, the `credentials`. Nothing else of your environment reaches it, so `GH_TOKEN`, `SSH_AUTH_SOCK` and the like stay out. Values never appear in a command line: the container is created with no credential, and each `docker exec -e NAME` reads the value from the engine CLI's own environment. Nor are they written to disk: the runtime keeps what it remembers of each exec with any credential the tool printed masked.

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

**The workflow's `setup` runs in the step's container too**, before the step, with setup's own `requires.env` keys and none of the step's: the step's keys are unset, and `credentials` go only to the tool.

```yaml
# workflows/review.yaml
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
```

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e NPM_TOKEN -e TEAMAI_WORKFLOW_ATTEMPT -e TEAMAI_MODE -e TEAMAI_RUN_DIR teamai-r7c41d09e2b6a5f13-a3e9b0c51 env -u SIGNING_KEY -- /bin/sh -c 'npm ci'
```

teamai then checks on the host what setup left in the worktree, as it does on `local`. A failing setup, a tracked file it changed, or a key's value it wrote to a file stops the step before the tool starts:

```text
✖ Step "review" failed with setup_failed: Setup "npm ci" exited with code 1, so the step did not run. It printed: npm error 401 Unauthorized - GET https://npm.acme.internal/@acme%2fui Fix setup, then retry the step.
✖ Step "review" failed with setup_secret: Setup "npm ci" left the value of NPM_TOKEN in .npmrc, where the step could read it, so the step did not run. Make setup remove the files it writes NPM_TOKEN to, then retry the step.
```

## What a step reaches of this machine

A step's tool talks to its model provider, often through a gateway on this machine. Whatever else listens on this machine, such as a database, an app's local server or another agent's daemon, is a way out of the sandbox for a step that reaches it. This is what a step reaches of this machine on each provider:

| Provider | What a step reaches of this machine | Isolation |
| --- | --- | --- |
| `docker` on Docker Desktop, or on Docker Engine on this Linux machine, with `node` in the image, 26.0.0 or later (25.0.5, 23.0.11) | Only the ports of this machine its credentials name, such as a gateway's. The container is on a network of its own whose one way out is a filter, set as its `HTTPS_PROXY` and `HTTP_PROXY`: it lets through any host off this machine and those ports, and refuses every other address of this machine and of the Docker host. | `sandbox`, unattended included |
| `docker` otherwise, such as in a VM of its own (Colima, Rancher Desktop, Lima), and `podman` | Every port of this machine, through the address it has in the container | `worktree` |
| `sbx` | What your sbx network policy allows: a port of this machine once `sbx policy allow network localhost:<port>` allows it | `sandbox`, unattended included |
| `seatbelt` | Only the ports its credentials name, on any address of this Mac, so not even a server the step starts itself; a Unix socket only inside its place, and the DNS resolver's | `worktree` |
| `bwrap` | Every port of this machine, and its abstract Unix sockets: the step shares this machine's network | `worktree` |
| `vercel` | Nothing: a credential on `localhost` fails `bad_option` | `sandbox`, unattended included |

At `worktree`, a step with `requires: { isolation: sandbox }` or `permissions: unattended` is not offered to the runtime, and an app's tool does not run there through [`teamai-sandbox-<tool>`](#through-an-app-teamai-sandbox-tool). On a filtered `docker` step, a client that ignores `HTTPS_PROXY` and `HTTP_PROXY` reaches nothing off this machine, and neither does a step whose environment names a proxy of yours: teamai does not pass the filter's traffic on to another proxy.

## Judging in the sandbox

A scored pass is judged by its `teamai-score` run, whose judge step reads only the evidence teamai gathered. The sandbox runs that judge too, so a definition with only `sandbox` judges with no AI tool installed on your machine. Each judge gets a fresh container:

```text
judge container teamai-<run>-<attempt>                  from the host
/evidence                                               the evidence, read-only: nothing else
network <name>-net, internal                            no route out but the filter
filter <name>-proxy                                     lets through only the model provider: api.anthropic.com:443
```

- Claude runs with only `Read`, `Grep` and `Glob`, so it can read the evidence and nothing else (`access: read`). Codex runs with the container as its sandbox, so it can run commands inside it (`access: full`), but still reaches only `dir` and the provider.
- The evidence is mounted at `/evidence`, and the judge's prompt and working directory name it there, so the judge's mounts and prompt carry no path of your home, user name or project. The evidence files themselves, such as a transcript, still hold what the session wrote.
- The judge gets only the env credentials its own tool reads, never your environment, your SSH agent or the run's directory. It counts in the sandbox's `max_parallel`.
- The run records the level the runtime kept, `verified`, and what the tool could do there.

```yaml
# workflows/review.yaml
schemaVersion: v1alpha1
name: review
description: Review a change in the sandbox, and judge each review there.
steps:
  - id: review
    workspace: new
    prompt: Review the change and write review.md.
    scorers: { names: [review-quality], sampling: all }
```

```sh
teamai workflow start review --driver containers
```

```text
ℹ Run ra0a53357b53c5ca7 started. If it stops before it ends, continue it here with: teamai workflow resume ra0a53357b53c5ca7, or hand it to another machine with: teamai workflow publish ra0a53357b53c5ca7
ℹ run:ra0a53357b53c5ca7:review:1: review-quality good (teamai-score run rabebd844f8554e81).
{"data":{"done":{"run":"ra0a53357b53c5ca7","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

While the judge runs, its container and filter are there to look at:

```sh
docker ps --filter label=teamai.run=rabebd844f8554e81 --format '{{.Names}}  {{.Networks}}'
```

```text
teamai-rabebd844f8554e81-a6ee9e5b2         teamai-rabebd844f8554e81-a6ee9e5b2-net
teamai-rabebd844f8554e81-a6ee9e5b2-proxy   bridge,teamai-rabebd844f8554e81-a6ee9e5b2-net
```

**A judge signs in with an API key.** A judge container has no tool home, so a `codex: login` never reaches it. Give the sandbox an env credential its judge tool reads: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude, `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex. The steps' token from the quick start judges too. A judge also gets the model variables its tool reads, such as `ANTHROPIC_MODEL`, when the entry names them, but never your proxy or CA file: its one way out is the filter. Through a gateway, the filter lets through its base URL in place of the public API, over `https` or plain `http`:

```yaml
# sandboxes/gateway.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/gateway.yaml: Claude steps, a Codex judge through your gateway
schemaVersion: v1alpha1
name: gateway
tool: claude
runtimes:
  - use: sandbox
    sandbox: gateway
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN   # the steps
        OPENAI_API_KEY: env:OPENAI_API_KEY                     # a Codex judge
        OPENAI_BASE_URL: env:OPENAI_BASE_URL                   # https://llm.acme.internal:8443/v1 is let through
```

**The sandbox offers a judge only on the tools whose key the definition names.** With only a login, a later runtime of the definition judges instead. This definition scores sessions with `teamai-share-session`, which runs no step in the sandbox: its judge runs on your machine's Claude, through `tools`:

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
tool: claude
runtimes:
  - use: sandbox
    sandbox: containers
    options:
      credentials:
        codex: login                                          # a login: no judge in a container
  - use: tools                                                # takes the judge
```

**A gateway on this machine works as it is.** `localhost`, `127.0.0.1` or `::1` in a credential would be the container's own loopback, so teamai points it at the name your machine has in the container, keeping scheme, port and path. A step's filter, and a judge's, then let through only that port of your machine.

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4000/anthropic   (your shell)
ANTHROPIC_BASE_URL=http://host.docker.internal:4000/anthropic       (the step, on Docker Desktop)
ANTHROPIC_BASE_URL=http://host.containers.internal:4000/anthropic   (the step, on Podman)
```

Docker Engine on Linux gives your machine no such name, so there the step fails `runtime_failed` before anything is created, with a `bad_option` that names the variable but never its value. Use an address of your machine the container reaches.

**The image needs `node`** for the filter, and Docker needs to keep DNS inside an internal network: 26.0.0 or later, 25.0.5 or 23.0.11 (older versions forward a container's lookups out, CVE-2024-29018). Otherwise the sandbox offers no judge, and a definition with only the sandbox stops `confined_pending` at the judge; its steps then reach every port of this machine and run at `isolation: worktree` ([what a step reaches](#what-a-step-reaches-of-this-machine)). The quick start's image has `node`. Podman offers no judge in this version: its rootless network cannot connect the filter to the judge's network.

What the judge does not enforce:

- The filter sees host names, not requests: a judge can reach any account or path on the provider's host, and on a gateway you let through.
- The judge reads the evidence as the step that wrote it left it. teamai's own hash checks, not the container, catch a step that tampered with it.

## sbx (Docker Sandboxes)

With `provider: sbx`, each attempt runs in a microVM with its own kernel, from the template of the step's tool (or of the `agent` you name). No image to build.

**1. Once per machine:** install Docker Sandboxes, sign in, set a network policy, and sign your tools in with sbx. sbx creates no sandbox without a policy, and teamai never sets one for you.

```sh
sbx login
sbx policy init balanced                 # or deny-all, then allow your model provider:
# sbx policy allow network api.anthropic.com:443
sbx run claude ~/scratch                 # then /login in Claude Code, with your subscription, and exit
sbx rm <that sandbox>                    # its name is in sbx ls; the login stays, kept for every sandbox
sbx secret set openai --oauth            # Codex: your ChatGPT login
sbx secret ls
```

```text
SCOPE      TYPE      NAME        SECRET
(global)   service   anthropic   (oauth configured)
(global)   service   openai      (stored)
```

The login stays in sbx's proxy on your machine, which adds it to the tool's requests, and every new sandbox reuses it: no token in your environment, and no `auth.json` in the attempt's tool home. An API key works the same way: `sbx secret set anthropic`.

**2. Run a workflow with `--driver sandbox`.** teamai ships this definition, which runs the profile `default`, teamai's `teamai-default` (`provider: sbx`) unless you or the team keep one, so you need none:

```yaml
# drivers/teamai-sandbox.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-sandbox
description: Run each step in a sandbox of its own, as the sandbox profile default sets it (teamai's is a Docker Sandboxes microVM per attempt, from the template of the step's tool); this machine takes the judge and interactive steps.
runtimes:
  - use: sandbox                                   # profile default: yours, the team's, else teamai's teamai-default
    options: { max_parallel: 4 }
  - use: tools                                     # takes the judge, which sbx does not offer
```

```sh
teamai workflow start fix --driver sandbox
sbx ls                                   # while it runs: a command step, then a Claude step
```

```text
SANDBOX                                               AGENT    STATUS      PORTS   WORKSPACE
teamai-5f0c2a9e1d7b4c38-r1742da096cbb2f40-a0206b5e3   shell    ● running           /home/me/acme/app/.teamai/workflow-worktrees/teamai-r1742da096cbb2f40-build-p1-…, …
teamai-5f0c2a9e1d7b4c38-r1742da096cbb2f40-a9953a8d7   claude   ● running           /home/me/acme/app/.teamai/workflow-worktrees/teamai-r1742da096cbb2f40-fix-p1-…, …
```

```text
✔ Archived 1 step session of r1742da096cbb2f40 to teamai-reports (scrubbed)
{"data":{"done":{"run":"r1742da096cbb2f40","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

Write your own profile and definition to pin the template, keep every step in the sandbox, or name credentials:

```yaml
# sandboxes/sbx-codex.yaml
provider: sbx
agent: codex                       # no credentials: sbx's proxy signs Codex in
```

```yaml
# drivers/sbx-codex.yaml: Codex steps on the login sbx keeps for you, nothing on this machine
schemaVersion: v1alpha1
name: sbx-codex
tool: codex
runtimes:
  - use: sandbox
    sandbox: sbx-codex
```

A step on a tool you signed in neither way gets the sbx command, and the run's command steps still run:

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on codex, which the driver of this run cannot launch here: sandbox: codex cannot sign in inside this sbx sandbox, so a step there would stop at its "Not logged in": sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox's credentials. Then start again. Or remove tool from the step.
```

**3. Score what it did.** sbx offers no judge, so a scored step's judge runs on `tools`, on your machine's tool:

```sh
teamai workflow start review --driver sandbox
```

```text
ℹ run:rb2152f12cb75a939:review:1: review-quality good (teamai-score run refcf49f79792650e).
{"data":{"done":{"run":"rb2152f12cb75a939","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

What differs from a container:

- The worktree is the sandbox's workspace. The git directories, a workflow folder, the result directory, the run directory and the tool home are extra workspaces at their host paths, the git ones and the folder read-only (`/home/me/acme/app/.git:ro`). sbx does not follow a linked worktree's `.git` to the main checkout by itself, so teamai names those paths. `git status` works, and `git commit` fails.
- The step runs as sbx's `agent` user. Files it writes on your disk are still yours.
- Each `sbx exec` gets the step's names with `-e NAME`, never a value in the command line. A strict step's withheld names, such as `GH_TOKEN`, which sbx sets for its proxy, are unset in the step's process. A step's own `HOME`, `XDG_*`, `SBX_*` or `DOCKER_*` is not passed: the sbx CLI reads those itself, and the sandbox keeps its own.
- A cancel or a limit runs `sbx stop`; the next exec starts the sandbox again. When the attempt ends, teamai runs `sbx rm --force`. sbx also stops an idle sandbox on its own, and that is fine.

**A gateway on your machine** works as it is: teamai points `http://127.0.0.1:4000` at `host.docker.internal:4000`, which sbx's proxy sends to `localhost`. Your sbx policy decides whether a sandbox reaches it, and teamai asks it (`sbx policy check`, read-only) before the attempt opens. When it does not, the step fails with the rule to add, and teamai never edits the policy:

```text
✖ Step "fix" failed with runtime_failed: Step runtime "sandbox" could not open attempt a2695fde5 (sandbox_unavailable): ANTHROPIC_BASE_URL points at port 4000 of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with `sbx policy allow network localhost:4000`, and start again.
```

**sbx offers no judge.** A confined judge must reach its model provider only, and an sbx sandbox reaches every host your sbx policy allows: a balanced policy allows package registries and code hosts, through which a judge could send what it reads. A per-sandbox rule can only deny hosts it names, and policy profiles come from your organization's sbx governance, so teamai has no way to narrow one sandbox to one host. List `tools`, or a `docker` sandbox, after the sbx one to take the judge:

```yaml
# drivers/sbx-judged.yaml: steps in sbx, judges in a docker sandbox
schemaVersion: v1alpha1
name: sbx-judged
tool: claude
runtimes:
  - use: sandbox
    sandbox: sbx                     # teamai's teamai-sbx
  - use: sandbox
    sandbox: containers              # the team's sandboxes/containers.yaml, from the quick start
    options: { credentials: { ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY } }
```

What sbx itself does not hide from a step: sbx forwards your SSH agent unless you turn it off in sbx, and its proxy adds a stored global forge secret (`sbx secret set github`) to every sandbox's requests to that forge. To keep them from steps, turn forwarding off and scope or remove that secret.

## Podman

```yaml
# sandboxes/containers-podman.yaml
provider: podman
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/containers-podman.yaml
schemaVersion: v1alpha1
name: containers-podman
tool: claude
runtimes:
  - use: sandbox
    sandbox: containers-podman
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

```sh
podman machine start                     # macOS and Windows
teamai workflow start review --driver containers-podman
```

A Podman step reaches every port of this machine, so it runs at `isolation: worktree` ([what a step reaches](#what-a-step-reaches-of-this-machine)).

## seatbelt and bwrap

`seatbelt` (macOS 14 or later) and `bwrap` (Linux, [bubblewrap](https://github.com/containers/bubblewrap)) run each step as a sandboxed process on this machine, with this machine's own tools: no image and no daemon. They take only `provider` and `credentials`.

```yaml
# sandboxes/native.yaml
provider: seatbelt                 # bwrap on Linux
```

```yaml
# drivers/native.yaml
schemaVersion: v1alpha1
name: native
tool: claude
runtimes:
  - use: sandbox
    sandbox: native
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN
```

- The step writes its worktree, its result and its tool home, and reads the git directories, a workflow folder and the directories on your `PATH` (under your home, only the `bin` directory itself). It cannot read your home or your temp directory, so your SSH keys, logins and the repositories there are out of reach: its `HOME` and `TMPDIR` are empty directories of its own, and Claude Code's `CLAUDE_CODE_TMPDIR` is that `TMPDIR`. On `bwrap` it sees nothing else of this machine but its system directories. On `seatbelt` it also reads macOS's system directories (`/usr`, `/System`, `/Library`, `/opt`) and Xcode's developer directory, so a repository under `/opt` stays readable; one elsewhere, such as under `/Volumes`, does not.
- Its environment holds `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM` and `TZ`, plus what teamai gives the step. None of your other variables reaches it.
- A base URL on `localhost` or `127.0.0.1` reaches this machine as is. On `seatbelt`, the step reaches no other port of this Mac; on `bwrap`, it shares this machine's network, every port included ([what a step reaches](#what-a-step-reaches-of-this-machine)).
- A Claude login in the macOS Keychain or in `~/.claude` is not read there: name a key in `credentials`, as for a container.
- `seatbelt` denies, through `sandbox-exec`, whatever it does not allow. The step cannot signal a process it did not start or list processes with `ps` (macOS still lets it read another process's command line, so pass no secret on one), reach a Unix socket outside its place (but the DNS resolver's) or a container engine's (Docker, Colima, OrbStack, Lima, Rancher Desktop), or rename or remove a folder that holds a git file. It has no process namespace of its own, so a process the step starts in a session of its own (`setsid`) outlives the step. `bwrap` gives each step its own process, IPC and user namespaces. Both run at `isolation: worktree`, so a step with `requires: { isolation: sandbox }` or `permissions: unattended` is not offered to either.

When `bwrap` is missing, or AppArmor on Ubuntu 24.04 or later keeps it from creating a namespace, `init` fails `sandbox_unavailable` with the fix, and nothing runs on the host. For a missing `bwrap`, the fix is the install command of your distribution, as `/etc/os-release` names it (on Ubuntu or Debian):

```sh
sudo apt install bubblewrap
```

## Vercel

`vercel` runs each attempt in its own [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox), a microVM on Vercel. Its image ships Claude, so it offers Claude steps.

```yaml
# sandboxes/hosted.yaml
provider: vercel
timeout: 2h                        # optional: the sandbox's lifetime, 1m to 5h
runtime: node24                    # optional: Vercel's image
provider_auth:                     # optional: where teamai reads the Vercel sign-in
  VERCEL_TOKEN: file:~/.config/vercel-token
```

```yaml
# drivers/hosted.yaml
schemaVersion: v1alpha1
name: hosted
tool: claude
runtimes:
  - use: sandbox
    sandbox: hosted
    options:
      credentials:
        ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY
```

- teamai signs in to Vercel from `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or from `VERCEL_OIDC_TOKEN` (`vercel link`, then `vercel env pull`). `provider_auth` names another variable or a file for any of them. They are read on this machine and never reach the step.
- teamai copies the worktree, the git directories and a workflow folder (read-only), the run's files and the tool home in at their host paths. At the end of the step it copies the worktree, the result and the tool home back, changes and deletions alike, and what the step wrote among the run's files, deleting none of them, since other steps write there too. The git directories and the folder are not copied back. A link the step planted comes back as a link, and nothing is written outside the place.
- Each sandbox is created with persistence off and deleted when the attempt closes. Unset, `timeout` lasts until 5 minutes past the step's time limit, or 45 minutes for a step with none. A sandbox must last those 5 minutes past the time limit, to copy the step's work back: a `timeout` that ends sooner, or a time limit more than 4 hours 55 minutes away, fails the step `runtime_failed`, naming `bad_option` on `timeout`, before any sandbox exists.
- A sandbox on Vercel cannot reach this machine, so a credential such as `ANTHROPIC_BASE_URL` on `localhost` or `127.0.0.1` fails `bad_option`.
- A sandbox left behind shows in the Vercel dashboard (Sandboxes) as `teamai-<home id>-<run>-<attempt>`. The next attempt that opens deletes it, or its timeout ends it.

## Through an app: `teamai-sandbox-<tool>`

An app's runtime, such as T3 Code's or Paseo's, launches a tool through a binary you can set: a T3 provider instance's Binary path, or a Paseo custom provider's `command`. Set it to teamai's wrapper, and the thread stays in your app while the tool runs in the attempt's sandbox. teamai-cli installs one wrapper per tool:

```sh
command -v teamai-sandbox-claude teamai-sandbox-codex teamai-sandbox-codebuddy teamai-sandbox-opencode
# /usr/local/bin/teamai-sandbox-claude
# /usr/local/bin/teamai-sandbox-codex
# /usr/local/bin/teamai-sandbox-codebuddy
# /usr/local/bin/teamai-sandbox-opencode
teamai-sandbox-claude --version          # the host tool's own version, so the app sees a working binary
# 2.1.318 (Claude Code)
```

OpenCode runs on its free models there: teamai gives it no sign-in.

A team instance runs through a link named after it, and the wrapper runs that instance's `command` with its home variable:

```sh
ln -s "$(command -v teamai-runtime-sandbox)" ~/.local/bin/teamai-sandbox-acme-claude
```

The sandbox is the outer runtime of the entry, never the inner one: a definition that runs `sandbox` through another runtime fails with `driver_invalid`. It must mount the place at its host paths and keep the tool from this machine, so `sbx` and a filtered `docker` serve ([what a step reaches](#what-a-step-reaches-of-this-machine)); `podman`, `seatbelt`, `bwrap` and `vercel` do not.

```yaml
# drivers/t3-sandboxed.yaml
schemaVersion: v1alpha1
name: t3-sandboxed
runtimes:
  - use: t3
    through: sandbox
    sandbox: containers
    options:
      t3: { environment: local, runtime_mode: full-access }
  - use: tools
```

What happens on each prompt step:

```text
teamai  → sandbox   open          the container, and a socket of the attempt's (0600, in a 0700 directory beside its result)
teamai  → T3        open (outer)  the inner reads the socket's path from the handle and registers its agent there
T3      → teamai-sandbox-claude -p …          started in the attempt's worktree (Paseo: PASEO_AGENT_CWD)
wrapper → socket    ask           granted: docker exec -i -w <cwd> -e CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CONFIG_DIR <container> claude
wrapper            runs it         stdin, stdout, exit status and signals passed through
```

- The step's credentials and the attempt's tool home reach the tool by name (`-e NAME`). Their values stay in the runtime's memory and in that one `docker exec`'s environment: never in an argv, never on disk, and nothing of the app's own environment reaches the tool.
- Only the agent the app's runtime registered is served, while the connection it registered on stays open. A helper agent of the app in the same worktree (titles, commit messages) is refused, and so is any wrapper started before the step registered or after that connection closed.
- Outside an attempt the wrapper runs nothing and exits 2, except `--version` and Paseo's `codex app-server` model listing (no agent, under a Paseo daemon), which run the host's tool:

```text
$ teamai-sandbox-claude -p "hello"
teamai-sandbox-claude runs only inside a teamai attempt; use the plain tool or instance
$ teamai-sandbox-acme-claude -p "hello"            # in an attempt whose image lacks it
teamai-sandbox-acme-claude (tool_unsupported): acme-claude is not installed in this sandbox (image ghcr.io/acme/agent:1). Add it to the image or template the sandbox starts from, or run the step with --driver local.
```

## Limits and budgets

A step's `timeout`, `max_turns` and `budget` hold in a container as on the host. At a limit, teamai stops the tool: the runtime restarts the attempt's container, which ends every process in it.

```yaml
# workflows/explore.yaml
schemaVersion: v1alpha1
name: explore
description: Map a module within a token budget.
steps:
  - id: explore
    workspace: new
    budget: { tokens: 200000 }
    on_limit: end_turn
    prompt: Map the payment module and list its risks.
```

The step's record in the run then reads `"status": "succeeded"`, `"limit": "budget"`, with the tokens Claude reported.

## Killed and resumed

When teamai is killed while a step runs, the runtime keeps running that step's process until it ends and records how it ended. On `sbx`, the resumed run finds the sandbox again by its name (`sbx ls`). `teamai workflow resume <run> --driver containers` then follows the [step runtime rules](workflow-advanced.md#driver-definitions-and-step-runtimes): an exec that already finished is read back, and one still running is stopped and its step fails `runtime_interrupted`, keeping its work. The container is removed when the attempt closes.

When the sandbox runtime itself is killed, however (a crash, `kill -9`), what the step runs ends as follows:

| Provider | The step's processes |
| --- | --- |
| `seatbelt`, `bwrap` | End with the runtime, at once, even while the step is still starting. A process the step started in a session of its own (`setsid`) on `seatbelt` is the exception. |
| `docker`, `podman`, `sbx`, `vercel` | Keep running in the sandbox; the resumed run stops them as above, and closing the attempt removes the sandbox. |

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # goes on from the work the stopped pass kept
```

A runtime killed while `docker run`, `podman run` or `sbx create` creates a sandbox can leave it behind with no attempt that still owns it. Each container carries a `teamai.owner` label naming the teamai home that created it; sbx takes no labels, so each sbx sandbox's name starts with that id instead (`teamai-<home id>-<run>-<attempt>`). Once the next step that opens a sandbox on that provider is accepted, teamai removes, with `--force`, every container or sandbox of this home whose attempt is no longer recorded, and a judge's filter and network with it, and every network of this home whose attempt is no longer recorded, as a runtime killed before it started the container leaves one. That cleanup runs in the background: no step, cancel or close waits for it. Containers and networks of another member or another home, those with no `teamai.owner` label, and sbx sandboxes whose name does not start with this home's id are never touched. When a list or removal fails, it prints one warning on stderr and the step goes on.

```sh
docker ps -a --filter label=teamai.owner --format '{{.Names}} {{.Label "teamai.owner"}}'
# teamai-r7c41d09e2b6a5f13-a3b90c2f0 5f0c2a9e1d7b4c38    its attempt closed before it landed: the next step on docker removes it
sbx ls -q
# teamai-5f0c2a9e1d7b4c38-r7c41d09e2b6a5f13-a3b90c2f0   the same, on sbx: the next step on sbx removes it
# teamai-r7c41d09e2b6a5f13-a3b90c2f0                    named by an older teamai: kept; remove it with sbx rm --force
```

## Errors

| Error | What happened | Next step |
| --- | --- | --- |
| `sandbox_unavailable` | `sbx`, `docker` or `podman` is not installed, its daemon or machine is not running, sbx has no network policy yet, the image cannot be pulled, or your sbx policy does not let a sandbox reach the port of this machine a base URL names. `bwrap` is missing or AppArmor keeps it from making a namespace (Ubuntu 24.04 or later); `seatbelt` runs on macOS older than 14, or inside another macOS sandbox, which macOS does not nest; `vercel` finds no Vercel sign-in. Nothing runs on the host instead. | Install or start it: `sbx daemon start`, Docker Desktop, `sudo systemctl start docker`, or `podman machine start`. For sbx, `sbx policy init balanced`, or the `sbx policy allow network localhost:<port>` the message names. For an image, check its name and `docker login <registry>`. For bwrap, the install command the message names for your distribution, and the AppArmor profile it names; for seatbelt, macOS 14, or start teamai from a terminal outside the app or tool whose sandbox it runs in; for vercel, `VERCEL_TOKEN` with `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`, or `VERCEL_OIDC_TOKEN` (`vercel link`, then `vercel env pull`). |
| `tool_unavailable` | The step's tool cannot sign in inside the sandbox | The command the message names: on sbx, `sbx run claude <any dir>` then `/login`, or `sbx secret set openai --oauth`; in a container, `claude setup-token`, then export `CLAUDE_CODE_OAUTH_TOKEN` and name it in `credentials` |
| `credential_missing` | A credential's variable is not set where teamai runs, or a judge got no env credential its tool reads | Set the variable the message names, or add the key it names to `credentials` |
| `confined_pending` | No runtime of the definition offers the judge's tool: the image lacks `node` or that tool, the definition names no key for it, Docker is older than 26.0.0 (25.0.5, 23.0.11), or the provider is `podman` or `sbx` | Add `node` and the tool to the image, add the tool's key to `credentials`, update Docker, or list `tools` in the definition |
| `bad_option` | A key or value of the sandbox profile is wrong (for `sbx`, `agent: shell`), the entry's `options` hold a key of the profile, or, on Docker Engine on Linux, a credential such as `ANTHROPIC_BASE_URL` points at `localhost` or `127.0.0.1`, which a container there cannot reach | Fix the file the message names and push it; for a base URL on Linux, use an address of your machine the container reaches |
| `sandbox_profile_not_found` | No layer holds the profile the entry names | Add `sandboxes/<name>.yaml` to the team repo and run `teamai pull`, or add `~/.teamai/sandboxes/<name>.yaml` for yourself |
| `sandbox_profile_invalid` | The profile is not a YAML mapping, sets `credentials` or `max_parallel`, or, as a folder, holds a link | Fix the file the message names; keep `credentials` and `max_parallel` on the entry |
| `sandbox_failed` | The engine could not create or find the attempt's container or sandbox, for example because Docker Desktop quit mid-run. A container it could not find is kept as the attempt's, never taken as gone. | Read the message in the step failure. Start the engine again, then remove what is left: `docker ps -a --filter label=teamai.run=<run>` or `sbx ls` lists it, and the message names the `docker rm --force` or `sbx rm --force` command |
| `cancel_failed` | A cancel or a limit could not confirm the step stopped: the engine refused the stop, or the stop (a judge's removal included) and the end of the step's process took over 10 s. What ran there may still run, so teamai keeps the container, the work and the login. Example: ``docker could not stop the processes in container 3f9c2a7e1b04: Cannot connect to the Docker daemon. They may still run; remove the container with `docker rm --force 3f9c2a7e1b04`.`` | Start the engine again, then run `teamai workflow cancel <run>` again: the runtime stops the step and closes its place. Or remove it with the `docker rm --force` or `sbx rm --force` command the message names |
| **Not closed** in run details | The engine could not remove the attempt's container or sandbox, or the removal and the end of what ran there took over 10 s, so what ran there may still run. The run ends as it would. | `docker rm --force <container>` or `sbx rm --force <sandbox>`, as the message says. Once nothing of it runs, `teamai workflow cancel <run> --release <attempt>` lets the attempt go: the runtime forgets the place even when it cannot remove it, and its message still names the `rm --force` command |
| `runtime_interrupted` | teamai restarted while the step ran | `teamai workflow retry <run> <step>` |
| `isolation_unproven` (from `teamai-sandbox-<tool>`) | The wrapper was started for an agent the attempt did not register, before the step registered, or outside the attempt's worktree, so it ran nothing. Or the container is not behind a filter (Podman, a docker in a VM of its own, or Docker without `node` in the image or too old), so it reaches every port of this machine | Start the step from teamai, not the app's own agent; a helper agent of the app is refused by design. For a container, use Docker with `node` in the image ([what a step reaches](#what-a-step-reaches-of-this-machine)), or `sbx` |
| `credentials_pending` (from `teamai-sandbox-<tool>`) | The sandbox runtime restarted and teamai has not reattached the attempt yet, so it holds no credentials for the tool | `teamai workflow resume <run>`: teamai reattaches the attempt with the credentials, and the app's next start of the tool is granted |
| `tool_unsupported` (from `teamai-sandbox-<tool>`) | The sandbox does not offer the tool, or the instance's `command` is not installed in it | Add the command to the image or template the message names, or run the step with `--driver local` |

## Not in this version

- Network rules for steps. `requires.network: false` is listed in `unenforced`, and a strict one waits for a driver that declares it. What a step reaches of this machine is [kept per provider](#what-a-step-reaches-of-this-machine); off this machine, a step reaches any host, but on `sbx`, where your network policy decides.
- A judge on a tool login. A judge signs in with an env credential.
- Windows. A sandbox mounts each path of the attempt at that same path, which a `C:\` path cannot be in a Linux sandbox, so on Windows `init` fails `sandbox_unavailable` for every provider and `teamai-sandbox-<tool>` exits 2. Run teamai, and the app that uses the wrapper, inside WSL2, or run the steps with `--driver local`.
