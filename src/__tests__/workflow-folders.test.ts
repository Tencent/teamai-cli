import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { loadCachedWorkflow } from '../workflow/cache.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A project scope whose team repo is a git checkout with an empty first commit. */
function teamScope(): { config: LocalConfig; put: (file: string, content: string | Buffer) => void; commit: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-folders-'));
  dirs.push(root);
  const repo = path.join(root, 'team-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'TeamAI Test');
  git(repo, 'config', 'user.email', 'test@example.com');

  return {
    config: { repo: { localPath: repo, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') },
    put: (file, content) => {
      const full = path.join(repo, ...file.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    commit: () => {
      git(repo, 'add', '-A');
      git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'team content');
    },
  };
}

const RELEASE = `schemaVersion: v1alpha1
name: release
description: Plan the release, summarise it and open the PR.
steps:
  - id: plan
    command: python3 "$TEAMAI_WORKFLOW_DIR/plan.py"
    output: { version: string }
`;

describe('workflow folders', () => {
  it('caches workflows/<name>/WORKFLOW.yaml as the workflow named after its directory, with every file of the folder', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/plan.py', 'print("{\\"version\\": \\"1.2.0\\"}")\n');
    team.put('workflows/release/README.md', '# Release\n');
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect(result.cached).toEqual(['release']);
    const cached = await loadCachedWorkflow(team.config, 'release');
    expect(cached?.relativePath).toBe('workflows/release/WORKFLOW.yaml');
    expect(cached?.definition.description).toBe('Plan the release, summarise it and open the PR.');
    expect(cached?.files?.map((file) => file.path)).toEqual(['README.md', 'WORKFLOW.yaml', 'plan.py']);
  });

  it('finds a folder in a namespace, keeps a namespace without the marker and a lower-case workflow.yaml as today, and notes a YAML file inside a folder', async () => {
    const team = teamScope();
    team.put('workflows/payments/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/payments/release/checks.yaml', 'not: a workflow\n');
    team.put('workflows/payments/deploy.yaml', RELEASE.replace('name: release', 'name: deploy'));
    team.put('workflows/lower/workflow.yaml', RELEASE.replace('name: release', 'name: workflow'));
    team.commit();
    const info = vi.spyOn(log, 'info');

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toEqual([]);
    expect(result.cached.sort()).toEqual(['deploy', 'release', 'workflow']);
    expect((await loadCachedWorkflow(team.config, 'release'))?.relativePath).toBe('workflows/payments/release/WORKFLOW.yaml');
    expect((await loadCachedWorkflow(team.config, 'workflow'))?.relativePath).toBe('workflows/lower/workflow.yaml');
    expect(info).toHaveBeenCalledWith('[workflows] workflows/payments/release/ is a workflow folder; checks.yaml in it is not a workflow');
  });

  it('drops the last valid version of a folder that holds a symlink, naming the file', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.commit();
    await syncScorersThenWorkflows(team.config);
    fs.mkdirSync(path.join(team.config.repo.localPath, 'workflows', 'release', 'lib'));
    fs.symlinkSync(path.join(team.config.repo.localPath, 'workflows', 'release', 'WORKFLOW.yaml'), path.join(team.config.repo.localPath, 'workflows', 'release', 'lib', 'link.yaml'));

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{ file: 'workflows/release/WORKFLOW.yaml', code: 'workflow_folder_invalid', message: 'workflows/release/ is not a valid workflow folder: lib/link.yaml is a symlink' }]);
    expect(await loadCachedWorkflow(team.config, 'release')).toBeNull();
  });

  it('refuses a folder holding a file that is not UTF-8 text, naming it', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{ code: 'workflow_folder_invalid', message: 'workflows/release/ is not a valid workflow folder: assets/logo.png is not UTF-8 text' }]);
  });

  it('refuses a folder of more than 1 MB in total, naming its five largest files', async () => {
    const team = teamScope();
    team.put('workflows/release/WORKFLOW.yaml', RELEASE);
    team.put('workflows/release/README.md', 'r'.repeat(10));

    for (const [index, size] of [300_000, 250_000, 200_000, 150_000, 100_000, 60_000].entries()) {
      team.put(`workflows/release/data/part-${index}.txt`, 'x'.repeat(size));
    }

    team.commit();

    const result = await syncScorersThenWorkflows(team.config);

    expect(result.invalid).toMatchObject([{
      code: 'workflow_folder_invalid',
      message: `workflows/release/ is not a valid workflow folder: it holds ${Buffer.byteLength(RELEASE) + 10 + 1_060_000} bytes, more than the 1048576 bytes (1 MB) a workflow folder may hold. `
        + 'Its largest files: data/part-0.txt (300000 bytes), data/part-1.txt (250000 bytes), data/part-2.txt (200000 bytes), data/part-3.txt (150000 bytes), data/part-4.txt (100000 bytes)',
    }]);
  });

  it('hashes a folder by the mode git records and by its text with LF line endings, so checkouts on any system agree', async () => {
    const lf = teamScope();
    lf.put('workflows/release/WORKFLOW.yaml', RELEASE);
    lf.put('workflows/release/plan.sh', 'echo one\necho two\n');
    fs.chmodSync(path.join(lf.config.repo.localPath, 'workflows', 'release', 'plan.sh'), 0o755);
    lf.commit();
    // As on Windows: no executable bit on disk, git keeps the mode, and the text checks out with CRLF.
    const crlf = teamScope();
    git(crlf.config.repo.localPath, 'config', 'core.fileMode', 'false');
    crlf.put('workflows/release/WORKFLOW.yaml', RELEASE.replace(/\n/g, '\r\n'));
    crlf.put('workflows/release/plan.sh', 'echo one\r\necho two\r\n');
    git(crlf.config.repo.localPath, 'add', '-A');
    git(crlf.config.repo.localPath, 'update-index', '--chmod=+x', 'workflows/release/plan.sh');
    crlf.commit();

    await syncScorersThenWorkflows(lf.config);
    await syncScorersThenWorkflows(crlf.config);

    const [left, right] = await Promise.all([loadCachedWorkflow(lf.config, 'release'), loadCachedWorkflow(crlf.config, 'release')]);
    expect(right?.files?.find((file) => file.path === 'plan.sh')).toEqual({ path: 'plan.sh', executable: true, content: 'echo one\necho two\n' });
    expect(right?.sourceHash).toBe(left?.sourceHash);
  });
});
