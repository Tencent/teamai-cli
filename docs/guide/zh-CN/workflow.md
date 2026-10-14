# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。这一版按顺序运行 command 步骤。

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
```

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且只有一条 `command`。`output` 可选。写了它，成功的命令就必须在 stdout 上打印一个 JSON 值。简写类型是 `string`、`number`、`boolean`、字面量联合（例如 `pass | fix`）、对象，或只含一种元素类型的数组。对象在每个声明字段都存在且类型正确时匹配，允许多余字段。

`teamai pull` 和 `teamai push` 分别检查每个文件。报错会给出文件、行号和字段。其他工作流和其他资源仍会同步。以前校验通过的文件会在本地缓存里保留那一版，无效的内容不会被运行。从未校验通过的文件没有可运行的版本。单仓库模式下，每个检出各自保留一份缓存。

```text
teamai workflow start build --driver local
```

`--driver local` 在当前目录里一次运行一条命令。它调用的 `next` 和 `report` 与外部驱动相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 结束时，退出码是 1。不会留下常驻的工作流进程。
