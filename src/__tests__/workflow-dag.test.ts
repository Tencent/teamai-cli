import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { readRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];

function testConfig(): { config: LocalConfig; work: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-dag-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return {
    work,
    config: {
      repo: { localPath: knowledge, remote: 'local', kind: 'self' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: root,
      dataHome: path.join(root, 'data'),
    },
  };
}

const driver: DriverIdentity = { kind: 'local', machine: 'host', workspace: '/work' };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow DAG conditions and sub-workflows', () => {
  it('implements diamond join where step runs unless all dependencies were skipped', async () => {
    const fixture = testConfig();
    const yaml = `schemaVersion: v1alpha1
name: diamond
description: Diamond dependency join test.
steps:
  - id: start
    command: echo start
  - id: left
    needs: [start]
    if: false
    command: echo left
  - id: right
    needs: [start]
    if: true
    command: echo right
  - id: join
    needs: [left, right]
    command: echo join
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'diamond.yaml'), yaml);
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'diamond');
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    // 1. Lease start
    const first = await leaseNext(fixture.config, runId, driver);
    if ('error' in first) throw new Error(first.error.message);
    expect(first).toMatchObject({ data: { lease: { step: 'start' } } });
    await reportAttempt(fixture.config, runId, {
      attempt: String((first.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'success',
      driver,
    });

    // 2. Next lease: left has if: false, so it is skipped. right has if: true, so right is leased!
    const second = await leaseNext(fixture.config, runId, driver);
    if ('error' in second) throw new Error(second.error.message);
    expect(second).toMatchObject({ data: { lease: { step: 'right' } } });
    await reportAttempt(fixture.config, runId, {
      attempt: String((second.data.lease as { attempt: string }).attempt),
      revision: 2,
      outcome: 'success',
      driver,
    });

    // 3. Next lease: join has deps [left, right]. left is skipped, right is succeeded.
    // By the join rule, join is NOT skipped because not every dependency was skipped.
    const third = await leaseNext(fixture.config, runId, driver);
    if ('error' in third) throw new Error(third.error.message);
    expect(third).toMatchObject({ data: { lease: { step: 'join' } } });
    await reportAttempt(fixture.config, runId, {
      attempt: String((third.data.lease as { attempt: string }).attempt),
      revision: 3,
      outcome: 'success',
      driver,
    });

    // 4. Workflow finishes successfully
    const done = await leaseNext(fixture.config, runId, driver);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const state = await readRun(fixture.config, runId);
    expect(state).toMatchObject({
      status: 'succeeded',
      steps: [
        { id: 'start', status: 'succeeded' },
        { id: 'left', status: 'skipped', outcome: 'skipped' },
        { id: 'right', status: 'succeeded' },
        { id: 'join', status: 'succeeded' },
      ],
    });
  });

  it('skips a join step when every dependency was skipped', async () => {
    const fixture = testConfig();
    const yaml = `schemaVersion: v1alpha1
name: all_skipped
description: Diamond join where all deps skipped.
steps:
  - id: start
    if: false
    command: echo start
  - id: left
    needs: [start]
    command: echo left
  - id: right
    needs: [start]
    command: echo right
  - id: join
    needs: [left, right]
    command: echo join
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'all_skipped.yaml'), yaml);
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'all_skipped');
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    // Everything cascades into skipped because start has if: false
    const done = await leaseNext(fixture.config, runId, driver);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const state = await readRun(fixture.config, runId);
    expect(state).toMatchObject({
      status: 'succeeded',
      steps: [
        { id: 'start', status: 'skipped' },
        { id: 'left', status: 'skipped' },
        { id: 'right', status: 'skipped' },
        { id: 'join', status: 'skipped' },
      ],
    });
  });

  it('permits a recovery branch reading a failed dependency', async () => {
    const fixture = testConfig();
    const yaml = `schemaVersion: v1alpha1
name: recovery
description: Recovery branch after failure.
ends:
  - id: recovered
    status: succeeded
steps:
  - id: build
    command: exit 1
  - id: normal_followup
    needs: [build]
    command: echo should not run
  - id: handle_error
    needs: [build]
    if: steps.build.outcome == 'failed'
    command: echo recovered
    end: recovered
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'recovery.yaml'), yaml);
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'recovery');
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    // 1. Lease build
    const first = await leaseNext(fixture.config, runId, driver);
    if ('error' in first) throw new Error(first.error.message);
    expect(first).toMatchObject({ data: { lease: { step: 'build' } } });
    await reportAttempt(fixture.config, runId, {
      attempt: String((first.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'failed',
      driver,
      exitCode: 1,
    });

    // 2. Next lease: normal_followup is skipped (build failed, no if), handle_error is leased!
    const second = await leaseNext(fixture.config, runId, driver);
    if ('error' in second) throw new Error(second.error.message);
    expect(second).toMatchObject({ data: { lease: { step: 'handle_error' } } });
    await reportAttempt(fixture.config, runId, {
      attempt: String((second.data.lease as { attempt: string }).attempt),
      revision: 2,
      outcome: 'success',
      driver,
      exitCode: 0,
    });

    // 3. Workflow settles with recovered end
    const done = await leaseNext(fixture.config, runId, driver);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const state = await readRun(fixture.config, runId);
    expect(state).toMatchObject({
      status: 'succeeded',
      settledEnd: 'recovered',
      steps: [
        { id: 'build', status: 'failed' },
        { id: 'normal_followup', status: 'skipped' },
        { id: 'handle_error', status: 'succeeded', end: 'recovered' },
      ],
    });
  });

  it('passes command inputs only through declared env mappings and prevents shell injection', async () => {
    const fixture = testConfig();
    const probeFile = path.join(fixture.work, 'injected-file.txt');
    const yaml = `schemaVersion: v1alpha1
name: env_inject
description: Command env injection safety test.
inputs:
  param:
    type: string
steps:
  - id: run_safe
    command: node test_script.js
    env:
      PARAM: "{{ inputs.param }}"
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'env_inject.yaml'), yaml);
    await syncWorkflowDefinitions(fixture.config);

    // Param contains a shell injection payload $(touch ...)
    const payload = `$(touch ${probeFile})`;
    const started = await startRun(fixture.config, 'env_inject', { param: payload });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    fs.writeFileSync(
      path.join(fixture.work, 'test_script.js'),
      "const fs = require('fs'); fs.writeFileSync('env_received.txt', process.env.PARAM);\n",
    );

    const done = await runLocalDriver(fixture.config, runId, fixture.work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    // The injected file was NOT created by the shell!
    expect(fs.existsSync(probeFile)).toBe(false);
    // The environment variable literally contains the payload text
    const received = fs.readFileSync(path.join(fixture.work, 'env_received.txt'), 'utf8');
    expect(received).toBe(payload);
  });

  it('runs a file sub-workflow with isolated scope and exposes outputs and end to parent', async () => {
    const fixture = testConfig();
    const childYaml = `schemaVersion: v1alpha1
name: child
description: Sub-workflow.
inputs:
  name:
    type: string
ends:
  - id: child_success
    status: succeeded
steps:
  - id: greet
    command: echo "hello $NAME"
    env:
      NAME: "{{ inputs.name }}"
    end: child_success
outputs:
  greeting: "{{ steps.greet.end }}"
`;
    const parentYaml = `schemaVersion: v1alpha1
name: parent
description: Parent calling child workflow.
steps:
  - id: call_child
    workflow: child
    with:
      name: "world"
  - id: verify_child
    needs: [call_child]
    if: steps.call_child.end == 'child_success'
    command: echo "verified child ended with child_success"
outputs:
  childEnd: "{{ steps.call_child.end }}"
  childOutput: "{{ steps.call_child.outputs.greeting }}"
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'child.yaml'), childYaml);
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'parent.yaml'), parentYaml);
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'parent');
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    const done = await runLocalDriver(fixture.config, runId, fixture.work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const state = await readRun(fixture.config, runId);
    expect(state).toMatchObject({
      status: 'succeeded',
      outputs: {
        childEnd: 'child_success',
        childOutput: 'child_success',
      },
      steps: [
        {
          id: 'call_child',
          status: 'succeeded',
          end: 'child_success',
          outputs: { greeting: 'child_success' },
        },
        { id: 'verify_child', status: 'succeeded' },
      ],
    });
  });

  it('runs an inline sub-workflow with access to enclosing scope', async () => {
    const fixture = testConfig();
    const yaml = `schemaVersion: v1alpha1
name: inline_test
description: Inline workflow test.
inputs:
  enclosing_var:
    type: string
steps:
  - id: inline_step
    workflow:
      steps:
        - id: sub_1
          command: echo $PARENT_VAL
          env:
            PARENT_VAL: "{{ inputs.enclosing_var }}"
      outputs:
        result: "{{ steps.sub_1.outcome }}"
  - id: after_inline
    needs: [inline_step]
    command: echo done
outputs:
  inlineResult: "{{ steps.inline_step.outputs.result }}"
`;
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'inline_test.yaml'), yaml);
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'inline_test', { enclosing_var: 'enclosed_value' });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    const done = await runLocalDriver(fixture.config, runId, fixture.work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    const state = await readRun(fixture.config, runId);
    expect(state).toMatchObject({
      status: 'succeeded',
      outputs: {
        inlineResult: 'success',
      },
      steps: [
        {
          id: 'inline_step',
          status: 'succeeded',
          outputs: { result: 'success' },
        },
        { id: 'after_inline', status: 'succeeded' },
      ],
    });
  });
});
