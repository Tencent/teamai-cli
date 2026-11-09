import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { knownSecrets } from '../env-resolution.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow } from '../workflow/cache.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

_setDriverPollMs(20);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('TEAMAI_WORKFLOW_DIR', () => {
  it('reaches a command step through the platform shell from a data home path holding spaces and non-ASCII characters, with forward slashes', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-paths-')));
    dirs.push(root);
    const repo = path.join(root, 'team-repo');
    const folder = path.join(repo, 'workflows', 'release');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'WORKFLOW.yaml'), 'schemaVersion: v1alpha1\nname: release\ndescription: Release.\nsteps:\n'
      + '  - id: plan\n    command: cat "$TEAMAI_WORKFLOW_DIR/plan.json"\n    output: json\n'
      + '  - id: where\n    needs: [plan]\n    command: \'echo "{\\"dir\\": \\"$TEAMAI_WORKFLOW_DIR\\"}"\'\n    output: json\n');
    fs.writeFileSync(path.join(folder, 'plan.json'), '{"version": "1.2.0"}\n');
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '-A');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'team');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    git(workspace, 'init', '--quiet');
    git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'initial');
    const dataHome = path.join(root, 'data home 数据');
    const config: LocalConfig = { repo: { localPath: repo, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: workspace, dataHome };
    expect((await syncScorersThenWorkflows(config)).invalid).toEqual([]);
    const sourceHash = (await loadCachedWorkflow(config, 'release'))?.sourceHash ?? '';
    const started = await startRun(config, 'release', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);

    expect(await runLocalDriver(config, String(started.data.run), workspace, {})).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(await readRun(config, String(started.data.run))).toMatchObject({
      steps: [
        { id: 'plan', outputs: { version: '1.2.0' } },
        { id: 'where', outputs: { dir: path.join(dataHome, 'workflows', 'folders', sourceHash).split(path.sep).join('/') } },
      ],
    });
  });
});
