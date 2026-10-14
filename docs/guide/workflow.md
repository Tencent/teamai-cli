# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. This version runs command steps, in order.

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

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and one `command`. `output` is optional. When you set it, a successful command must print one JSON value on stdout. The shorthand is `string`, `number`, `boolean`, a literal union such as `pass | fix`, an object, or an array with one item type. An object matches when every declared field is present and has the right type. Extra fields are allowed.

`teamai pull` and `teamai push` check each file on its own. A problem names the file, the line, and the field. Other workflows and other resources still sync. A file that was valid before keeps that version in the local cache. The invalid text does not run. A file that has never been valid has nothing to run. In single-repo mode, each checkout keeps its own cache.

```text
teamai workflow start build --driver local
```

`--driver local` runs one command at a time in the current directory. It calls the same `next` and `report` operations an external driver uses:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` exits with status 1. No workflow process keeps running.
