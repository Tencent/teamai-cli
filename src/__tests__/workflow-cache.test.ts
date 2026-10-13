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
    const cacheDir = path.join(config.dataHome ?? '', 'workflows', 'cache');
    expect(fs.existsSync(path.join(cacheDir, 'build.json'))).toBe(false);
    const cachedText = fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).map((name) => fs.readFileSync(path.join(cacheDir, name), 'utf8')).join('\n')
      : '';
    expect(cachedText).not.toContain('outside-only.js');
    const started = await startRun(config, 'build');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });
});
