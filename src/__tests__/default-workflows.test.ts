import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { listCachedWorkflows, loadCachedWorkflow, loadWorkflowTree, syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { buildStartRecord } from '../workflow/records.js';
import { readRun } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';

/** The version in the package manifest, which a default run records. */
const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-default-workflows-'));
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

const workflow = (name: string) => `schemaVersion: v1alpha1
name: ${name}
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

const sources = async (config: LocalConfig) => (await listCachedWorkflows(config)).map(({ definition, source }) => [definition.name, source]);

describe('default workflows', () => {
  it('resolve session-close to the teamai default until the team adds workflows/session-close.yaml', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', workflow('build'));
    await syncWorkflowDefinitions(config);

    const shipped = await loadCachedWorkflow(config, 'session-close');
    expect(shipped).toMatchObject({ source: 'default', relativePath: 'workflows/session-close.yaml', definition: { name: 'session-close', invoke: 'ask' } });
    expect(shipped?.teamRevision).toBeUndefined();
    expect(await sources(config)).toEqual([['build', 'team'], ['session-close', 'default']]);

    writeWorkflow(config, 'session-close', workflow('session-close'));
    await syncWorkflowDefinitions(config);

    expect(await loadCachedWorkflow(config, 'session-close')).toMatchObject({ source: 'team', definition: { steps: [{ command: 'node compile.js' }] } });
    expect(await sources(config)).toEqual([['build', 'team'], ['session-close', 'team']]);
  });

  it('are never written to the workflow cache', async () => {
    const config = testConfig();
    await syncWorkflowDefinitions(config);
    await loadCachedWorkflow(config, 'session-close');

    const home = config.dataHome ?? '';
    expect(fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }).map(String).filter((file) => file.includes('session-close')) : []).toEqual([]);
  });

  it('run as a sub-workflow of a team workflow', async () => {
    const config = testConfig();
    writeWorkflow(config, 'wrap-up', `schemaVersion: v1alpha1
name: wrap-up
description: Run the checks, then close the session.
inputs: { session: string, source: string, publish: boolean, scorers: [string], judge: here | driver }
steps:
  - id: close
    workflow: session-close
    with: { session: "{{ inputs.session }}", source: "{{ inputs.source }}", publish: "{{ inputs.publish }}", scorers: "{{ inputs.scorers }}", judge: "{{ inputs.judge }}" }
`);

    const result = await syncWorkflowDefinitions(config);

    expect(result.cached).toEqual(['wrap-up']);
    const wrap = await loadCachedWorkflow(config, 'wrap-up');
    if (!wrap) throw new Error('wrap-up is not runnable');
    const tree = await loadWorkflowTree(config, wrap);
    expect('failed' in tree ? tree.failed : Object.keys(tree.workflows)).toEqual(['session-close']);
  });

  it('record on the run and its start record that it ran teamai\'s default at this version, and a team run that it ran the team\'s', async () => {
    const config = testConfig();
    writeWorkflow(config, 'build', workflow('build'));
    await syncWorkflowDefinitions(config);
    const secrets = await knownSecrets(config);
    const runOf = async (name: string, inputs: unknown) => {
      const started = await startRun(config, name, inputs, { secrets });
      if ('error' in started) throw new Error(started.error.message);
      const run = await readRun(config, String(started.data.run));
      if (typeof run !== 'object') throw new Error('the run was not stored');
      return run;
    };

    const closed = await runOf('session-close', { session: 's1', source: 'claude', publish: false, scorers: [], judge: 'here' });
    const built = await runOf('build', {});

    expect(closed).toMatchObject({ origin: { source: 'default', teamaiVersion: PACKAGE_VERSION } });
    expect(closed).not.toHaveProperty('teamRevision');
    expect(buildStartRecord(closed, undefined, 'tester')).toMatchObject({ origin: { source: 'default', teamaiVersion: PACKAGE_VERSION } });
    expect(built.origin).toEqual({ source: 'team' });
    expect(buildStartRecord(built, undefined, 'tester').origin).toEqual({ source: 'team' });
  });

  it('stay in effect while a team override was never valid', async () => {
    const config = testConfig();
    writeWorkflow(config, 'session-close', 'schemaVersion: v1alpha1\nname: session-close\ndescription: x\nsteps: []\n');

    const warn = vi.spyOn(log, 'warn');

    const result = await syncWorkflowDefinitions(config);

    expect(result.unrunnable).toEqual(['workflows/session-close.yaml']);
    expect(warn).toHaveBeenCalledWith('[workflows] workflows/session-close.yaml has no runnable version, so teamai\'s default session-close stays in effect');
    expect(await loadCachedWorkflow(config, 'session-close')).toMatchObject({ source: 'default' });
  });
});
