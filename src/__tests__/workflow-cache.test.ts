import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

function writeWorkflow(config: LocalConfig, name: string, body: string): void {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), body);
}

function cachedText(config: LocalConfig): string {
  const home = config.dataHome ?? '';
  if (!fs.existsSync(home)) return '';
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(home);
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

const VALID = `schemaVersion: v1alpha1
name: build
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow cache', () => {
  it('caches a valid workflow and leaves a new invalid file unrunnable', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    writeWorkflow(config, 'broken', 'schemaVersion: v1alpha1\nname: nope\ndescription: x\nsteps: []\n');

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual(['build']);
    expect(result.unrunnable).toEqual(['workflows/broken.yaml']);
    expect(result.invalid.some((diagnostic) => diagnostic.file === 'workflows/broken.yaml' && diagnostic.line > 0)).toBe(true);
    const started = await startRun(config, 'broken');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
    const runnable = await startRun(config, 'build');
    expect(runnable).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('keeps the last valid version when a file becomes invalid', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    const first = await startRun(config, 'build');
    if ('error' in first) throw new Error(first.error.message);
    const before = await readRun(config, String(first.data.run));
    if (typeof before !== 'object') throw new Error('run was not stored');

    writeWorkflow(config, 'build', 'schemaVersion: [\n');
    const again = await syncWorkflowDefinitions(config);

    expect(again.kept).toEqual(['build']);
    expect(again.cached).not.toContain('build');
    expect(again.invalid[0]).toMatchObject({ file: 'workflows/build.yaml', field: '(document)' });
    const second = await startRun(config, 'build');
    if ('error' in second) throw new Error(second.error.message);
    const after = await readRun(config, String(second.data.run));
    if (typeof after !== 'object') throw new Error('run was not stored');
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.definition.steps[0]?.command).toBe('node compile.js');
    const leased = await leaseNext(config, after.id, { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'node compile.js' } } });
  });

  it('keeps a runnable cache when dry-run sees a deleted source file', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', VALID);
    await syncWorkflowDefinitions(config);
    fs.rmSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    await syncWorkflowDefinitions(config, { dryRun: true });

    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ data: { name: 'build', status: 'running' } });
  });

  it('does not read a symlinked workflows directory', async () => {
    const config = testConfig();
    const workflows = path.join(config.repo.localPath, 'workflows');
    fs.rmSync(workflows, { recursive: true, force: true });
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-workflows');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'build.yaml'), VALID.replace('command: node compile.js', 'command: node outside-dir.js'));
    fs.symlinkSync(outside, workflows);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-dir.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('does not read or cache a symlinked yaml outside workflows', async () => {
    const config = testConfig();
    const outside = path.join(path.dirname(config.repo.localPath), 'outside-build.yaml');
    const body = VALID.replace('command: node compile.js', 'command: node outside-only.js');
    fs.writeFileSync(outside, body);
    fs.symlinkSync(outside, path.join(config.repo.localPath, 'workflows', 'build.yaml'));

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).not.toContain('build');
    expect(result.invalid).toEqual([]);
    expect(result.unrunnable).toEqual([]);
    expect(cachedText(config)).not.toContain('outside-only.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });

  it('keeps each self-mode checkout on its own cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cache-'));
    dirs.push(root);
    const dataHome = path.join(root, 'data');
    const checkout = (name: string, command: string): LocalConfig => {
      const business = path.join(root, name);
      const knowledge = path.join(business, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self', businessRepoRoot: business },
        username: 'tester',
        scope: 'project',
        additionalRoles: [],
        projectRoot: business,
        dataHome,
      };
      writeWorkflow(config, 'build', VALID.replace('command: node compile.js', `command: ${command}`));
      return config;
    };

    const first = checkout('a', 'echo main-command');
    const second = checkout('b', 'echo second-command');
    await syncWorkflowDefinitions(first);
    await syncWorkflowDefinitions(second);

    const started = await startRun(first, 'build');
    if ('error' in started) throw new Error(started.error.message);
    const leased = await leaseNext(first, String(started.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(leased).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    writeWorkflow(first, 'build', 'schemaVersion: [\n');
    const kept = await syncWorkflowDefinitions(first);
    expect(kept.kept).toEqual(['build']);
    const afterInvalid = await startRun(first, 'build');
    if ('error' in afterInvalid) throw new Error(afterInvalid.error.message);
    const stillFirst = await leaseNext(first, String(afterInvalid.data.run), { kind: 'local', machine: 'test', workspace: '/work' });
    expect(stillFirst).toMatchObject({ data: { lease: { command: 'echo main-command' } } });

    fs.rmSync(path.join(second.repo.localPath, 'workflows', 'build.yaml'));
    await syncWorkflowDefinitions(second);
    const afterDelete = await startRun(first, 'build');
    expect(afterDelete).toMatchObject({ data: { name: 'build', status: 'running' } });
  });
});
