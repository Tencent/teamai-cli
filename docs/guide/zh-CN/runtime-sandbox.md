# Sandbox 运行时

`sandbox` [步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)把工作流步骤的每次尝试放进一个独立的沙箱里运行：Docker Sandboxes 的微型虚拟机、来自团队构建的镜像的容器、这台机器上的沙箱进程，或者 Vercel Sandbox。Agent 只能处理该步骤的工作树，碰不到你机器上的其他内容。sandbox 在那里启动工具，并执行步骤的各项限制；结果的读取，以及提交和推送，仍然由 teamai 在主机上完成。

这个版本支持 `sbx`（[Docker Sandboxes](#sbxdocker-sandboxes)）、`docker`、`podman`、`seatbelt`、`bwrap` 和 `vercel`。它随 teamai 一起发布，可执行文件名为 `teamai-runtime-sandbox`。

## 快速开始

**1. 构建一个装好工具的镜像。** 检出的代码不会被复制进镜像：步骤运行时才挂载进去。

```dockerfile
# 放在你的基础设施仓库里的 Containerfile
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

**2. 在团队仓库里添加 sandbox 档案和驱动定义**，然后推送。档案写明沙箱从什么构建；驱动定义运行它，并写明 credentials。

```yaml
# sandboxes/containers.yaml
provider: docker                  # 或 podman
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

**3. 每位成员生成一次令牌。** 保存在 macOS 钥匙串里的 Claude 登录进不了容器，令牌可以。

```sh
claude setup-token                       # 为你的订阅打印一个长期有效的令牌
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…   # 写进 shell 配置文件或密钥管理工具
```

没有设置时，启动会在任何步骤运行之前停止：

```text
{"error":{"code":"credential_missing","message":"Runtime \"sandbox\" of driver definition drivers/containers.yaml in the team repo declares credential CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN is not set in your environment. Set CLAUDE_CODE_OAUTH_TOKEN, then start again."}}
```

**4. 用它运行工作流。**

```sh
teamai pull
teamai workflow start review --driver containers
```

```text
ℹ Run r7c41d09e2b6a5f13 started. If it stops before it ends, continue it here with: teamai workflow resume r7c41d09e2b6a5f13, or hand it to another machine with: teamai workflow publish r7c41d09e2b6a5f13
{"data":{"done":{"run":"r7c41d09e2b6a5f13","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

步骤运行期间，可以查看它的容器：

```sh
docker ps --filter label=teamai.run=r7c41d09e2b6a5f13 --format '{{.Names}}  {{.Image}}  {{.Status}}'
```

```text
teamai-r7c41d09e2b6a5f13-a3e9b0c51  ghcr.io/acme/agent:1  Up 41 seconds
```

尝试结束后，teamai 会删除它的容器。`teamai workflow cancel` 会停止步骤，并同样删除容器。

## Sandbox 档案

sandbox 档案写明沙箱从什么构建：它的 provider 和该 provider 的选项。团队把它放成 `sandboxes/<name>.yaml`，或者放成文件夹 `sandboxes/<name>/`，里面有 `SANDBOX.yaml` 和它构建时用的文件，比如 `Containerfile`。`use: sandbox`（或 `through: sandbox`）的条目用 `sandbox: <name>` 指定它，不写时运行档案 `default`。teamai 先在你的 `~/.teamai/sandboxes/` 里找这个名字，再到团队仓库里找，最后在它自带的档案里找，那里 `<name>` 也会按 `teamai-<name>` 找到：`default` 是 teamai 的 `teamai-default`，一个 sbx microVM；`sbx`、`docker`、`podman`、`seatbelt`、`bwrap` 和 `vercel` 各有一个，可以直接指定或复制（`teamai-docker` 和 `teamai-podman` 没写镜像，复制后要设上）。你的 `~/.teamai/sandboxes/` 或团队仓库里有这个名字的文件夹却没有 `SANDBOX.yaml`（缺失或拼错）时，运行失败并指出该文件夹，不会转到下一个位置。你或团队的档案和 teamai 的某个档案同名时，运行开始时会提示一次。每次尝试的记录都写明它运行的档案、来自哪里、它的修订、它的 provider，以及 sandbox 运行时说它在那里强制执行的内容：隔离级别，以及是否守住网络、token 和轮次限制。

条目的 `options` 只保留 teamai 自己读取的 `credentials` 和 `max_parallel`；写在那里的其他键会在任何步骤运行之前失败，并说明要把它移到哪个档案文件。读不了的档案、写了未知 provider 的档案，或者含有链接的档案文件夹，同样会失败并指出它的文件。

| 键 | 示例 | 含义 |
| --- | --- | --- |
| `provider` | `docker` | `sbx`、`docker`、`podman`、`seatbelt`、`bwrap` 或 `vercel` |
| `agent` | `claude` | 仅 `sbx`：每个沙箱从哪个 agent 模板启动，`claude` 或 `codex`，或者一个自带工具的 kit 引用。不写时，每次尝试从它自己工具的模板启动：Claude 步骤用 `claude`，Codex 步骤用 `codex`，命令步骤用裸的 `shell`。`agent: shell` 会被拒绝，因为那个模板里没有 agent。 |
| `image` | `ghcr.io/acme/agent:1` | 仅 `docker` 和 `podman`：预先构建的镜像。它需要 `/bin/sh` 以及步骤要运行的工具：`claude`、`codex` 或 `codebuddy`。需要读取历史的步骤还要装 `git`。步骤运行时 `TZ` 设为你的时区，镜像只有带 zoneinfo（`tzdata`）才会应用它，这样工具给出的“请在 <时间> 后重试”才按你的时区读取：快速开始里基于 Debian `node:22-bookworm-slim` 的镜像自带它，Alpine 镜像需要 `apk add tzdata`。 |
| `warm` | `prepare: npm ci --ignore-scripts` | 包管理器缓存已填好的镜像，只做一次，每次尝试都用它。见[预热镜像](#预热镜像)。 |
| `credentials`（写在条目上） | `CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN` | 由 teamai 在运行开始时从你的环境里读取，只交给步骤的工具，从不交给命令步骤。见[来自你环境的凭据](workflow-advanced.md#来自你环境的凭据)。 |

provider 不支持的键会在任何步骤运行之前失败：

```text
{"error":{"code":"bad_option","message":"Sandbox profile sandboxes/containers.yaml refused option \"imgae\": Provider docker takes no option \"imgae\". It takes: provider, image, warm. Fix it, push it, run teamai pull, and start again."}}
```

## 预热镜像

写了 `warm` 后，每次尝试都从包管理器缓存已经填好的镜像启动，工作流的 setup 从缓存安装，不必在每个步骤里重新下载所有包：

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

第一个打开的步骤会制作它：teamai 把 `cache` 里的文件复制到检出目录之外的临时目录，在一个不带任何凭据的 `image` 容器里于该目录运行 `prepare`，再把结果保存为 `teamai-warm:<key>`。key 由镜像在本机的状态（它的 id，所以拉取了同一标签的新推送也算变化）、配方和 `cache` 文件的内容算出，所以 lockfile 一变就会做新镜像，不变就复用，本次运行和以后的运行都是如此。指向检出目录之外文件的 `cache` 链接会被拒绝。同时打开的步骤只等一次构建。镜像只保留 `prepare` 在该目录之外留下的东西，比如主目录里的缓存（`~/.npm`）或它安装的工具：该目录本身，连同在其中生成的 `node_modules`，都不在镜像里，检出目录的任何文件也不在。setup 照常安装（`npm ci --prefer-offline`），会从缓存取包。用 `docker image ls teamai-warm` 列出。本机最后一次 `teamai uninstall` 会删除 teamai 的沙箱在这里记录过的每个预热镜像，删不掉的会列出来，并给出删除它的命令。更早版本的 teamai 做的、没有这份记录的镜像会留下：用 `docker image rm` 删除。步骤的运行详情会显示它的容器实际运行的镜像 `teamai-warm:<key>`、基础镜像，以及 sandbox 档案和它的修订。

在 `docker` 和 `podman` 上，`containerfile: ci/deps.Containerfile` 会构建这个文件而不是运行 `prepare`，构建上下文里只有 `cache` 文件；镜像里会有该文件复制进去的内容。在 `sbx` 上，`warm` 只接受 `prepare`，并保存为模板（`sbx template ls`），key 由模板和 sbx 的版本算出。sbx 0.53 还会把同一个镜像另存为它自己的 `sandbox-kit-assembled:<hash>` 模板，该 kit 的任何沙箱都从它启动：卸载只删除 `teamai-warm:<key>`，并列出那个模板；如果你没有沙箱还需要它，可以用 `sbx template rm --force` 释放它占的磁盘。在 `vercel` 上，`warm` 接受 `prepare` 和可选的 `expiration`（`30d`、`12h`；至少 `1h`，不写则为 30 天）：`prepare` 在一个 `runtime` 的临时沙箱里运行，结果保存为 Vercel 快照，每次尝试的沙箱都从它启动。Vercel 在最后一次使用后保留它 `expiration` 这么久，快照没了之后，下一次打开会重新制作。`prepare` 失败时，步骤以 `sandbox_failed` 失败并给出最后几行输出；修好之前不会运行任何步骤。

档案放成文件夹时，`containerfile: ./Containerfile` 指的是文件夹自己里面的文件，不能是链接，也不能指到文件夹外面。构建或 `prepare` 会在其目录顶层看到文件夹里的文件，与 `cache` 文件放在一起，所以 `prepare: ./prepare.sh` 运行的是文件夹里的脚本；含有链接的文件夹会被拒绝。key 还包含文件夹的修订，所以推送到文件夹的任何改动都会做出新镜像：

```text
sandboxes/node-deps/
  SANDBOX.yaml       provider: docker, image: ghcr.io/acme/agent:1, warm: { containerfile: ./Containerfile, cache: [package-lock.json] }
  Containerfile      FROM ghcr.io/acme/agent:1，然后 COPY package-lock.json 并 RUN npm ci
```

## 步骤能看到什么

```text
容器内                                                  来自主机
/home/me/acme/app/.teamai/workflow-worktrees/…          步骤的工作树，可读写
/home/me/acme/app/.git                                  git 目录，只读
~/.teamai/projects/…/attempts/a3e9b0c51/out             工具写结果的位置，可读写
~/.teamai/projects/…/attempts/a3e9b0c51/tool-home/claude   CLAUDE_CONFIG_DIR：会话，可读写
~/.teamai/projects/…/runs/r7c41d09e2b6a5f13/scratch        TEAMAI_RUN_DIR：运行共享的文件，可读写
~/.teamai/projects/…/folders/4be1c07d…                     TEAMAI_WORKFLOW_DIR：工作流目录里的文件，只读
/tmp/teamai-home                                        HOME，容器私有
```

- 每个路径都保持主机上的路径，所以不需要复制回来，`git status` 也能用。每种 `workspace` 都是这样：`new`、`continue`、`read-only`，以及 teamai 准备的 `clone` 或团队仓库副本，它们自己的 `.git` 就是只读的 git 目录。
- 在容器里 `git commit` 会失败，因为 git 目录是只读的。teamai 在主机上提交时关闭钩子，所以步骤植入的钩子永远不会运行。
- 步骤以你的身份运行：Docker 上是 `--user <你的 uid>:<gid>`，Podman 上是 `--userns keep-id`。它写的文件归你所有。在启用 SELinux 的主机上，挂载会带上共享标签（`:z`）。
- 工具把会话保存在这次尝试的工具主目录里，所以这一轮的 `teamai-score` 运行能根据它的记录评判它，带 `session: { from: … }` 的后续步骤也能恢复它。
- sandbox 自己在容器里启动提示词步骤的工具，并在那里按步骤的 `budget`、`timeout` 或空闲限制停止它。设了 `on_limit: end_turn` 的步骤被预算停下时，会保留它的会话。
- 命令步骤也在容器里运行，即使驱动定义在 sandbox 之后还列了 `tools`。只有 teamai 自己的簿记工作，比如 `teamai-score` 运行收集证据和写标签的步骤，在这台机器上运行。

**工具只在能登录的地方运行。** macOS 钥匙串或 `~/.claude` 里的 Claude 登录、你日常用的 `~/.codex`，都不会进入容器。所以只有当 `credentials` 写了某个工具的登录键（Claude 是 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`；Codex 是 `OPENAI_API_KEY`、`CODEX_API_KEY` 或 `codex: login`），或者在 sbx 上 sbx 替它保存了登录时，sandbox 才提供这个工具。用了登录不了的工具的步骤会在开始之前失败，并说明怎样给这个工具登录，而不是停在 Claude 自己的 "Not logged in"：

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude cannot sign in inside this docker sandbox, so a step there would stop at its "Not logged in": a Claude login kept in the macOS Keychain or in ~/.claude never crosses into a container; run `claude setup-token` and add CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN to the sandbox's credentials (or an API key, ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY). Then start again. Or remove tool from the step.
```

命令步骤照样在 sandbox 里运行：它们不需要登录。驱动定义在 sandbox 之后列的 `tools` 也不会接手这样的提示词步骤：它照上面那样失败，所以步骤不会因为它的工具在 sandbox 里登录不了，就改到这台机器的工具上运行。评判和交互式步骤仍由 `tools` 接手。

在 sbx 上，sbx 保存了登录的工具就用那份登录，即使你的 shell 设置了它的某个变量，比如指向网关的 `ANTHROPIC_BASE_URL`。驱动定义在 `credentials` 里写明的变量照常发给步骤的工具。

如果你的 shell 设置了 `ANTHROPIC_BASE_URL`，每个 teamai 命令在沙箱里运行的第一个 Claude 步骤会提示一次：

```text
⚠ Step runtime "sandbox", operation op-3c1e9a7f2b40: claude signs in here on the login sbx keeps (anthropic in `sbx secret ls`), so the gateway ANTHROPIC_BASE_URL names in your shell is not used in this sandbox. To use it there, add ANTHROPIC_BASE_URL: env:ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN: env:ANTHROPIC_AUTH_TOKEN to the sandbox's credentials.
```

**团队的工具实例也在这里运行。** 像 `tools/acme-claude.yaml`（`extends: claude`、`command: acme-claude`）这样的实例，只要它的工具能在沙箱里登录、沙箱里也有它的命令（镜像里有，或在 sbx 上由 kit 提供，`agent: ./kits/acme`），就会被提供，即使沙箱里没有 `claude` 本身。teamai 随后在沙箱里运行 `acme-claude`，并把实例的 home 变量指向这次尝试的工具 home。没有自己 `command` 的实例，或者命令就是它的工具本身的实例，在它的工具能运行的地方都能运行。sbx 自带的模板只包含它的 agent，所以在 `teamai-sandbox` 上这样的步骤会在开始前停下，而不是通过 `tools` 在这台机器上运行 `acme-claude`：

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: sandbox: acme-claude runs acme-claude, which is not in sbx's claude template: set agent to a kit that brings it, or run the step with --driver local. Or remove tool from the step.
```

只有分配给步骤的变量名会进入容器：它的 `requires.env` 键、工作流的 `env`、teamai 的尝试标记、工具主目录变量，以及只给步骤工具的 `credentials`。你环境里的其他内容都不会进去，所以 `GH_TOKEN`、`SSH_AUTH_SOCK` 之类会留在外面。变量值从不出现在命令行里：容器创建时不带任何凭据，每次 `docker exec -e NAME` 都从容器引擎 CLI 自己的环境里读取值。变量值也不会写到磁盘上：运行时记下的每次 exec 结果里，工具打印出的凭据都会被遮盖。

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e CLAUDE_CONFIG_DIR -e TEAMAI_WORKFLOW_RESULT -e CLAUDE_CODE_OAUTH_TOKEN teamai-r7c41d09e2b6a5f13-a3e9b0c51 claude -p …
```

**工作流的 `setup` 也在步骤的容器里运行**，在步骤之前，只带 setup 自己的 `requires.env` 键，不带步骤的任何键：步骤的键会被取消设置，`credentials` 只给工具。

```yaml
# workflows/review.yaml
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
```

```text
docker exec -w /home/me/acme/app/.teamai/workflow-worktrees/… -e NPM_TOKEN -e TEAMAI_WORKFLOW_ATTEMPT -e TEAMAI_MODE -e TEAMAI_RUN_DIR teamai-r7c41d09e2b6a5f13-a3e9b0c51 env -u SIGNING_KEY -- /bin/sh -c 'npm ci'
```

之后 teamai 和在 `local` 上一样，在主机上检查 setup 在工作树里留下了什么。setup 失败、改动了被跟踪的文件，或者把某个键的值写进了文件，都会让步骤在工具启动前停下：

```text
✖ Step "review" failed with setup_failed: Setup "npm ci" exited with code 1, so the step did not run. It printed: npm error 401 Unauthorized - GET https://npm.acme.internal/@acme%2fui Fix setup, then retry the step.
✖ Step "review" failed with setup_secret: Setup "npm ci" left the value of NPM_TOKEN in .npmrc, where the step could read it, so the step did not run. Make setup remove the files it writes NPM_TOKEN to, then retry the step.
```

## 步骤能连到这台机器的什么

步骤的工具要和它的模型提供方通信，常常经由这台机器上的一个网关。这台机器上监听的其他东西，比如数据库、应用的本地服务器或另一个 agent 的守护进程，对连得到它的步骤来说就是一条逃出沙箱的路。各个提供方上，步骤能连到这台机器的这些东西：

| 提供方 | 步骤能连到这台机器的什么 | 隔离 |
| --- | --- | --- |
| Docker Desktop 上的 `docker`，或这台 Linux 机器上 Docker Engine 的 `docker`，镜像里有 `node`，26.0.0 或更高（25.0.5、23.0.11） | 只有它的凭据写到的这台机器的端口，比如网关的端口。容器在自己的网络上，唯一的出口是一个过滤器，设为它的 `HTTPS_PROXY` 和 `HTTP_PROXY`：过滤器放行这台机器之外的任何主机和这些端口，拒绝这台机器和 Docker 主机的其他所有地址。 | `sandbox`，包括 unattended |
| 其他情况下的 `docker`（比如跑在自己的虚拟机里：Colima、Rancher Desktop、Lima），以及 `podman` | 这台机器的每个端口，经由它在容器里的地址 | `worktree` |
| `sbx` | 你的 sbx 网络策略允许的：这台机器的某个端口要等 `sbx policy allow network localhost:<port>` 放行之后 | `sandbox`，包括 unattended |
| `seatbelt` | 只有它的凭据写到的端口，在这台 Mac 的任何地址上，所以连步骤自己启动的服务器也连不到；Unix 套接字只能是它的位置里的，以及 DNS 解析器的 | `worktree` |
| `bwrap` | 这台机器的每个端口，以及它的抽象 Unix 套接字：步骤和这台机器共用网络 | `worktree` |
| `vercel` | 什么都连不到：凭据里写 `localhost` 会以 `bad_option` 失败 | `sandbox`，包括 unattended |

在 `worktree` 上，带 `requires: { isolation: sandbox }` 或 `permissions: unattended` 的步骤不会交给这个运行时，应用的工具也不会经由 [`teamai-sandbox-<tool>`](#通过应用运行teamai-sandbox-tool) 在那里运行。在经过过滤的 `docker` 步骤里，忽略 `HTTPS_PROXY` 和 `HTTP_PROXY` 的客户端连不到这台机器之外的任何东西；环境里写了你自己的代理的步骤也一样：teamai 不会把过滤器的流量转给另一个代理。

## 在 sandbox 里评判

被评分的一轮由它的 `teamai-score` 运行评判，其中的评判步骤只读取 teamai 收集的证据。sandbox 也运行这个评判，所以只有 `sandbox` 的驱动定义不需要你机器上装有任何 AI 工具就能评判。每次评判都有一个全新的容器：

```text
评判容器 teamai-<run>-<attempt>                         来自主机
/evidence                                               证据，只读：别的都没有
网络 <name>-net，internal                               除了过滤器没有出口
过滤器 <name>-proxy                                     只放行模型提供方：api.anthropic.com:443
```

- Claude 只带 `Read`、`Grep` 和 `Glob` 运行，所以只能读证据（`access: read`）。Codex 把容器当作它的沙箱运行，所以能在容器里执行命令（`access: full`），但仍然只能接触到 `dir` 和模型提供方。
- 证据挂载在 `/evidence`，评判的提示词和工作目录也用这个路径指代它，所以评判的挂载和提示词里没有你的主目录、用户名或项目路径。证据文件本身（比如转录）仍然保留会话写下的内容。
- 评判只拿到它自己的工具会读取的环境变量凭据，拿不到你的环境、SSH agent 或运行目录。它计入 sandbox 的 `max_parallel`。
- 运行会记录运行时实际保持的级别 `verified`，以及工具在那里能做什么。

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

评判运行期间，可以查看它的容器和过滤器：

```sh
docker ps --filter label=teamai.run=rabebd844f8554e81 --format '{{.Names}}  {{.Networks}}'
```

```text
teamai-rabebd844f8554e81-a6ee9e5b2         teamai-rabebd844f8554e81-a6ee9e5b2-net
teamai-rabebd844f8554e81-a6ee9e5b2-proxy   bridge,teamai-rabebd844f8554e81-a6ee9e5b2-net
```

**评判用 API 密钥登录。** 评判容器没有工具主目录，所以 `codex: login` 永远到不了它那里。给 sandbox 一个评判工具会读取的环境变量凭据：Claude 用 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，Codex 用 `OPENAI_API_KEY` 或 `CODEX_API_KEY`。快速开始里步骤用的令牌也能用来评判。条目里写了的话，评判也会拿到它的工具读取的模型变量，例如 `ANTHROPIC_MODEL`，但永远拿不到你的代理或 CA 文件：它唯一的出口是过滤器。通过网关时，过滤器放行它的 base URL 而不是公共 API，`https` 和普通 `http` 都可以：

```yaml
# sandboxes/gateway.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/gateway.yaml：步骤用 Claude，评判用经过你的网关的 Codex
schemaVersion: v1alpha1
name: gateway
tool: claude
runtimes:
  - use: sandbox
    sandbox: gateway
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN   # 步骤用
        OPENAI_API_KEY: env:OPENAI_API_KEY                     # Codex 评判用
        OPENAI_BASE_URL: env:OPENAI_BASE_URL                   # 放行 https://llm.acme.internal:8443/v1
```

**sandbox 只为驱动定义里给了密钥的工具提供评判。** 只有登录时，由驱动定义里后面的运行时来评判。这个驱动定义用 `teamai-share-session` 给会话打分，不在 sandbox 里运行步骤：评判经由 `tools` 在你机器上的 Claude 上运行：

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
        codex: login                                          # 只是登录：容器里不评判
  - use: tools                                                # 接手评判
```

**本机上的网关可以直接用。** 凭据里的 `localhost`、`127.0.0.1` 或 `::1` 在容器里会是容器自己的回环地址，所以 teamai 会把它改成你的机器在容器里的名字，协议、端口和路径保持不变。步骤的过滤器和评判的过滤器也只放行你机器上的那个端口。

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4000/anthropic   （你的 shell）
ANTHROPIC_BASE_URL=http://host.docker.internal:4000/anthropic       （步骤，Docker Desktop 上）
ANTHROPIC_BASE_URL=http://host.containers.internal:4000/anthropic   （步骤，Podman 上）
```

Linux 上的 Docker Engine 不给你的机器这样的名字，所以在那里步骤会在创建任何东西之前以 `runtime_failed` 失败，并写明 `bad_option`，信息里说出变量名，但从不说出它的值。请改用容器能到达的你的机器的地址。

**镜像里需要 `node`** 来运行过滤器，Docker 也要能把 DNS 限制在 internal 网络里：26.0.0 或更高、25.0.5 或 23.0.11（更旧的版本会把容器的查询转发出去，CVE-2024-29018）。否则 sandbox 不提供评判，只有这个 sandbox 的驱动定义运行到评判时会以 `confined_pending` 停下；它的步骤也能连到这台机器的每个端口，以 `isolation: worktree` 运行（[步骤能连到什么](#步骤能连到这台机器的什么)）。快速开始里的镜像带有 `node`。这个版本的 Podman 不提供评判：它的 rootless 网络无法把过滤器接到评判的网络上。

评判不保证的事：

- 过滤器只看主机名，看不到请求内容：评判能访问模型提供方主机上的任何账号或路径，以及你放行的网关。
- 评判读到的证据就是写它的步骤留下的样子。发现步骤篡改证据靠的是 teamai 自己的哈希检查，不是容器。

## sbx（Docker Sandboxes）

使用 `provider: sbx` 时，每次尝试都在一个有自己内核的微型虚拟机里运行，来自步骤工具的模板（或者你指定的 `agent` 的模板）。不需要构建镜像。

**1. 每台机器做一次：** 安装 Docker Sandboxes、登录、设置网络策略，并用 sbx 给你的工具登录。没有网络策略时 sbx 不会创建任何沙箱，teamai 也从不替你设置。

```sh
sbx login
sbx policy init balanced                 # 或者 deny-all，再放行你的模型提供方：
# sbx policy allow network api.anthropic.com:443
sbx run claude ~/scratch                 # 然后在 Claude Code 里用你的订阅执行 /login，再退出
sbx rm <那个沙箱>                         # 名字见 sbx ls；登录保留，供每个沙箱使用
sbx secret set openai --oauth            # Codex：你的 ChatGPT 登录
sbx secret ls
```

```text
SCOPE      TYPE      NAME        SECRET
(global)   service   anthropic   (oauth configured)
(global)   service   openai      (stored)
```

登录留在你机器上 sbx 的代理里，由代理加到工具的请求上，每个新沙箱都会复用它：你的环境里不需要令牌，这次尝试的工具主目录里也没有 `auth.json`。API key 也一样：`sbx secret set anthropic`。

**2. 用 `--driver sandbox` 运行工作流。** teamai 自带这个驱动定义，它运行档案 `default`：除非你或团队有自己的，否则就是 teamai 的 `teamai-default`（`provider: sbx`），你不需要自己写：

```yaml
# drivers/teamai-sandbox.yaml，随 teamai 提供
schemaVersion: v1alpha1
name: teamai-sandbox
description: Run each step in a sandbox of its own, as the sandbox profile default sets it (teamai's is a Docker Sandboxes microVM per attempt, from the template of the step's tool); this machine takes the judge and interactive steps.
runtimes:
  - use: sandbox                                   # 档案 default：你的、团队的，否则用 teamai 的 teamai-default
    options: { max_parallel: 4 }
  - use: tools                                     # 负责评判：sbx 不提供评判
```

```sh
teamai workflow start fix --driver sandbox
sbx ls                                   # 运行时：一个命令步骤，再一个 Claude 步骤
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

想固定模板、让每个步骤都留在 sandbox 里，或者写明 credentials 时，再写你自己的档案和驱动定义：

```yaml
# sandboxes/sbx-codex.yaml
provider: sbx
agent: codex                       # 不需要 credentials：sbx 的代理替 Codex 登录
```

```yaml
# drivers/sbx-codex.yaml：用 sbx 替你保存的登录运行 Codex 步骤，这台机器上什么都不运行
schemaVersion: v1alpha1
name: sbx-codex
tool: codex
runtimes:
  - use: sandbox
    sandbox: sbx-codex
```

两种方式都没给工具登录时，用这个工具的步骤会拿到 sbx 命令，运行里的命令步骤照样运行：

```text
✖ Step "review" failed with tool_unavailable: Step "review" runs on codex, which the driver of this run cannot launch here: sandbox: codex cannot sign in inside this sbx sandbox, so a step there would stop at its "Not logged in": sign Codex in once with sbx, `sbx secret set openai --oauth` (or store an API key with `sbx secret set openai`), or add OPENAI_API_KEY: env:OPENAI_API_KEY to the sandbox's credentials. Then start again. Or remove tool from the step.
```

**3. 给它做的事评分。** sbx 不提供评判，所以评分步骤的评判在 `tools` 上、用你机器上的工具运行：

```sh
teamai workflow start review --driver sandbox
```

```text
ℹ run:rb2152f12cb75a939:review:1: review-quality good (teamai-score run refcf49f79792650e).
{"data":{"done":{"run":"rb2152f12cb75a939","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

和容器不同的地方：

- 工作树是沙箱的工作区。git 目录、工作流目录、结果目录、运行目录和工具主目录是额外的工作区，都在主机上的路径，git 的那些和工作流目录是只读的（`/home/me/acme/app/.git:ro`）。sbx 自己不会顺着链接工作树的 `.git` 找到主检出，所以由 teamai 列出这些路径。`git status` 能用，`git commit` 会失败。
- 步骤以 sbx 的 `agent` 用户运行。它写到你磁盘上的文件仍然归你所有。
- 每次 `sbx exec` 都用 `-e NAME` 拿到步骤的变量名，命令行里从不出现值。严格步骤要扣下的变量，比如 sbx 为它的代理设置的 `GH_TOKEN`，会在步骤进程里被取消设置。步骤自己的 `HOME`、`XDG_*`、`SBX_*` 或 `DOCKER_*` 不会传进去：sbx CLI 自己读取它们，沙箱保留它自己的。
- 取消或到达限制时执行 `sbx stop`，下一次 exec 会重新启动沙箱。尝试结束时 teamai 执行 `sbx rm --force`。sbx 也会自己停掉空闲的沙箱，这没有问题。

**你机器上的网关**可以直接用：teamai 把 `http://127.0.0.1:4000` 改成 `host.docker.internal:4000`，sbx 的代理会把它转到 `localhost`。沙箱能不能访问它由你的 sbx 策略决定，teamai 在打开尝试之前会问它（`sbx policy check`，只读）。不允许时，步骤失败并给出要添加的规则，teamai 从不修改策略：

```text
✖ Step "fix" failed with runtime_failed: Step runtime "sandbox" could not open attempt a2695fde5 (sandbox_unavailable): ANTHROPIC_BASE_URL points at port 4000 of this machine, which your sbx network policy does not let a sandbox reach. Allow it once with `sbx policy allow network localhost:4000`, and start again.
```

**sbx 不提供评判。** 受限的评判只能访问它的模型提供方，而 sbx 沙箱能访问你的 sbx 策略放行的所有主机：balanced 策略放行包仓库和代码托管站点，评判可以借它们把读到的内容发出去。单个沙箱的规则只能拒绝它点名的主机，策略 profile 来自你所在组织的 sbx 治理设置，所以 teamai 没有办法把一个沙箱收窄到只能访问一个主机。在 sbx 之后列上 `tools` 或一个 `docker` sandbox 来负责评判：

```yaml
# drivers/sbx-judged.yaml：步骤在 sbx 里，评判在 docker sandbox 里
schemaVersion: v1alpha1
name: sbx-judged
tool: claude
runtimes:
  - use: sandbox
    sandbox: sbx                     # teamai 的 teamai-sbx
  - use: sandbox
    sandbox: containers              # 团队的 sandboxes/containers.yaml，见快速开始
    options: { credentials: { ANTHROPIC_API_KEY: env:ANTHROPIC_API_KEY } }
```

sbx 本身不会对步骤隐藏的东西：除非你在 sbx 里关掉，sbx 会转发你的 SSH agent；它的代理会把保存的全局代码托管密钥（`sbx secret set github`）加到每个沙箱发往该站点的请求上。要让步骤拿不到它们，就关掉转发，并限定或删除那个密钥。

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
podman machine start                     # macOS 和 Windows
teamai workflow start review --driver containers-podman
```

Podman 步骤能连到这台机器的每个端口，所以以 `isolation: worktree` 运行（[步骤能连到什么](#步骤能连到这台机器的什么)）。

## seatbelt 和 bwrap

`seatbelt`（macOS 14 或更高版本）和 `bwrap`（Linux，[bubblewrap](https://github.com/containers/bubblewrap)）把每个步骤作为这台机器上的一个沙箱进程运行，用的是这台机器自己的工具：不需要镜像，也不需要守护进程。它们只接受 `provider` 和 `credentials`。

```yaml
# sandboxes/native.yaml
provider: seatbelt                 # Linux 上用 bwrap
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

- 步骤可以写它的工作树、结果和工具主目录，可以读 git 目录、工作流目录和你 `PATH` 上的目录（在你的主目录下只有 `bin` 目录本身）。它读不到你的主目录和临时目录，所以那里的 SSH 密钥、登录和仓库它都碰不到：它的 `HOME` 和 `TMPDIR` 是它自己的空目录，Claude Code 的 `CLAUDE_CODE_TMPDIR` 就是这个 `TMPDIR`。在 `bwrap` 上，除了系统目录，它看不到这台机器上的其他东西。在 `seatbelt` 上，它还能读 macOS 的系统目录（`/usr`、`/System`、`/Library`、`/opt`）和 Xcode 的开发者目录，所以 `/opt` 下的仓库仍然可读；其他位置（比如 `/Volumes` 下）的仓库读不到。
- 它的环境只有 `PATH`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TERM` 和 `TZ`，再加上 teamai 给这个步骤的变量。你的其他变量都到不了它那里。
- `localhost` 或 `127.0.0.1` 上的 base URL 原样连到这台机器。在 `seatbelt` 上，步骤连不到这台 Mac 的其他端口；在 `bwrap` 上，它和这台机器共用网络，包括每个端口（[步骤能连到什么](#步骤能连到这台机器的什么)）。
- 存在 macOS 钥匙串或 `~/.claude` 里的 Claude 登录在那里不会被读取：和容器一样，在 `credentials` 里写上一个密钥。
- `seatbelt` 通过 `sandbox-exec` 拒绝它没有明确允许的一切。步骤不能给不是它启动的进程发信号，也不能用 `ps` 列出进程（macOS 仍允许它读取其他进程的命令行，所以不要在命令行里传递机密），不能连接它的位置之外的 Unix 套接字（DNS 解析器的除外）或容器引擎的套接字（Docker、Colima、OrbStack、Lima、Rancher Desktop），也不能重命名或删除存放 git 文件的文件夹。它没有自己的进程命名空间，所以步骤在自己的会话里（`setsid`）启动的进程会在步骤结束后继续运行。`bwrap` 给每个步骤单独的进程、IPC 和用户命名空间。两者都以 `isolation: worktree` 运行，所以带 `requires: { isolation: sandbox }` 或 `permissions: unattended` 的步骤不会交给它们。

当 `bwrap` 没有安装，或者 Ubuntu 24.04 及更高版本上的 AppArmor 不让它创建命名空间时，`init` 以 `sandbox_unavailable` 失败并给出修复方法，主机上什么都不会运行。`bwrap` 没有安装时，修复方法是 `/etc/os-release` 所写发行版的安装命令（Ubuntu 或 Debian 上）：

```sh
sudo apt install bubblewrap
```

## Vercel

`vercel` 把每次尝试放进它自己的 [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)，也就是 Vercel 上的一个微型虚拟机。它的镜像自带 Claude，所以它提供 Claude 步骤。

```yaml
# sandboxes/hosted.yaml
provider: vercel
timeout: 2h                        # 可选：沙箱的存活时间，1m 到 5h
runtime: node24                    # 可选：Vercel 的镜像
provider_auth:                     # 可选：teamai 从哪里读取 Vercel 登录信息
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

- teamai 用 `VERCEL_TOKEN`、`VERCEL_TEAM_ID` 和 `VERCEL_PROJECT_ID`，或者用 `VERCEL_OIDC_TOKEN`（先 `vercel link`，再 `vercel env pull`）登录 Vercel。`provider_auth` 可以为其中任意一个指定另一个变量或一个文件。它们在这台机器上读取，永远不会到达步骤。
- teamai 把工作树、git 目录和工作流目录（只读）、运行的文件和工具主目录按主机路径复制进去。步骤结束时，它把工作树、结果和工具主目录复制回来，修改和删除都会带回；步骤在运行的文件里写下的文件也会带回，但那里不删除任何东西，因为其他步骤也会写那里。git 目录和工作流目录不会复制回来。步骤放下的链接以链接的形式带回，这次尝试的目录之外什么都不会写。
- 每个沙箱创建时都关闭持久化，并在尝试关闭时删除。不设置时，`timeout` 持续到步骤时间限制之后 5 分钟；步骤没有时间限制时为 45 分钟。沙箱必须在时间限制之后再存活这 5 分钟，才能把步骤的工作拷回来：如果 `timeout` 更早结束，或者时间限制在 4 小时 55 分钟以后，步骤会在创建任何沙箱之前以 `runtime_failed` 失败，并写明 `timeout` 上的 `bad_option`。
- Vercel 上的沙箱连不到这台机器，所以指向 `localhost` 或 `127.0.0.1` 的凭据（例如 `ANTHROPIC_BASE_URL`）会以 `bad_option` 失败。
- 遗留下来的沙箱会以 `teamai-<home id>-<run>-<attempt>` 的名字出现在 Vercel 控制台（Sandboxes）里。下一个打开的尝试会删除它，或者它的 timeout 到了就会结束它。

## 通过应用运行：`teamai-sandbox-<tool>`

应用的运行时（例如 T3 Code 或 Paseo）通过一个可以设置的可执行文件启动工具：T3 provider instance 的 Binary path，或 Paseo 自定义 provider 的 `command`。把它设成 teamai 的包装器，线程就留在你的应用里，而工具在这次尝试的沙箱里运行。teamai-cli 为每个工具安装一个包装器：

```sh
command -v teamai-sandbox-claude teamai-sandbox-codex teamai-sandbox-codebuddy teamai-sandbox-opencode
# /usr/local/bin/teamai-sandbox-claude
# /usr/local/bin/teamai-sandbox-codex
# /usr/local/bin/teamai-sandbox-codebuddy
# /usr/local/bin/teamai-sandbox-opencode
teamai-sandbox-claude --version          # 主机上工具自己的版本，应用看到的是一个正常的可执行文件
# 2.1.318 (Claude Code)
```

OpenCode 在那里只运行它的免费模型：teamai 不给它任何登录。

团队实例通过以它命名的链接运行，包装器会运行该实例的 `command`，并设置它的 home 变量：

```sh
ln -s "$(command -v teamai-runtime-sandbox)" ~/.local/bin/teamai-sandbox-acme-claude
```

沙箱是这个条目的外层运行时，从不做内层：让 `sandbox` 经由另一个运行时运行的驱动定义会以 `driver_invalid` 失败。它必须把位置挂载在主机上的同一路径，并让工具连不到这台机器，所以 `sbx` 和经过过滤的 `docker` 可以（[步骤能连到什么](#步骤能连到这台机器的什么)），`podman`、`seatbelt`、`bwrap` 和 `vercel` 不行。

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

每个 prompt 步骤的过程：

```text
teamai  → sandbox   open          创建容器，以及这次尝试自己的 socket（0600，位于结果目录旁一个 0700 的目录里）
teamai  → T3        open (outer)  内层从 handle 读到 socket 路径，并在那里登记它的 agent
T3      → teamai-sandbox-claude -p …          在这次尝试的 worktree 里启动（Paseo：PASEO_AGENT_CWD）
wrapper → socket    ask           得到授权：docker exec -i -w <cwd> -e CLAUDE_CODE_OAUTH_TOKEN -e CLAUDE_CONFIG_DIR <container> claude
wrapper            运行它           stdin、stdout、退出码和信号原样传递
```

- 步骤的凭据和这次尝试的工具 home 只按名字（`-e NAME`）传给工具。它们的值只在运行时的内存和那一个 `docker exec` 的环境里：不会出现在任何 argv 里，也不会写到磁盘上，应用自己的环境也不会传到工具。
- 只为应用的运行时登记的那个 agent 服务，并且只在它登记所用的连接保持打开期间。应用在同一个 worktree 里的辅助 agent（生成标题、提交信息）会被拒绝，步骤登记之前、或那个连接关闭之后启动的包装器也会被拒绝。
- 在尝试之外，包装器什么都不运行，以 2 退出；只有 `--version` 和 Paseo 的 `codex app-server` 模型列表（没有 agent、在 Paseo 守护进程下）会运行主机上的工具：

```text
$ teamai-sandbox-claude -p "hello"
teamai-sandbox-claude runs only inside a teamai attempt; use the plain tool or instance
$ teamai-sandbox-acme-claude -p "hello"            # 在镜像里没有它的尝试中
teamai-sandbox-acme-claude (tool_unsupported): acme-claude is not installed in this sandbox (image ghcr.io/acme/agent:1). Add it to the image or template the sandbox starts from, or run the step with --driver local.
```

## 限制和预算

步骤的 `timeout`、`max_turns` 和 `budget` 在容器里和在主机上一样生效。到达限制时，teamai 停止工具：运行时重启这次尝试的容器，容器里的所有进程随之结束。

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

之后运行记录里这个步骤是 `"status": "succeeded"`、`"limit": "budget"`，并带上 Claude 报告的 token 数。

## 被终止后恢复

如果 teamai 在步骤运行时被终止，运行时会让该步骤的进程继续运行到结束，并记录它是怎么结束的。在 `sbx` 上，恢复的运行会按名字（`sbx ls`）重新找到沙箱。之后 `teamai workflow resume <run> --driver containers` 按[步骤运行时的规则](workflow-advanced.md#驱动定义和步骤运行时)处理：已经结束的 exec 会被读回；仍在运行的会被停止，步骤以 `runtime_interrupted` 失败，但保留它的工作。尝试关闭时容器被删除。

如果沙箱运行时本身被终止（崩溃、`kill -9`），步骤运行的东西按下表结束：

| 提供方 | 步骤的进程 |
| --- | --- |
| `seatbelt`、`bwrap` | 随运行时立即结束，即使步骤还在启动中。例外：在 `seatbelt` 上，步骤在自己的会话里（`setsid`）启动的进程。 |
| `docker`、`podman`、`sbx`、`vercel` | 在沙箱里继续运行；恢复的运行像上面那样停止它们，关闭尝试时删除沙箱。 |

```sh
teamai workflow resume r7c41d09e2b6a5f13 --driver containers
teamai workflow retry r7c41d09e2b6a5f13 review      # 从被停止的那一轮保留下来的工作继续
```

如果运行时在 `docker run`、`podman run` 或 `sbx create` 创建沙箱时被终止，可能会留下一个已经不属于任何尝试的沙箱。每个容器都带有 `teamai.owner` 标签，标明创建它的 teamai 主目录；sbx 不支持标签，所以每个 sbx 沙箱的名字以这个 id 开头（`teamai-<home id>-<run>-<attempt>`）。在同一提供方上打开沙箱的下一个步骤被接受之后，teamai 会用 `--force` 删除这个主目录下所有已经没有尝试记录的容器或沙箱，评判容器的过滤器和网络也一起删除；这个主目录下已经没有尝试记录的网络也会删除，运行时在启动容器之前被终止时就会留下这样的网络。这个清理在后台进行：步骤、取消和关闭都不会等它。其他成员或其他主目录的容器和网络、没有 `teamai.owner` 标签的容器和网络，以及名字不以这个主目录 id 开头的 sbx 沙箱，都不会被动到。列出或删除失败时，会在 stderr 输出一条警告，步骤照常继续。

```sh
docker ps -a --filter label=teamai.owner --format '{{.Names}} {{.Label "teamai.owner"}}'
# teamai-r7c41d09e2b6a5f13-a3b90c2f0 5f0c2a9e1d7b4c38    它落地前尝试已经关闭：docker 上的下一个步骤会删除它
sbx ls -q
# teamai-5f0c2a9e1d7b4c38-r7c41d09e2b6a5f13-a3b90c2f0   sbx 上的同样情况：sbx 上的下一个步骤会删除它
# teamai-r7c41d09e2b6a5f13-a3b90c2f0                    旧版 teamai 起的名字：保留；用 sbx rm --force 删除
```

## 错误

| 错误 | 发生了什么 | 下一步 |
| --- | --- | --- |
| `sandbox_unavailable` | 没有安装 `sbx`、`docker` 或 `podman`，它的守护进程或虚拟机没有运行，sbx 还没有网络策略，拉取不到镜像，或者你的 sbx 策略不允许沙箱访问 base URL 指向的本机端口。`bwrap` 没有安装，或者 AppArmor 不让它创建命名空间（Ubuntu 24.04 及更高版本）；`seatbelt` 运行在低于 14 的 macOS 上，或者运行在另一个 macOS 沙箱里（macOS 不支持沙箱嵌套）；`vercel` 找不到 Vercel 登录。不会改为在主机上运行。 | 安装或启动它：`sbx daemon start`、Docker Desktop、`sudo systemctl start docker`，或 `podman machine start`。sbx 执行 `sbx policy init balanced`，或信息里给出的 `sbx policy allow network localhost:<port>`。镜像问题请检查名称，并执行 `docker login <registry>`。bwrap 执行信息里给出的、适用于你的发行版的安装命令，并按信息里给出的 AppArmor 配置处理；seatbelt 需要 macOS 14，或者从该沙箱所属的应用或工具之外的终端启动 teamai；vercel 需要 `VERCEL_TOKEN` 加 `VERCEL_TEAM_ID` 和 `VERCEL_PROJECT_ID`，或 `VERCEL_OIDC_TOKEN`（先 `vercel link`，再 `vercel env pull`）。 |
| `tool_unavailable` | 步骤的工具在 sandbox 里登录不了 | 执行信息里点名的命令：sbx 上执行 `sbx run claude <任意目录>` 再 `/login`，或 `sbx secret set openai --oauth`；容器里执行 `claude setup-token`，再导出 `CLAUDE_CODE_OAUTH_TOKEN` 并写进 `credentials` |
| `credential_missing` | 凭据对应的变量在 teamai 运行的地方没有设置，或者评判没有拿到它的工具会读取的环境变量凭据 | 设置信息里点名的变量，或者把它点名的密钥加到 `credentials` |
| `confined_pending` | 驱动定义里没有运行时提供评判用的工具：镜像缺少 `node` 或那个工具，驱动定义没给它密钥，Docker 早于 26.0.0（25.0.5、23.0.11），或者 provider 是 `podman` 或 `sbx` | 把 `node` 和工具装进镜像、在 `credentials` 里加上工具的密钥、升级 Docker，或者在驱动定义里列上 `tools` |
| `bad_option` | sandbox 档案里有键或值写错了（`sbx` 写了 `agent: shell`），条目的 `options` 里写了档案的键，或者在 Linux 上的 Docker Engine 里，`ANTHROPIC_BASE_URL` 这类凭据指向那里的容器到不了的 `localhost` 或 `127.0.0.1` | 修正消息指出的文件并推送；Linux 上的 base URL 改用容器能到达的你的机器的地址 |
| `sandbox_profile_not_found` | 没有任何一层有条目指定的档案 | 在团队仓库里添加 `sandboxes/<name>.yaml` 并运行 `teamai pull`，或者为自己添加 `~/.teamai/sandboxes/<name>.yaml` |
| `sandbox_profile_invalid` | 档案不是 YAML 映射、写了 `credentials` 或 `max_parallel`，或者作为文件夹含有链接 | 修正消息指出的文件；`credentials` 和 `max_parallel` 留在条目上 |
| `sandbox_failed` | 无法创建或查找这次尝试的容器或沙箱，例如运行中途退出了 Docker Desktop。查找失败的容器仍算作这次尝试的，不会当作已经不存在。 | 查看步骤失败里给出的信息。先重新启动引擎，再删除剩下的：`docker ps -a --filter label=teamai.run=<run>` 或 `sbx ls` 会列出它，信息里给出了要执行的 `docker rm --force` 或 `sbx rm --force` 命令 |
| `cancel_failed` | 取消或达到限制时，无法确认步骤已经停止：引擎拒绝了停止，或者停止（包括删除评判的容器）加上步骤进程的结束超过了 10 秒。那里运行的内容可能仍在运行，所以 teamai 保留容器、工作和登录。例如：``docker could not stop the processes in container 3f9c2a7e1b04: Cannot connect to the Docker daemon. They may still run; remove the container with `docker rm --force 3f9c2a7e1b04`.`` | 先重新启动引擎，再运行一次 `teamai workflow cancel <run>`：运行时会停止步骤并关闭它的位置。也可以用信息里给出的 `docker rm --force` 或 `sbx rm --force` 命令删除它 |
| 运行详情里的 **未关闭**（Not closed） | 无法删除这次尝试的容器或沙箱，或者删除和其中运行内容的结束超过了 10 秒，里面运行的东西可能还在运行。运行本身照常结束。 | 按信息里给出的命令执行 `docker rm --force <container>` 或 `sbx rm --force <sandbox>`。确认其中已没有任何东西在运行后，`teamai workflow cancel <run> --release <attempt>` 会放开这次尝试：即使运行时无法删除这个位置，也会忘掉它，信息里仍会给出 `rm --force` 命令 |
| `runtime_interrupted` | 步骤运行时 teamai 重启了 | `teamai workflow retry <run> <step>` |
| `isolation_unproven`（来自 `teamai-sandbox-<tool>`） | 包装器是为这次尝试没有登记的 agent 启动的，或者在步骤登记之前、在尝试的 worktree 之外启动的，所以什么都没有运行。或者容器不在过滤器后面（Podman、跑在自己虚拟机里的 docker，或者镜像里没有 `node`、版本太旧的 Docker），所以它能连到这台机器的每个端口 | 从 teamai 启动步骤，而不是应用自己的 agent；应用的辅助 agent 按设计会被拒绝。容器的话，用镜像里有 `node` 的 Docker（[步骤能连到什么](#步骤能连到这台机器的什么)），或者 `sbx` |
| `credentials_pending`（来自 `teamai-sandbox-<tool>`） | 沙箱运行时重启了，teamai 还没有重新连接这次尝试，所以它没有工具的凭据 | `teamai workflow resume <run>`：teamai 带着凭据重新连接这次尝试，应用下一次启动工具时就会得到授权 |
| `tool_unsupported`（来自 `teamai-sandbox-<tool>`） | 沙箱不提供这个工具，或者实例的 `command` 没有安装在里面 | 把这个命令加到信息里给出的镜像或模板中，或者用 `--driver local` 运行这个步骤 |

## 这个版本还不支持

- 步骤的网络规则。`requires.network: false` 会列在 `unenforced` 里，严格要求它的步骤会等待一个声明了它的驱动。步骤能连到这台机器的什么[按提供方而定](#步骤能连到这台机器的什么)；这台机器之外，步骤能连到任何主机，`sbx` 除外，那里由你的网络策略决定。
- 用工具登录的评判。评判用环境变量凭据登录。
- Windows。沙箱把尝试的每个路径挂载到同一路径上，而 `C:\` 路径在 Linux 沙箱里不存在，所以在 Windows 上，每个提供方的 `init` 都以 `sandbox_unavailable` 失败，`teamai-sandbox-<tool>` 以退出码 2 结束。请在 WSL2 里运行 teamai 和使用包装器的应用，或者用 `--driver local` 运行步骤。
