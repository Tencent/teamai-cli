# 编写步骤运行时

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

[步骤运行时](workflow-advanced.md#驱动定义和步骤运行时)在 teamai 自己到不了的地方运行一次运行的步骤，比如容器、应用或团队的某个服务。teamai 把它作为程序启动，通过 stdin 和 stdout 与它通信。teamai 自带的运行时就是本文所述内容的完整例子：[Sandbox](runtime-sandbox.md)、[T3](runtime-t3.md) 和 [Paseo](runtime-paseo.md)。

## 从 toy 开始

teamai 仓库中的 toy 运行时 `src/__tests__/fixtures/runtime-toy/runtime.mjs` 就是模板。它在主机上运行每个命令，把句柄和结果保存在一个状态目录里，让重启后的 teamai 能重新连接；加上 `agent` 选项后，它像 T3 和 Paseo 那样自己启动智能体。复制它，再替换它运行的内容。

你在 teamai 仓库里编写它，因为它用到的模块没有发布：把它们打包进运行时唯一的可执行文件，就像测试对 toy 做的那样（`src/__tests__/helpers/toy-runtime.ts`）。toy 还为它的 `transcript` 选项导入了 `@teamai/tool-core/sessions/fs`；去掉这个选项时一并去掉它。协议的两个模块：

| 模块 | 提供什么 |
| --- | --- |
| `@teamai/runtime-protocol` | 每个请求和回复的 zod schema：teamai 发送的内容用 `RuntimeRequestSchema`，你写出的内容用 `RuntimeMessageSchema`。用它解析读到的每一行。 |
| `@teamai/runtime-protocol/step-runtime` | `StepRuntime`，teamai 驱动每个运行时所用的接口，通过 stdio 连接的你的运行时也一样。它的结果类型，比如 `ExecEnd` 和 `PromptEnd`，说明你的每个回答在运行中变成什么。 |

teamai 自带的运行时则建立在 `@teamai/runtime-kit` 之上：它的请求循环（`serve`）只在 teamai 启动它时运行（`TEAMAI_RUNTIME_PROTOCOL=1`），不把这个变量传给它启动的进程，并让每个操作只结束一次。用它代替 toy 自己的循环，并去掉 toy 的测试选项，比如会杀掉启动它的进程的 `die_at`。

把打包好的文件放进一个运行时文件夹，比如团队仓库中的 `runtimes/<name>/runtime`，旁边放一个写有 `protocol: 1` 和 `entry: ./runtime` 的 `RUNTIME.yaml`（[teamai 在哪里查找](workflow-advanced.md#驱动定义和步骤运行时)），再在驱动定义中用 `use: <name>` 指定它。

不运行命令的运行时（如 T3 和 Paseo 只运行提示）在它的 `RUNTIME.yaml` 中用 `exec: false` 声明，与其 `init` 的 `can.exec: false` 一致。这样，不需要 AI 工具的运行就不会启动它，其命令在本机运行。没有这项声明的运行时照常启动；你尚未接受的版本的团队运行时也照常启动。声明了 `exec: false` 而其 `init` 却提供命令能力的运行时，启动时会失败，并指出该文件。

## 用场景测试套件测试它

`src/__tests__/step-runtime-scenarios.test.ts` 运行 `host`、`tools`、sandbox、T3、Paseo 运行时和 toy 都通过的场景，只经过 `StepRuntime`：open、exec 或 prompt、cancel、teamai 被杀掉后重启、close。运行命令的运行时像 toy 那样加进 `SUBJECTS`：

```ts
{
  name: 'toy over stdio',
  start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
  options: (state) => ({ state }),
  retains: true,
  journal: (state) => [path.join(state, 'ops')],
},
```

`retains: true` 表示你的运行时在自己的进程重启后仍保留结果。自己启动智能体的运行时加进 `PROMPT_SUBJECTS`，只有它也运行命令时才同时加进 `SUBJECTS`。写你自己的测试时，`@teamai/runtime-testing/connect` 像 teamai 那样启动你打包的文件并用协议 1 与它通信，`@teamai/runtime-testing/leaks` 检查测试没有留下任何还在运行的东西。

## 协议

运行时从 stdin 每行读取一个 JSON 请求，在 stdout 上用 JSON 行回答，协议版本 `1`。

teamai 严格读取每个回复，包括 `init` 的回复：它不认识的键会让回复无法读取，运行时也就不会启动。协议 `1` 还没有发布，而 teamai 和引擎一起发布它的运行时，所以运行时新增的键会和读取它的 teamai 一起落地，协议仍然是 `1`。

```text
→ {"type":"init","protocol":1,"mode":"unattended","options":{"state":"/var/tmp/toy-state"},"homeEnv":{…}}
← {"type":"init","ok":true,"can":{"workspace":["read-only","new","continue"],"tools":["claude"],"env":true,"unattended":true}}
→ {"type":"open","op":"op-5e0d11cb4777","run":"r…","attempt":"a…","view":{…},"credentials":{}}
← {"op":"op-5e0d11cb4777","event":"accepted","handle":"toy-r…-a…"}
← {"op":"op-5e0d11cb4777","event":"ready","display":{"label":"toy-r…-a…","url":"https://toy.example.test/places/r…-a…","fields":{"place":"toy-r…-a…"}}}
→ {"type":"exec","op":"op-83bfffde9ce3","handle":"toy-r…-a…","argv":["/bin/sh","-c","npm test"],"env":{…},"unset":[],"credentials":{},"cwd":"/repo"}
← {"op":"op-83bfffde9ce3","event":"accepted"}
← {"op":"op-83bfffde9ce3","event":"output","stream":"stdout","data":"ok\n"}
← {"op":"op-83bfffde9ce3","event":"exited","code":0,"stdout":"ok\n"}
```

现在无法运行的工具（例如还没登录的工具）不要放进 `can.tools`，而是放在 `can` 旁边的 `unavailable` 里，写明原因和用户该做什么。你的运行时仍然会启动，所以命令步骤照常运行。用这个工具的提示步骤会以 `tool_unavailable` 失败，并带上你的原因：

```text
← {"type":"init","ok":true,"can":{"tools":["codex"]},"unavailable":{"claude":"claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login."}}
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login. Or remove tool from the step.
```

定义中后面的运行时（例如 `tools`）能运行这个工具时，步骤改在那里运行，运行会提示一次，并带上你的原因：

```text
⚠ Runtime sandbox of driver teamai-sandbox cannot run claude now, so steps on claude run on runtime tools: sandbox: claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login.
```

驱动某个应用、而该应用有自己默认工具的运行时，用 `can.default_tool` 报告它，取值是它的 `can.tools` 之一。没有指定工具的提示词步骤依次取第一个已设置的：步骤的 `tool:`、`--tools <agent>=`、`workflows.tools.<agent>`、`--tools default=`、定义的 `tool`、运行时的 `can.default_tool`，然后是你自己的默认值：`TEAMAI_AI_TOOL`、`workflows.tools.default`、`ai.tool`。因此不指定工具的 `--driver t3` 会像你的 T3 一样运行，而 `tools` 运行时上仍由 `ai.tool` 选择工具。这些都没有设置时，步骤以 `tool_unconfigured` 失败；teamai 从不退回到它找到的第一个已安装工具：

```text
← {"type":"init","ok":true,"prompt":true,"can":{"tools":["claude","codex"],"default_tool":"claude"}}
$ TEAMAI_AI_TOOL=codex teamai workflow start review --driver app          # review 没有指定工具：在 claude 上运行
$ teamai workflow start review --driver app --tools default=codex         # --tools 优先：codex
✖ Step "review" failed with tool_unconfigured: This prompt step names no tool, and none is set for it. Name one with the step's tool:, with --tools default=<tool>, or with ai.tool in your teamai config
```

`max_parallel` 和 `credentials` 由 teamai 自己使用：它在 `init` 之前把它们从选项里去掉，所以你的运行时永远看不到它们，也不应检查它们。`init` 改为列出凭据的名字，从不带值，这样你的运行时可以只提供它能登录的工具，例如 `can.confined` 评审：

```text
→ {"type":"init","protocol":1,"mode":"unattended","options":{"state":"/var/tmp/toy-state"},"credentials":{"env":["CLAUDE_CODE_OAUTH_TOKEN"],"logins":["codex"]},"homeEnv":{…}}
```

如果你的运行时的提供方自己保存某个工具的登录，比如已登录 Codex 的沙箱，就在 `can` 旁边回复 `"ownLogins":["codex"]`。teamai 就不会把这份登录复制进本次尝试的工具主目录，也不会发送它在成员环境里按名字找到的该工具登录变量，比如 `OPENAI_API_KEY`，或成员自己的配置在 `workflows.drivers.<name>.runtimes.<runtime>.credentials` 下声明的该工具登录变量。驱动定义声明的变量照常发送。

`init` 还会给出运行所在的检出目录 `"checkout":"/abs/path"`，teamai 也在该目录启动你的运行时。

`init` 还会列出你可以运行的[工具实例](reference.md#团队工具tools)：你自己的，以及团队中命令无需确认或已在本机确认过的实例。每个实例的 `home.dir` 是 teamai 解析出的其主目录绝对路径：你的环境设置了实例自己的变量时取其值，否则取你主目录下的该目录。所有使用协议 1 的 teamai 都给出绝对路径，所以直接使用它，不要再把它拼接到你自己的主目录下。`init.homeEnv` 是必需字段，为步骤可能指定的每个工具（teamai 启动的内置工具和每个实例）列出其命令读取主目录的每个变量：实例的变量是它扩展的工具的变量，以及实例自己命名的变量。你的运行时在某个主目录中启动某个工具时，把该工具的这些变量都设为那个主目录，不要自己另选变量：列出但没有变量的工具不设任何变量。缺少 `homeEnv` 的 `init` 会以 `runtime_protocol` 被拒绝：否则工具会在默认主目录启动，而 teamai 已投放到另一个主目录。在 `can.tools` 中列出你的运行时能提供的实例。在自行 exec 工具的运行时上，teamai 会启动实例的 `command`，并把 `homeEnv` 为它列出的每个变量都设为该次尝试的工具主目录。在实例上运行的步骤会把实例名作为 `open` 的 `tool`，即 `"tool":"acme-claude"`，对自行启动 agent 的运行时也作为提示 `lease` 的 `tool`：你的运行时通过 `init.instances` 把它对应到它扩展的工具。没有任何运行时列出该实例时，在其上运行的步骤以 `tool_unsupported` 失败：

```text
→ {"type":"init","protocol":1,"mode":"unattended","options":{…},"instances":[{"name":"acme-claude","tool":"claude","command":"acme-claude","home":{"dir":"/home/me/.acme-claude"}}],"homeEnv":{"claude":["CLAUDE_CONFIG_DIR"],"codex":["CODEX_HOME"],"opencode":[],"acme-claude":["CLAUDE_CONFIG_DIR","ACME_CLAUDE_CONFIG_DIR"]}}
← {"type":"init","ok":true,"can":{"tools":["claude","acme-claude"]}}
✖ Step "review" failed with tool_unsupported: Step "review" runs on acme-claude, an instance of claude, which runtime sandbox of driver sandboxed cannot launch. Run it with --driver local.
```

如果你的运行时改为把这个实例列在 `unavailable` 里并说明原因，这个步骤的每一种拒绝都会引用这个原因：步骤以 `tool_unavailable` 失败并带上它；没有单个运行时能接手的严格步骤会在 `tools` 旁边写出它，例如 `runtime sandbox lacks tools (sandbox: acme-claude runs acme-claude, which is not in the image: …)`。

当运行时的定义或成员配置让某个工具在不弹出权限提示的情况下运行时，运行时会在 `can` 旁边以 `permissions` 报告。teamai 从不替你设置这个选项。在沙箱之外，运行会提示一次，说明这个选项是在哪里设置的，以及无人值守的运行随后会自己批准该运行时的完全访问登录（T3 的登录），并把其步骤的隔离记录为 `none`。`permissions: unattended` 的步骤只在该运行时报告的工具上运行，并且仍然需要 `requires: { isolation: sandbox, strict: true }`：

```text
← {"type":"init","ok":true,"can":{"tools":["claude"]},"permissions":{"claude":"full-access"}}
⚠ Runtime t3 of driver t3-vm runs steps in full access on this machine, as drivers/t3-vm.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

值随请求发送：在 `open` 上，以及在每个需要它们的 `exec` 或 `prompt` 上。提示的工具 exec 会得到它们，命令步骤的 exec 得到 `{}`：

```text
→ {"type":"exec","op":"op-2a7c90e14b3d","handle":"toy-r…-a…","argv":["claude","-p","…"],"env":{"CLAUDE_CONFIG_DIR":"/repo/.teamai/…/tool-home/claude",…},"unset":["GITHUB_TOKEN"],"credentials":{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-…"},"cwd":"/repo"}
```

只把它们设置到进程的环境里，永远不要写到磁盘或日志里。重启后的 teamai 会随它重新发送的操作再次发送它们，所以你的运行时什么都不用保存。

工作流的 `setup` 也在你的运行时上、步骤的位置里运行，先于步骤：一次 shell 的 `exec`，只带 setup 自己的键和 `"credentials":{}`，然后一次 `collect`。之后 teamai 在宿主机上检查 setup 留下的内容，和本机上的步骤一样，所以位置的副本会在取回后被检查。两者只打开一次位置，并且每次 `open` 都带上步骤的 `tool`：

```text
→ {"type":"open","op":"op-5d1e…","run":"r…","attempt":"a…","tool":"claude","view":{…},"credentials":{}}
→ {"type":"exec","op":"op-6f20…","handle":"toy-r…-a…","argv":["/bin/sh","-c","npm ci"],"env":{"NPM_TOKEN":"…",…},"unset":[],"credentials":{},"cwd":"/repo/.teamai/workflow-worktrees/…"}
→ {"type":"collect","handle":"toy-r…-a…"}
→ {"type":"exec","op":"op-7a31…","handle":"toy-r…-a…","argv":["claude","-p","…"],…}
```

其他请求是 `cancel`、`collect`、`reattach` 和 `close`；`init` 回答了 `"wake":true` 的运行时还会收到 `wake`：它用请求的 `message` 在它能到达的另一台机器上启动一个 fleet 成员，以带 `where` 的 `woken` 回答，之后不再跟踪它启动的东西。在 `close` 之前，运行时对重复的 `op` 给出同样的结果。它保存 exec 打印的内容和退出方式，以及 prompt 的 `finished` 事件（包括 `resumed`），这样重启后的 teamai 可以用 `reattach` 读取。对已经结束的操作发出的 `cancel`，再次给出那个结束结果，不停止任何东西；只有 `cancel_failed` 会被替换（见下文）。teamai 收到它已不再等待的操作的结束结果时，会记录一条带计数的警告。运行时不接受的选项会让 `init` 失败为 `bad_option`，并给出那个键。

对已经关闭过的句柄再次发来的 `close`，回答 `closed`。teamai 删除某次运行的克隆或团队目录后，会再关闭一次你的运行时为这次运行最后关闭的位置，这样你的运行时能在 `close` 时看到那个目录已经不在，并删除它为该目录添加的东西。

在[通过另一个运行时运行](workflow-advanced.md#通过另一个运行时运行)的条目中，内层的 `open` 带有 `outer`，即同一次尝试中外层的句柄，原样传递，让内层能连到外层。外层的 `open` 在 `view.toolHome` 中带上这次尝试的工具主目录，并在 `unset` 中带上提示不能拿到的变量名；重启之后，外层的 `reattach` 会再次带上提示的 `credentials`（没有时为 `{}`）和 `unset`，因为外层只把它们保存在内存里。

无法结束某个位置的运行时，用原因回答 `close`。teamai 随后把在那里运行的东西视为仍在运行：这次尝试继续持有登录，运行详情在步骤下以 *未关闭* 显示这个失败：

```text
→ {"type":"close","handle":"teamai-r7c41d09e-a1d0e9f42"}
← {"event":"close_failed","handle":"teamai-r7c41d09e-a1d0e9f42","failure":{"code":"rm_failed","message":"docker rm teamai-r7c41d09e-a1d0e9f42 failed: the daemon is not running"}}
```

每次 `teamai workflow cancel <run>` 都会再试一次 close。如果运行时永远无法确认它，例如提供方拒绝了一次创建，请先确认这次尝试已没有任何东西还在那里运行，再用 `teamai workflow cancel <run> --release <attempt>` 放开这次尝试。teamai 会再试一次停止和 close，并把这次 close（即使运行时没有确认停止）作为 `{"type":"close","handle":"…","release":true}` 发出：无论能否结束这个位置，你的运行时都要忘掉它。运行时无法确认的部分不再卡住这次尝试。teamai 把它的登录写回并释放，之后不再尝试 close。无论你的运行时是否已经忘掉这个位置，在那里运行过的东西都可能还在：

```text
ℹ Released attempt a1d0e9f42 of run r7c41d09e on step runtime "docker" without its confirmation, as asked. What ran in its place may still be there, since the runtime did not confirm its end: Step runtime "docker" could not close the place of attempt a1d0e9f42, so what ran there may still run (rm_failed): docker rm teamai-r7c41d09e-a1d0e9f42 failed: the daemon is not running
```

exec 或提示运行期间退出的运行时，出于同样的原因会让它失败为 `runtime_lost`。

每当 teamai 必须停止一次尝试时（例如驱动被杀掉后的 `workflow cancel`），它都会以 `recover` 模式打开你的运行时。在这种模式下，不做登录或工具检查，什么都不提供，只根据你自己的日志回答 `cancel`、`reattach`、`collect` 和 `close`，这样宕机或一直不回答的提供方就不会卡住停止。这个进程可能与你的运行时的其他进程同时运行：驱动另一次运行的进程，或在 exec 运行时比被杀掉的驱动活得更久的进程。teamai 同一时间只从它的一个进程询问一次尝试的位置，所以请每条记录保存一个日志文件，先写到临时路径再重命名到位，并且每条记录只让一个进程写。用错误回答 `recover` 的运行时会再为新工作打开一次；如果这也失败，cancel 会同时给出两个失败：

```text
→ {"type":"init","protocol":1,"mode":"recover","options":{"state":"/var/tmp/toy-state"},"homeEnv":{…}}
← {"type":"init","ok":true,"can":{}}
→ {"type":"reattach","handle":"toy-r…-a…"}
← {"event":"alive","handle":"toy-r…-a…","ops":[{"op":"op-83bfffde9ce3","state":"running"}]}
→ {"type":"cancel","op":"op-83bfffde9ce3"}
```

无法停止某个操作时，让它以 `cancel_failed` 结束为 `failed`，消息里说明怎么处理，并在 `reattach` 时继续报告这个状态。teamai 随后不会取回这个位置，也不会关闭它。之后对同一个操作的 `cancel` 会再试一次停止：从读到它的那一刻起，在 `reattach` 时把这个操作报告为 `running`，直到这次停止被确认或再次失败，因为 teamai 会把接下来拿到的状态当作这次 cancel 的结果。不要为此使用别的代码：任何其他 `failed`，即使紧跟在 `cancel` 之后，teamai 都当作这个操作已经结束，会取回并关闭这个位置：

```text
← {"op":"op-83bfffde9ce3","event":"failed","failure":{"code":"cancel_failed","message":"docker could not stop container teamai-r7c41d09e-a1d0e9f42: the daemon is not running. Start Docker, then run teamai workflow cancel r7c41d09e again."}}
```

当 teamai 只想知道现在能否启动运行时（例如 describe 在应用会话中所做的），它会以 `check` 模式打开你的运行时，在这个 `init` 之后不再发送任何请求。在这种模式下，不登录任何东西，不写任何东西（无论在本机还是在你的提供方），也不启动任何东西。用 `ok` 回答你能确定自己提供的内容，或者失败并说明为什么不能启动运行。如果不写入或启动某些东西就无法确定，就让 `init` 失败。早于这个模式的运行时同样会拒绝它，teamai 随后不会在你的运行时上提供启动：

```text
→ {"type":"init","protocol":1,"mode":"check","options":{"state":"/var/tmp/toy-state"},"homeEnv":{…}}
← {"type":"init","ok":true,"prompt":true,"can":{"exec":false,"env":false}}
```

每个请求都要回答，包括你做不到的请求。无法回答的 `reattach`、`collect` 或 `close`（例如读不了自己的日志，或连不上提供方）要给出这个句柄的失败回复。这时不要回答 `gone`：位置可能还在。

```text
→ {"type":"reattach","handle":"teamai-r7c41d09e-a1d0e9f42"}
← {"event":"failed","handle":"teamai-r7c41d09e-a1d0e9f42","failure":{"code":"journal_unreadable","message":"/var/lib/acme-runtime/r7c41d09e.json is not valid JSON. Fix or remove it, then run teamai workflow cancel r7c41d09e again."}}
```

`{"event":"error"}` 这一行不指向任何请求，所以 teamai 会让所有仍在等待你的运行时的请求失败为 `runtime_unanswered`：`open` 失败，正在进行的 `exec` 或 `prompt` 以 `runtime_lost` 结束，因为它启动的东西可能还在运行。15 秒内没有收到回复的 `init`（有人值守时为 10 分钟）、`reattach` 或 `close`，以及 15 秒内你没有回答的 `open`、`exec` 或 `prompt` 也一样，所以要在任何耗时的工作（例如拉取镜像或启动智能体）之前先发送 `accepted`。`cancel` 本身不需要回复：用操作的结果结束它即可。teamai 在等待某个 `exec` 或 `prompt` 时取消了它，如果 15 秒内你没有给出结果，它也会同样以 `runtime_lost` 结束。驱动退出后的停止通过 `reattach` 读取结果，从发出 `cancel` 起最多等 15 秒。这次尝试保留它的位置、记录和登录：

```text
Step runtime "acme" could not close the place of attempt a1d0e9f42, so what ran there may still run (runtime_unanswered): Step runtime "acme" did not answer close of teamai-r7c41d09e-a1d0e9f42 within 15 s.
```

`ready`、exec 或 prompt 的 `accepted` 或 `display` 事件，以及 `reattach` 的 `alive` 回复可以带上 `display`，它是可选的：`label` 最多 80 个字符，`url`（`https:`、`http:` 或应用自己的协议，例如 `t3:`），以及最多 8 个字符串 `fields`。仪表盘的运行详情会把它显示在步骤下面。不要在里面放密钥或你主目录下的路径。teamai 无法显示的 display 会被丢弃并记录原因，步骤照常运行。显示的是最近给出的那个，所以只为 prompt 创建智能体的运行时，在 `ready` 时显示位置，立即接受 prompt，等智能体创建好后再发送它的链接，如下面的例子所示。`display` 事件既不接受也不结束它的操作：它不算 teamai 等待 15 秒的那个回答，也不算 `cancel` 的结果。

要在不回答请求的情况下告诉用户一件事，就写一条 `notice`：一个要打开的登录页面、一次很慢的镜像拉取，或一个不影响工作继续的问题。它涉及某个操作或位置时，写上 `op` 或 `handle`。teamai 把它作为警告显示，并遮蔽你的运行时拿到的凭据，然后照常等待该请求自己的回答。有人值守的 `init` 可以等待用户：先在 notice 里发送登录链接，等用户批准后再回答 `init`，期限是 10 分钟：

```text
← {"event":"notice","message":"Open https://acme.example.test/device and enter the code shown there to sign in."}
← {"event":"notice","op":"op-83bfffde9ce3","message":"Pulling ghcr.io/acme/agent:1 (1.2 GB)."}
```

```text
⚠ Step runtime "acme", operation op-83bfffde9ce3: Pulling ghcr.io/acme/agent:1 (1.2 GB).
```

`open` 的 `view` 列出地点按与本机相同的绝对路径拿到的路径：可读写的工作树、只读的 git 路径（工作流写成文件夹时还有该文件夹，也是只读）、attempt 的结果目录和工具主目录，以及可读写的 `runDir`，即运行的临时目录，所以 `$TEAMAI_RUN_DIR` 在那里和在本机一样可用。

`timeout` 会让步骤失败的步骤，或者所在的运行或外层步骤有 `timeout` 的步骤，会让它的 `open` 带上 `deadline`，即这些限制允许的最晚时间。步骤自己的超时会先停止它的工作；在 `deadline` 之后 15 秒仍在运行的该位置的 `exec` 或 `prompt`（包括重新连上的）会被 teamai 取消；到 `deadline` 时位置还没 `ready`，`open` 失败；`collect` 最多等到它之后 15 秒。不受任何时间限制的步骤，或者唯一的限制只结束 agent 这一轮的步骤（`on_limit: end_turn`），没有 `deadline`：

```text
→ {"type":"open","op":"op-5e0d11cb4777","run":"r…","attempt":"a…","deadline":"2026-11-06T15:10:00.000Z","view":{…},"credentials":{}}
```

## 自己启动智能体的运行时

T3 Code 或 Paseo 这类运行时从一个提示启动智能体，在它结束时得到会话，而不是运行工具的命令行。它在 `init` 时用 `"prompt": true` 说明这一点。如果 `can` 里还有 `"exec": false`，它就不接受命令，所以命令步骤和带 `setup` 的步骤会交给定义中的下一个运行时。带 `"exec": false` 却没有 `"prompt": true` 的运行时运行不了任何步骤，teamai 在启动时拒绝它：

```yaml
# drivers/threads.yaml
schemaVersion: v1alpha1
name: threads
tool: claude
runtimes:
  - use: threads          # 提示步骤，每个都作为一个智能体线程
  - use: tools            # threads 接不了的提示
```

teamai 随后把每个提示步骤作为一次 `prompt` 发送。`lease.prompt` 是完整的提示：步骤指定了智能体定义时包含它的说明，还有告诉智能体把结果写到哪里的那一行。智能体写入 `lease.result`，运行时把它读回来，在 `finished` 中连同工具的会话和计费的 token 一起发送：

```text
→ {"type":"init","protocol":1,"mode":"attended","options":{},"homeEnv":{…}}
← {"type":"init","ok":true,"prompt":true,"can":{"exec":false,"hitl":true,"workspace":["read-only","new","continue"],"tools":["claude","codex"]}}
→ {"type":"open","op":"op-1c9e0f4a2b77","run":"r7a1…","attempt":"a3f0…","tool":"claude","view":{"worktree":"/repo/.teamai/workflow-worktrees/r7a1-review-p1",…},"credentials":{}}
← {"op":"op-1c9e0f4a2b77","event":"accepted","handle":"threads-r7a1-a3f0"}
← {"op":"op-1c9e0f4a2b77","event":"ready","display":{"label":"review (thread)","url":"t3://thread/5e1c"}}
→ {"type":"prompt","op":"op-83bf2a9d01e4","handle":"threads-r7a1-a3f0","cwd":"/repo/.teamai/workflow-worktrees/r7a1-review-p1","env":{"TEAMAI_WORKFLOW_ATTEMPT":"r7a1…/a3f0…",…},"unset":[],
   "lease":{"step":"review","tool":"claude","model":{"name":"claude-opus-5-5"},"permissions":"approval-required","interactive":false,
            "prompt":"Review the change.\n\nWrite the workflow result as JSON to /repo/.teamai/…/attempts/a3f0…/out/result.json. …",
            "result":"/repo/.teamai/…/attempts/a3f0…/out/result.json"}}
← {"op":"op-83bf2a9d01e4","event":"accepted"}
← {"op":"op-83bf2a9d01e4","event":"display","display":{"label":"Review the change","url":"t3://thread/5e1c","fields":{"agent":"claude"}}}
← {"op":"op-83bf2a9d01e4","event":"finished","session":{"tool":"claude","id":"cef86f52-1d0b-4c55-9a40-7e3d3a8b1f02"},"result":{"output":{"verdict":"approve"}},"usage":{"input":18240,"output":2310}}
```

| `lease` 字段 | 含义 |
| --- | --- |
| `step`、`tool` | 步骤，以及启动智能体用的工具，它是你的 `can.tools` 之一 |
| `model` | 启动时使用的 `name` 和可选的 `effort`：步骤的，否则是它的智能体定义的，再否则是工作流的 `defaults.model`；没有时用工具的默认值 |
| `prompt`、`result` | 完整的提示，以及智能体写入结果的文件。像 teamai 自己的启动那样，让智能体无需询问就能在该文件所在目录里写入：对 Claude 是 `--allowedTools=Edit(/<结果文件所在目录>/**)`。步骤在那里留下随会话归档的证据文件。不要为此改变任何模式 |
| `resume` | 同一个工具中要继续的会话 id，用于之后的轮次。智能体继续了它时，在 `finished` 里写 `"resumed":true`。你开了新会话时不写或写 `false`，teamai 就不会把新会话连到旧会话上 |
| `permissions` | `approval-required`；你的 `can.unattended` 接下这类步骤时为 `unattended` |
| `interactive` | 有人在步骤中工作时为 `true`；只有声明了 `can.hitl` 的运行时会收到 |
| `maxTurns` | 智能体的轮数上限，在你的 `can.max_turns` 提供时才有 |
| `continue` | 这个提示所延续的先前提示的对话，以 `handle` 和 `op` 给出，在你的 `init` 回答了 `"conversations":true` 时才有。你仍然持有它、且工具和工作目录相同时延续它，并回答 `"resumed":true`；否则开始新的对话，并为这个 `op` 发一条 `notice` 说明原因 |
| `limits` | 步骤的 token `budget`（已降到运行的预算还剩的额度）、`timeoutMs` 和 `idleMs`，在你自己启动的进程上运行工具时据此停下它。在其中一个上停下它时，在 `finished.stopped` 里说明是哪一个（`budget`、`timeout` 或 `idle`）：teamai 在 `budget` 或 `timeout` 时结束步骤，在 `idle` 时让它失败为 `tool_failed`。做不到的就忽略：提示结束后 teamai 仍会检查预算 |

`init` 的另外两个回答会改变 teamai 对你的提示所做的事。`"conversations":true` 表示提示的对话在它的位置里比提示本身活得更久：之后的步骤延续它时，teamai 会让这个位置保持打开，并给那个步骤发送 `continue`。没有它时，每个提示都开始新的对话。`"toolHome":true` 表示你在这次尝试的工具主目录（`open.view.toolHome`）里运行每个工具，就像执行工具命令的运行时那样：teamai 准备这个目录、把登录复制进去，并从那里读取会话。没有它时，你的工具把会话保存在 `tools` 运行时保存的位置。

`env` 包含尝试的标记，例如 `TEAMAI_WORKFLOW_ATTEMPT` 和 `TEAMAI_RUN_DIR`，以及步骤 `requires.env` 的键的值。`provided` 列出这些键。如果你的运行时的工具以明文保存 env，例如它保存的智能体配置，就丢掉这些键，保留标记：

```text
→ {"type":"prompt",…,"env":{"TEAMAI_WORKFLOW_ATTEMPT":"r7a1…/a3f0…","TEAMAI_RUN_DIR":"/home/al/.teamai/projects/acme-web-3f9c/workflows/runs/r7a1…/scratch","NPM_TOKEN":"npm_…"},"provided":["NPM_TOKEN"],…}
```

无法完成的提示以 `failed` 结束。希望步骤原样记录的原因，用 `model_unavailable`、`tool_unavailable`、`agent_unavailable`、`tool_failed` 或 `usage_limited`；其他代码 teamai 都记录为 `runtime_failed`，并在消息中带上你的代码和消息。收到 `cancel` 后，它以 `cancelled` 结束。`reattach` 把结束的提示报告为 `{"op":"…","state":"finished","session":{…},"result":{…},"usage":{…}}`，仍在运行的报告为 `running`；用同一个 `op` 再次发送 `prompt` 会重新连上它的智能体，不会再启动一个。步骤的 `timeout` 由 teamai 自己用 `cancel` 执行。`budget` 在提示结束后按 `usage` 检查。你的 `can.tokens` 提供 token 数、却读不到某个提示的 token 数时，省略 `usage`，在 `unmeasured` 里写明原因和下一步，例如 `"unmeasured":{"cause":"teamai cannot read <transcript> because it has no permission to read it.","next":"Let the user teamai runs as read it, then retry the step."}`。没有预算的步骤照常成功，并把原因告诉用户；有预算的步骤以 `budget_unmeasured` 失败，消息里带上两者。玩具运行时的 `agent` 选项就是这样运行的。

`open` 会写明 attempt 的提示运行的 `tool`，这样你可以为它准备位置，例如那个智能体的沙箱；命令步骤的 `open` 没有它。工具用完使用额度时，用 `usage_limited` 结束提示，写明工具，知道重置时间时也写上。不要写运行或步骤：

```text
← {"op":"op-83bf2a9d01e4","event":"failed","failure":{"code":"usage_limited","message":"claude hit its usage limit, which resets at 14:00."}}
```

teamai 自己启动的工具不需要运行时做这件事。工具的上限让步骤停下后，运行怎么处理它，见 [工具达到用量上限时](workflow-advanced.md#工具达到用量上限时)。

守护进程重启时丢失的提示以 `daemon_restarted` 结束，teamai 把它记录为 `runtime_failed`，消息末尾带上重试该步骤的命令：`Then run: teamai workflow retry <run> <step>`。受限提示（例如评审的提示）把它记录为 `confined_failed`，同样带上这条命令。受限提示因工具的用量上限而停止时，以 `usage_limited` 失败：teamai 不会等待该上限重置。因运行时无法确认停止而以 `runtime_lost` 失败的步骤，会在之后的 `teamai workflow cancel` 确认停止时拿到这条命令：

```text
ℹ Stopped attempt a3f0… of run r7a1… on step runtime "sandbox" and closed its place. Then run: teamai workflow retry r7a1… review
```

工具把会话放在自己的主目录而不是默认主目录时，例如有自己 `CLAUDE_CONFIG_DIR` 的 T3 提供方实例，在 `finished.session.home` 里用绝对路径说明位置。teamai 把它和 attempt 一起记录，在那里读取记录来评分和发布这个步骤，下一轮会请你按 id 恢复该会话。如果是工具的默认主目录，就不写 `home`，和之前的运行时一样：

```text
← {"op":"op-83bf2a9d01e4","event":"finished","session":{"tool":"claude","id":"cef86f52-1d0b-4c55-9a40-7e3d3a8b1f02","home":"/Users/al/.claude-work"},"result":{"output":{"verdict":"approve"}}}
```

## 回答限定提示的运行时

能让智能体只读一个目录、别的都读不到的运行时，在 `init` 时用 `"confinedPrompt": true` 说明，并在 `can.confined` 里列出它限定运行的工具、级别和权限。没有 `confinedPrompt` 时，teamai 会从它的提供里去掉 `can.confined`，所以[限定在一个目录里的步骤](workflow.md#限定在一个目录里的提示步骤)（例如打分 pass 的评判）永远不会交给它。这种步骤的 `open` 没有 `view`，它的 `prompt` 带 `confined`：

```text
← {"type":"init","ok":true,"prompt":true,"confinedPrompt":true,"can":{"exec":false,"tools":["claude"],"confined":[{"level":"best-effort","access":"read","tools":["claude"]}]}}
→ {"type":"open","op":"op-6d2e0b91c4a7","run":"r7a1…","attempt":"a9c4…","credentials":{}}
→ {"type":"prompt","op":"op-a3d5c18e02f9","handle":"…","cwd":"/…/runs/r7a1…/evidence","lease":{…},"confined":{"dir":"/…/runs/r7a1…/evidence","level":"best-effort","access":"read","schema":{…}},…}
← {"op":"op-a3d5c18e02f9","event":"finished","session":{…},"result":{"output":{…}},"confined":{"level":"best-effort","access":"read"}}
```

智能体只读 `dir`，读不到宿主上的其他内容。`finished` 说明运行时实际保持的级别和权限，不能高于它真正执行的。没有 `confined` 的 `finished` 让步骤失败为 `runtime_failed`，级别低于 `dir` 要求的失败为 `confined_failed`，回复不是 JSON 值的失败为 `confined_reply_invalid`。toy 运行时的 `judge` 选项按这种方式回答。

`lease.prompt` 和 `cwd` 对目录的写法与 `dir` 完全相同。容器如果把 `dir` 挂载在同一路径，智能体会看到它的上级目录：它们是空的，但名字里有你的主目录、用户名和项目。要隐藏它们，就把 `dir` 挂载或复制到一个中性路径，并在 `cwd` 和提示里把 `dir` 替换掉：

```text
dir     /home/al/.teamai/projects/acme-web-3f9c/workflows/runs/r7a1…/scratch/a9c4…
mount   /evidence (read-only)
prompt  "Read only the files under /home/al/…/scratch/a9c4…: …"  →  "Read only the files under /evidence: …"
```
