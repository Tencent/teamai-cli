# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它按顺序运行命令步骤和只读提示词步骤。

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    command: npm test
    output:
      ok: boolean
  - id: review
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且必须且只能使用 `command`、`prompt`、`prompt_file` 之一。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

`teamai pull` 和 `teamai push` 分别检查每个文件。`prompt_file` 必须是团队仓库内的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存。

在本地配置中按机器选择无界面工具：

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

有 agent 专用配置时优先于 `default`。支持 `claude`、`codex` 和 `opencode`。CI 可以在单次启动时用 `--tools default=claude,implementer=codex` 覆盖。命名 agent 从 `teamai pull` 已经部署到该工具、该 scope 目录里的文件读取。

```text
teamai workflow start build --driver local
```

`--driver local` 在当前目录里一次运行一个步骤。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。提示词步骤只读；如果工具修改了仓库，步骤会失败，同时保留文件供检查。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 结束时，退出码是 1。不会留下常驻的工作流进程。
