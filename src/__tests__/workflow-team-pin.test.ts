import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import { TeamPin } from '../workflow/team-pin.js';

const BUILD = `schemaVersion: v1alpha1
name: build
description: Compile the project.
steps:
  - id: compile
    command: node compile.js
`;

const dirs: string[] = [];

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A member's team checkout with one pushed commit that holds `workflows/build.yaml` and `files`, synced. */
async function pushedTeam(files: Record<string, string>): Promise<{ config: LocalConfig; write(file: string, text: string): void; push(message: string): void }> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-pin-')));
  dirs.push(root);
  const team = path.join(root, 'team');
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(team, file)), { recursive: true });
    fs.writeFileSync(path.join(team, file), text);
  };
  git(root, 'init', '-q', '--bare', '--initial-branch=main', path.join(root, 'origin.git'));
  fs.mkdirSync(team);
  git(team, 'init', '-q', '--initial-branch=main');
  git(team, 'config', 'user.name', 'T');
  git(team, 'config', 'user.email', 't@example.test');
  git(team, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
  write('workflows/build.yaml', BUILD);
  for (const [file, text] of Object.entries(files)) write(file, text);
  const commit = (message: string): void => {
    git(team, 'add', '-A');
    git(team, 'commit', '-qm', message);
  };
  commit('base');
  git(team, 'push', '-q', '--set-upstream', 'origin', 'main');
  const config: LocalConfig = {
    repo: { localPath: team, remote: path.join(root, 'origin.git') },
    username: 'tester', scope: 'project', additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  await syncWorkflowDefinitions(config);

  return { config, write, push: (message) => { commit(message); git(team, 'push', '-q', 'origin', 'main'); } };
}

async function started(config: LocalConfig): Promise<string> {
  const envelope = await startRun(config, 'build', {}, { secrets: {} });

  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);

  return String(envelope.data.run);
}

async function readAtPin(config: LocalConfig, runId: string, file: string): Promise<string | { failed: string }> {
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') throw new Error(`run ${runId} is ${run}`);

  return TeamPin.withTree(config, run, async (at) => fs.readFileSync(path.join(at.repo.localPath, file), 'utf8'));
}

describe('a run reads team files at the team revision it started from', () => {
  it('keeps the bytes it started with after the checkout pushes an edit, and the next run reads the edit', async () => {
    const { config, write, push } = await pushedTeam({ 'scorers/quality.md': 'v1\n' });
    const first = await started(config);
    write('scorers/quality.md', 'v2\n');
    push('edit quality');
    const second = await started(config);

    expect(await readAtPin(config, first, 'scorers/quality.md')).toBe('v1\n');
    expect(await readAtPin(config, second, 'scorers/quality.md')).toBe('v2\n');
  });

  it('carries the checkout\'s uncommitted edits, new files and unpushed commits, and not a later edit', async () => {
    const { config, write } = await pushedTeam({ 'scorers/quality.md': 'v1\n' });
    write('scorers/quality.md', 'edited\n');
    write('scorers/coverage.md', 'new\n');
    write('skills/notes/SKILL.md', 'committed, not pushed\n');
    git(config.repo.localPath, 'add', 'skills');
    git(config.repo.localPath, 'commit', '-qm', 'local only');
    const runId = await started(config);
    write('scorers/quality.md', 'later\n');

    expect(await readAtPin(config, runId, 'scorers/quality.md')).toBe('edited\n');
    expect(await readAtPin(config, runId, 'scorers/coverage.md')).toBe('new\n');
    expect(await readAtPin(config, runId, 'skills/notes/SKILL.md')).toBe('committed, not pushed\n');
  });
});
