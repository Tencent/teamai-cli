# Write a step runtime

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A [step runtime](workflow-advanced.md#driver-definitions-and-step-runtimes) runs the steps of a run somewhere teamai does not reach by itself, such as a container, an app or a service of your team. teamai starts it as a program and talks to it on stdin and stdout. The runtimes teamai ships are complete examples of what this page describes: [Sandbox](runtime-sandbox.md), [T3](runtime-t3.md) and [Paseo](runtime-paseo.md).

## Start from the toy

The toy runtime in the teamai repository, `src/__tests__/fixtures/runtime-toy/runtime.mjs`, is the template. It runs each command on the host, keeps its handles and outcomes in a state directory so a restarted teamai can reattach, and with its `agent` option it launches agents its own way, as T3 and Paseo do. Copy it, and replace what it runs.

You write it in the teamai repository, since the modules it uses are not published: bundle them into your runtime's one executable file, as the tests do with the toy (`src/__tests__/helpers/toy-runtime.ts`). The toy also imports `@teamai/tool-core/sessions/fs`, for its `transcript` option; drop it with that option. The protocol's two modules:

| Module | What it gives you |
| --- | --- |
| `@teamai/runtime-protocol` | Every request and reply as a zod schema: `RuntimeRequestSchema` for what teamai sends, `RuntimeMessageSchema` for what you write. Parse each line you read with it. |
| `@teamai/runtime-protocol/step-runtime` | `StepRuntime`, the interface teamai drives every runtime through, yours over stdio included. Its result types, such as `ExecEnd` and `PromptEnd`, say what each of your answers becomes in the run. |

The runtimes teamai ships are built on `@teamai/runtime-kit` instead: its request loop (`serve`) runs only when teamai started it (`TEAMAI_RUNTIME_PROTOCOL=1`), keeps that variable from the processes it starts, and ends each operation once. Use it rather than the toy's own loop, and drop the toy's test options, such as `die_at`, which kills the process that started it.

Put the bundled file in a runtime folder, such as `runtimes/<name>/runtime` in the team repo, beside a `RUNTIME.yaml` with `protocol: 1` and `entry: ./runtime` ([where teamai looks](workflow-advanced.md#driver-definitions-and-step-runtimes)), and name it in a driver definition with `use: <name>`.

A runtime that runs no command, as T3 and Paseo run only prompts, says so in its `RUNTIME.yaml` with `exec: false`, matching the `can.exec: false` of its `init`. A run that needs no AI tool then never starts it, and its commands run on the host. A runtime that says nothing there is started, and so is a team runtime at a revision you have not accepted. A runtime that says `exec: false` while its `init` offers commands fails when it starts, naming the file.

## Test it against the scenario suite

`src/__tests__/step-runtime-scenarios.test.ts` runs the scenarios that `host`, `tools`, the sandbox, T3 and Paseo runtimes and the toy pass, through `StepRuntime` alone: open, exec or prompt, cancel, a teamai killed and restarted, close. A runtime that runs commands goes in `SUBJECTS`, as the toy is there:

```ts
{
  name: 'toy over stdio',
  start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
  options: (state) => ({ state }),
  retains: true,
  journal: (state) => [path.join(state, 'ops')],
},
```

`retains: true` says your runtime keeps outcomes across a restart of its own process. A runtime that launches agents its own way goes in `PROMPT_SUBJECTS`, and in `SUBJECTS` too only when it also runs commands. For tests of your own, `@teamai/runtime-testing/connect` starts your bundled file as teamai does and speaks protocol 1 to it, and `@teamai/runtime-testing/leaks` checks that a test left nothing running.

## The protocol

A runtime reads one JSON request per line on stdin and answers with JSON lines on stdout, protocol `1`.

teamai reads every reply strictly, the `init` reply included: a key it does not know is a reply it cannot read, and the runtime does not start. Protocol `1` has not been released yet, and teamai ships its runtimes with the engine, so a key a runtime adds lands together with the teamai that reads it, and the protocol stays `1`.

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

A tool you cannot run now, such as one that is not signed in, stays out of `can.tools` and goes in `unavailable` beside `can`, with why and what the person does about it. Your runtime still starts, so command steps run. A prompt step on that tool fails `tool_unavailable` with your reason:

```text
← {"type":"init","ok":true,"can":{"tools":["codex"]},"unavailable":{"claude":"claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login."}}
✖ Step "review" failed with tool_unavailable: Step "review" runs on claude, which the driver of this run cannot launch here: sandbox: claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login. Or remove tool from the step.
```

When a later runtime of the definition can run the tool, such as `tools`, the step runs there instead, and the run says so once, with your reason:

```text
⚠ Runtime sandbox of driver teamai-sandbox cannot run claude now, so steps on claude run on runtime tools: sandbox: claude is not signed in in the sandbox. Run sbx run claude <dir>, then /login.
```

A runtime that drives an app with a default tool of its own reports it as `can.default_tool`, one of its `can.tools`. A prompt step that names no tool runs on the first of: the step's `tool:`, `--tools <agent>=`, `workflows.tools.<agent>`, `--tools default=`, the definition's `tool`, the runtime's `can.default_tool`, then your own default: `TEAMAI_AI_TOOL`, `workflows.tools.default`, `ai.tool`. So `--driver t3` with no tool named runs as your T3 does, and `ai.tool` still picks the tool on the `tools` runtime. With none of them set, the step fails `tool_unconfigured`; teamai never falls back to the first tool it finds installed:

```text
← {"type":"init","ok":true,"prompt":true,"can":{"tools":["claude","codex"],"default_tool":"claude"}}
$ TEAMAI_AI_TOOL=codex teamai workflow start review --driver app          # review names no tool: it runs on claude
$ teamai workflow start review --driver app --tools default=codex         # --tools wins: codex
✖ Step "review" failed with tool_unconfigured: This prompt step names no tool, and none is set for it. Name one with the step's tool:, with --tools default=<tool>, or with ai.tool in your teamai config
```

teamai keeps `max_parallel` and `credentials` for itself: it strips them from the options before `init`, so your runtime never sees them and must not check them. `init` names the credentials instead, never their values, so your runtime can offer only the tools it can sign in, such as a `can.confined` judge:

```text
→ {"type":"init","protocol":1,"mode":"unattended","options":{"state":"/var/tmp/toy-state"},"credentials":{"env":["CLAUDE_CODE_OAUTH_TOKEN"],"logins":["codex"]},"homeEnv":{…}}
```

When your runtime's provider keeps its own login for a tool, such as a sandbox signed in to Codex, reply `"ownLogins":["codex"]` beside `can`. teamai then copies none of that login into the attempt's tool home, and sends none of that tool's sign-in variables it found in the member's environment, such as `OPENAI_API_KEY`, nor one the member's own config declares under `workflows.drivers.<name>.runtimes.<runtime>.credentials`. A variable your definition declares still goes.

`init` names the run's checkout too, `"checkout":"/abs/path"`, and teamai starts your runtime in that directory.

`init` also lists the [tool instances](reference.md#team-tools-tools) you may run: your own, and the team's whose command needs no acceptance or was accepted on this machine. Each one's `home.dir` is the absolute path of its home, as teamai resolves it: your value of the instance's own variable when your environment sets it, else the directory under your home. It is absolute in every teamai that speaks protocol 1, so use it as it is: never join it to a home of your own. `init.homeEnv`, which is required, lists, for each tool a step may name, the shipped tools teamai launches and each instance, every variable its command reads its home from: an instance's are the variable of the tool it extends and its own when it names one. When your runtime starts a tool in a home, set each of that tool's variables to that home, and choose none yourself: a tool it lists with none takes no variable. An `init` without `homeEnv` is refused with `runtime_protocol`: otherwise a tool would start at its default home while teamai delivered to another. List in `can.tools` the instances your runtime can serve. On a runtime that execs its tool, teamai then launches the instance's `command`, with every variable `homeEnv` names for it set to the attempt's tool home. A step on an instance names it as the `tool` of its `open`, `"tool":"acme-claude"`, and of its prompt's `lease` for a runtime that launches agents: your runtime maps it, through `init.instances`, to the tool it extends. A step on an instance that no runtime of the definition lists fails `tool_unsupported`:

```text
→ {"type":"init","protocol":1,"mode":"unattended","options":{…},"instances":[{"name":"acme-claude","tool":"claude","command":"acme-claude","home":{"dir":"/home/me/.acme-claude"}}],"homeEnv":{"claude":["CLAUDE_CONFIG_DIR"],"codex":["CODEX_HOME"],"opencode":[],"acme-claude":["CLAUDE_CONFIG_DIR","ACME_CLAUDE_CONFIG_DIR"]}}
← {"type":"init","ok":true,"can":{"tools":["claude","acme-claude"]}}
✖ Step "review" failed with tool_unsupported: Step "review" runs on acme-claude, an instance of claude, which runtime sandbox of driver sandboxed cannot launch. Run it with --driver local.
```

When your runtime lists the instance in `unavailable` instead, with why, every refusal of its step quotes that reason: the step fails `tool_unavailable` with it, and a strict step that no single runtime takes names it beside `tools`, as in `runtime sandbox lacks tools (sandbox: acme-claude runs acme-claude, which is not in the image: …)`.

A runtime whose definition or member config opts a tool into running without permission prompts reports it as `permissions`, beside `can`. teamai never sets that option for you. Outside a sandbox, the run warns once, naming where the option was set and that an unattended run then approves the runtime's own full-access sign-in (T3's), and records its steps' isolation as `none`. A `permissions: unattended` step runs on such a runtime only on a tool it reports there, and still needs `requires: { isolation: sandbox, strict: true }`:

```text
← {"type":"init","ok":true,"can":{"tools":["claude"]},"permissions":{"claude":"full-access"}}
⚠ Runtime t3 of driver t3-vm runs steps in full access on this machine, as drivers/t3-vm.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

The values come in the requests, on `open` and on each `exec` or `prompt` that gets them. A prompt's tool exec gets them, and a command step's exec gets `{}`:

```text
→ {"type":"exec","op":"op-2a7c90e14b3d","handle":"toy-r…-a…","argv":["claude","-p","…"],"env":{"CLAUDE_CONFIG_DIR":"/repo/.teamai/…/tool-home/claude",…},"unset":["GITHUB_TOKEN"],"credentials":{"CLAUDE_CODE_OAUTH_TOKEN":"sk-ant-oat01-…"},"cwd":"/repo"}
```

Set them over the process's environment only, and never write them to disk or to a log. A teamai that restarts sends them again with the operation it resends, so your runtime needs to keep none.

A workflow's `setup` runs in the step's place on your runtime too, before the step: one `exec` of the shell with setup's own keys and `"credentials":{}`, then a `collect`. teamai then checks on the host what setup left, as it does for a step on this machine, so a copy of the place is checked once it is back. The place is opened once for both, and every `open` names the step's `tool`:

```text
→ {"type":"open","op":"op-5d1e…","run":"r…","attempt":"a…","tool":"claude","view":{…},"credentials":{}}
→ {"type":"exec","op":"op-6f20…","handle":"toy-r…-a…","argv":["/bin/sh","-c","npm ci"],"env":{"NPM_TOKEN":"…",…},"unset":[],"credentials":{},"cwd":"/repo/.teamai/workflow-worktrees/…"}
→ {"type":"collect","handle":"toy-r…-a…"}
→ {"type":"exec","op":"op-7a31…","handle":"toy-r…-a…","argv":["claude","-p","…"],…}
```

The other requests are `cancel`, `collect`, `reattach` and `close`, and `wake` for a runtime whose `init` answered `"wake":true`: it starts a fleet member on another machine it reaches with the request's `message`, answers `woken` with `where`, and never follows what it started. A runtime answers a repeated `op` with the same result until `close`. It keeps what an exec printed and how it exited, and a prompt's `finished` event, `resumed` included, so a restarted teamai can read them with `reattach`. A `cancel` of an operation that already ended answers that end again and stops nothing; only `cancel_failed` is replaced (below). teamai logs a warning, with a count, for an end of an operation it no longer waits on. An option it does not take fails `init` with `bad_option` and the key.

Answer `closed` to a `close` of a handle you already closed. Once teamai removes a clone or a team folder of a run, it closes again the last place your runtime closed for that run, so your runtime can see at a `close` that the folder is gone, and remove what it added for it.

In an entry that runs [one runtime through another](workflow-advanced.md#a-runtime-through-another), the inner's `open` carries `outer`, the outer's handle for the same attempt, unchanged, so it can reach the outer. The outer's `open` carries the attempt's tool home in `view.toolHome` and the names the prompt goes without in `unset`; after a restart, the outer's `reattach` carries the prompt's `credentials` (`{}` when it had none) and `unset` again, since it keeps them only in memory.

A runtime that cannot end a place answers `close` with why. teamai then treats what ran there as still running: the attempt keeps its login, and the run's details show the failure under the step as *Not closed*:

```text
→ {"type":"close","handle":"teamai-r7c41d09e-a1d0e9f42"}
← {"event":"close_failed","handle":"teamai-r7c41d09e-a1d0e9f42","failure":{"code":"rm_failed","message":"docker rm teamai-r7c41d09e-a1d0e9f42 failed: the daemon is not running"}}
```

Each `teamai workflow cancel <run>` tries the close again. When the runtime can never confirm it, as for a create its provider refused, check that nothing of the attempt still runs there, then let the attempt go with `teamai workflow cancel <run> --release <attempt>`. teamai tries the stop and the close once more, and sends that close, even after a stop the runtime did not confirm, as `{"type":"close","handle":"…","release":true}`: your runtime forgets the place, whether or not it can end it. What the runtime cannot confirm no longer holds the attempt. teamai writes its login back, frees it, and no longer tries the close. What ran in the place may still be there, whether or not your runtime forgot it:

```text
ℹ Released attempt a1d0e9f42 of run r7c41d09e on step runtime "docker" without its confirmation, as asked. What ran in its place may still be there, since the runtime did not confirm its end: Step runtime "docker" could not close the place of attempt a1d0e9f42, so what ran there may still run (rm_failed): docker rm teamai-r7c41d09e-a1d0e9f42 failed: the daemon is not running
```

A runtime that exits while an exec or prompt runs fails it `runtime_lost`, for the same reason.

teamai opens your runtime in `recover` mode whenever it must stop an attempt, as `workflow cancel` does after the driver was killed. In that mode run no sign-in or tool check, offer nothing, and answer `cancel`, `reattach`, `collect` and `close` from your own journal, so a provider that is down or never answers cannot hold the stop. That process may run beside others of your runtime: one that drives another run, or one that outlived its killed driver while an exec ran. teamai asks about an attempt's place from one of its processes at a time, so keep one journal file per record, written to a temporary path and renamed into place, and let only one process write each record. A runtime that answers `recover` with an error is opened again for new work, and when that fails too, the cancel names both failures:

```text
→ {"type":"init","protocol":1,"mode":"recover","options":{"state":"/var/tmp/toy-state"},"homeEnv":{…}}
← {"type":"init","ok":true,"can":{}}
→ {"type":"reattach","handle":"toy-r…-a…"}
← {"event":"alive","handle":"toy-r…-a…","ops":[{"op":"op-83bfffde9ce3","state":"running"}]}
→ {"type":"cancel","op":"op-83bfffde9ce3"}
```

When you cannot stop an operation, end it `failed` with `cancel_failed` and a message that says what to do, and keep reporting that state on `reattach`. teamai then does not bring the place back or close it. A later `cancel` of the same operation tries the stop again: from the moment you read it, report the operation `running` on `reattach` until that stop is confirmed or fails again, since teamai reads the state it gets next as that cancel's outcome. Use no other code for this: teamai reads any other `failed`, even one that follows a `cancel`, as the operation's end, and brings the place back and closes it:

```text
← {"op":"op-83bfffde9ce3","event":"failed","failure":{"code":"cancel_failed","message":"docker could not stop container teamai-r7c41d09e-a1d0e9f42: the daemon is not running. Start Docker, then run teamai workflow cancel r7c41d09e again."}}
```

teamai opens your runtime in `check` mode when it only asks whether a run could start now, as describe does in an app's session. It sends nothing after that `init`. In that mode sign in to nothing, write nothing, here or in your provider, and start nothing. Answer `ok` with what you can tell you offer, or fail with why a run could not start. When you cannot tell without writing or starting something, fail the `init`. A runtime older than this mode refuses it too, and teamai then offers no start on your runtime:

```text
→ {"type":"init","protocol":1,"mode":"check","options":{"state":"/var/tmp/toy-state"},"homeEnv":{…}}
← {"type":"init","ok":true,"prompt":true,"can":{"exec":false,"env":false}}
```

Answer every request, even one you cannot carry out. A `reattach`, `collect` or `close` you cannot answer, for example because your journal cannot be read or your provider cannot be reached, gets the failure reply for its handle. Never answer `gone` then: the place may still be there.

```text
→ {"type":"reattach","handle":"teamai-r7c41d09e-a1d0e9f42"}
← {"event":"failed","handle":"teamai-r7c41d09e-a1d0e9f42","failure":{"code":"journal_unreadable","message":"/var/lib/acme-runtime/r7c41d09e.json is not valid JSON. Fix or remove it, then run teamai workflow cancel r7c41d09e again."}}
```

An `{"event":"error"}` line names no request, so teamai fails every request still waiting on your runtime with `runtime_unanswered`: an `open` fails, and an `exec` or `prompt` in flight ends `runtime_lost`, since what it started may still run. It does the same to an `init` (10 min when attended), a `reattach` or a `close` that gets no reply within 15 s, and to an `open`, `exec` or `prompt` you do not answer within 15 s, so send `accepted` before any slow work, such as pulling an image or starting an agent. A `cancel` needs no reply of its own: end the operation with its outcome. An `exec` or `prompt` teamai cancels while it waits on it ends `runtime_lost` the same way when you give no outcome within 15 s. A stop after the driver died reads the outcome on `reattach`, for at most 15 s after its `cancel`. The attempt keeps its place, its records and its login:

```text
Step runtime "acme" could not close the place of attempt a1d0e9f42, so what ran there may still run (runtime_unanswered): Step runtime "acme" did not answer close of teamai-r7c41d09e-a1d0e9f42 within 15 s.
```

`display`, on `ready`, on an exec's or prompt's `accepted` or `display` event, and on the `alive` reply to `reattach`, is optional: a `label` of at most 80 characters, a `url` (`https:`, `http:` or an app's own scheme such as `t3:`), and at most 8 string `fields`. The run's details in the dashboard show it under the step. Put no secret and no path in your home in it. teamai drops a display it cannot show, logs why, and runs the step as usual. The latest one given is shown, so a runtime that creates an agent only for the prompt shows the place at `ready`, accepts the prompt at once, and sends the agent's link once the agent exists, as in the example below. A `display` event neither accepts nor ends its operation: it is not the answer teamai waits 15 s for, nor the outcome of a `cancel`.

To tell the person something without answering a request, write a `notice`: a sign-in page to open, a slow image pull, a problem that does not stop the work. Name the `op` or `handle` it is about, when it is about one. teamai shows it as a warning with the credentials your runtime gets masked, and waits for the request's own answer as before. An attended `init` may wait for the person: send the sign-in link in a notice, then answer `init` once they approved it, within 10 min:

```text
← {"event":"notice","message":"Open https://acme.example.test/device and enter the code shown there to sign in."}
← {"event":"notice","op":"op-83bfffde9ce3","message":"Pulling ghcr.io/acme/agent:1 (1.2 GB)."}
```

```text
⚠ Step runtime "acme", operation op-83bfffde9ce3: Pulling ghcr.io/acme/agent:1 (1.2 GB).
```

`open`'s `view` names the paths the place gets at the same absolute path as on this machine: the worktree read-write, its git paths and, for a workflow written as a folder, that folder read-only, the attempt's result directory and tool home, and `runDir`, the run's scratch directory, read-write, so `$TEAMAI_RUN_DIR` works there as it does here.

A step with a `timeout` that fails it, or one in a run or under a step with a `timeout`, gives its `open` a `deadline`, the latest time those limits allow. The step's own timeout stops its work first; teamai cancels an `exec` or `prompt` of the place still running 15 s past the `deadline`, a reconnected one included, fails the `open` when the place is not `ready` by the `deadline`, and waits for a `collect` 15 s past it at most. A step under no time limit, or whose only limit ends the agent's turn (`on_limit: end_turn`), has no `deadline`:

```text
→ {"type":"open","op":"op-5e0d11cb4777","run":"r…","attempt":"a…","deadline":"2026-11-06T15:10:00.000Z","view":{…},"credentials":{}}
```

## A runtime that launches agents its own way

A runtime such as a T3 Code or Paseo one starts an agent from a prompt and learns its session when it ends, instead of running the tool's command line. It says so at `init` with `"prompt": true`. With `"exec": false` in `can` it also takes no command, so command steps and steps with `setup` go to the next runtime of the definition. A runtime with `"exec": false` and no `"prompt": true` can run no step, and teamai refuses it at start:

```yaml
# drivers/threads.yaml
schemaVersion: v1alpha1
name: threads
tool: claude
runtimes:
  - use: threads          # prompt steps, each as an agent thread
  - use: tools            # prompts threads cannot take
```

teamai then sends each prompt step as one `prompt`. `lease.prompt` is the whole prompt, with the agent definition's instructions when the step names one, and the line that says where to write the result. The agent writes `lease.result`; the runtime reads it back and sends it in `finished`, with the tool's session and the tokens it billed:

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

| `lease` field | Meaning |
| --- | --- |
| `step`, `tool` | The step and the tool to start the agent on, one of your `can.tools` |
| `model` | `name` and optional `effort` to launch on: the step's, or else its agent definition's, or else the workflow's `defaults.model`; absent means the tool's default |
| `prompt`, `result` | The whole prompt, and the file the agent writes the result to. Let the agent write in that file's directory without asking, as teamai's own launch does: for Claude, `--allowedTools=Edit(/<result's directory>/**)`. The step leaves there the files archived with its session as its evidence. Change no mode for it |
| `resume` | A session id of the same tool to continue, for a later pass. Say `"resumed":true` in `finished` when the agent continued it. Leave it out, or say `false`, when you started a new session, and teamai does not link the new session to the old one |
| `permissions` | `approval-required`, or `unattended` when your `can.unattended` took such a step |
| `interactive` | `true` when a person works in the step; only a runtime with `can.hitl` gets one |
| `maxTurns` | The agent's turn cap, when your `can.max_turns` offers one |
| `continue` | The conversation of an earlier prompt this one continues, as `handle` and `op`, when your `init` answered `"conversations":true`. Continue it when you still hold it, on the same tool and working directory, and say `"resumed":true`; otherwise start a new one and send one `notice` for this `op` saying why |
| `limits` | The step's token `budget`, lowered to what the run's budget leaves, `timeoutMs` and `idleMs`, to stop the tool at when you run it on a process you start. When you stop it at one, say which in `finished.stopped` (`budget`, `timeout` or `idle`): teamai ends the step at `budget` or `timeout`, and fails it `tool_failed` at `idle`. Ignore what you cannot keep: teamai still checks the budget once the prompt ends |

Two more answers of `init` change what teamai does for your prompts. `"conversations":true` says a prompt's conversation outlives the prompt in its place: teamai then keeps the place open while a later step continues it, and sends that step `continue`. Without it, every prompt starts a new conversation. `"toolHome":true` says you run each tool in the attempt's tool home (`open.view.toolHome`), as a runtime that execs the tool does: teamai seeds that home, copies a login into it and reads the sessions there. Without it, your tool keeps its sessions where the `tools` runtime's does.

`env` holds the attempt's markers, such as `TEAMAI_WORKFLOW_ATTEMPT` and `TEAMAI_RUN_DIR`, and the values of the keys the step `requires.env`. `provided` names those keys. A runtime whose tool keeps env in plain text, such as an agent config it saves, drops them and keeps the markers:

```text
→ {"type":"prompt",…,"env":{"TEAMAI_WORKFLOW_ATTEMPT":"r7a1…/a3f0…","TEAMAI_RUN_DIR":"/home/al/.teamai/projects/acme-web-3f9c/workflows/runs/r7a1…/scratch","NPM_TOKEN":"npm_…"},"provided":["NPM_TOKEN"],…}
```

A prompt that cannot finish ends `failed`. Use `model_unavailable`, `tool_unavailable`, `agent_unavailable`, `tool_failed` or `usage_limited` for what the step should record as is; teamai records any other code as `runtime_failed`, with your code and message in its message. After `cancel`, it ends `cancelled`. `reattach` reports a finished prompt as `{"op":"…","state":"finished","session":{…},"result":{…},"usage":{…}}`, and one still running as `running`; a repeated `prompt` with the same `op` reconnects to its agent and starts no other. teamai keeps the step's `timeout` itself, with `cancel`. It checks a `budget` against `usage` once the prompt ends. When your `can.tokens` offers tokens and you cannot read a prompt's, leave `usage` out and say why in `unmeasured`: the cause and what to do, such as `"unmeasured":{"cause":"teamai cannot read <transcript> because it has no permission to read it.","next":"Let the user teamai runs as read it, then retry the step."}`. A step under no budget succeeds and tells the person the cause; a budgeted step fails `budget_unmeasured` with both. The toy runtime's `agent` option runs it this way.

`open` names the `tool` the attempt's prompt runs, so you can make the place for it, such as a sandbox of that agent; a command step's `open` has none. When the tool hit its usage limit, end the prompt `usage_limited`, naming the tool and the reset time when you know it. Never name the run or the step:

```text
← {"op":"op-83bf2a9d01e4","event":"failed","failure":{"code":"usage_limited","message":"claude hit its usage limit, which resets at 14:00."}}
```

A tool teamai launches itself needs no runtime for this, and what the run does with a step its tool's limit stopped is in [When a tool hits its usage limit](workflow-advanced.md#when-a-tool-hits-its-usage-limit).

A prompt your daemon lost when it restarted ends `daemon_restarted`, which teamai records as `runtime_failed`, ending its message with the command that retries the step: `Then run: teamai workflow retry <run> <step>`. A confined prompt, such as a judge's, records it as `confined_failed`, with the same command. A confined prompt that stops on its tool's usage limit fails `usage_limited`: teamai does not wait for that limit to reset. A step that failed `runtime_lost`, because the runtime could not confirm its stop, gets the command once a later `teamai workflow cancel` confirms it:

```text
ℹ Stopped attempt a3f0… of run r7a1… on step runtime "sandbox" and closed its place. Then run: teamai workflow retry r7a1… review
```

When the tool keeps its sessions in a home of its own rather than its default one, such as a T3 provider instance with its own `CLAUDE_CONFIG_DIR`, say where in `finished.session.home`, an absolute path. teamai records it with the attempt, reads the transcript there to score and publish the step, and the next pass asks you to resume that session by id. Leave `home` out for the tool's default home, as a runtime before it did:

```text
← {"op":"op-83bf2a9d01e4","event":"finished","session":{"tool":"claude","id":"cef86f52-1d0b-4c55-9a40-7e3d3a8b1f02","home":"/Users/al/.claude-work"},"result":{"output":{"verdict":"approve"}}}
```

## A runtime that answers confined prompts

A runtime that can run an agent with one directory as its only readable root says so at `init` with `"confinedPrompt": true`, and lists in `can.confined` the tools it confines, at which level and with what access. Without `confinedPrompt`, teamai drops `can.confined` from its offer, so a [step confined to a directory](workflow.md#a-prompt-confined-to-a-directory), such as a scored pass's judge, never reaches it. The `open` for such a step has no `view`, and its `prompt` carries `confined`:

```text
← {"type":"init","ok":true,"prompt":true,"confinedPrompt":true,"can":{"exec":false,"tools":["claude"],"confined":[{"level":"best-effort","access":"read","tools":["claude"]}]}}
→ {"type":"open","op":"op-6d2e0b91c4a7","run":"r7a1…","attempt":"a9c4…","credentials":{}}
→ {"type":"prompt","op":"op-a3d5c18e02f9","handle":"…","cwd":"/…/runs/r7a1…/evidence","lease":{…},"confined":{"dir":"/…/runs/r7a1…/evidence","level":"best-effort","access":"read","schema":{…}},…}
← {"op":"op-a3d5c18e02f9","event":"finished","session":{…},"result":{"output":{…}},"confined":{"level":"best-effort","access":"read"}}
```

The agent reads `dir`, read-only, and nothing else of the host. `finished` says the level and access the runtime kept, never more than it enforced. A `finished` without `confined` fails the step `runtime_failed`, a level below the one `dir` asks for fails it `confined_failed`, and a reply that is no JSON value fails it `confined_reply_invalid`. The toy runtime's `judge` option answers this way.

`lease.prompt` and `cwd` name the directory exactly as `dir` spells it. A container that mounts `dir` at the same path shows the agent its parents, empty, but with your home, user name and project in their names. To hide them, mount or copy `dir` at a neutral path and replace `dir` in `cwd` and in the prompt:

```text
dir     /home/al/.teamai/projects/acme-web-3f9c/workflows/runs/r7a1…/scratch/a9c4…
mount   /evidence (read-only)
prompt  "Read only the files under /home/al/…/scratch/a9c4…: …"  →  "Read only the files under /evidence: …"
```
