import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knownSecrets } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { findRunConfig } from '../workflow/run-location.js';
import { readRun, runFilePath } from '../workflow/store.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('finding a run by id', () => {
  it('finds a run without a current scope and rejects duplicate ids across scopes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-run-location-'))); dirs.push(root);
    const home = path.join(root, 'home'); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const work = path.join(root, 'work'); const repo = path.join(root, 'knowledge');
    fs.mkdirSync(work); fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
    const dataHome = path.join(home, '.teamai', 'projects', 'fixture');
    const config: LocalConfig = { repo: { kind: 'self', localPath: repo, remote: 'local' }, username: 'test', scope: 'project', projectRoot: work, additionalRoles: [], dataHome };
    fs.mkdirSync(dataHome, { recursive: true }); fs.writeFileSync(path.join(dataHome, 'config.yaml'), YAML.stringify(config));
    fs.writeFileSync(path.join(repo, 'workflows', 'build.yaml'), 'schemaVersion: v1alpha1\nname: build\ndescription: One step.\nsteps:\n  - id: work\n    command: echo work\n');
    await syncWorkflowDefinitions(config);
    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    expect(await findRunConfig(runId)).toMatchObject({ config: { projectRoot: work }, run: { id: runId } });
    const other = path.join(home, '.teamai', 'projects', 'duplicate'); fs.mkdirSync(path.join(other, 'workflows', 'runs'), { recursive: true });
    fs.copyFileSync(path.join(dataHome, 'config.yaml'), path.join(other, 'config.yaml'));
    const run = await readRun(config, runId);
    fs.writeFileSync(path.join(other, 'workflows', 'runs', `${runId}.json`), JSON.stringify(run));
    expect(await findRunConfig(runId)).toMatchObject({ error: { code: 'ambiguous_run' } });
    expect(fs.existsSync(runFilePath(config, runId))).toBe(true);
  });
});
