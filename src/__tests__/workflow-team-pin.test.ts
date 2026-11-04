import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
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
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A member's team checkout with one commit that holds `workflows/build.yaml` and `files`, pushed unless `pushed` is false, synced. */
async function pushedTeam(files: Record<string, string>, { pushed = true } = {}): Promise<{ config: LocalConfig; write(file: string, text: string): void; push(message: string): void }> {
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
  if (pushed) git(team, 'push', '-q', '--set-upstream', 'origin', 'main');
  const config: LocalConfig = {
    repo: { localPath: team, remote: path.join(root, 'origin.git') },
    username: 'tester', scope: 'project', additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  await syncScorersThenWorkflows(config);

  return { config, write, push: (message) => { commit(message); git(team, 'push', '-q', 'origin', 'main'); } };
}

async function started(config: LocalConfig): Promise<string> {
  const envelope = await startRun(config, 'build', {}, { secrets: {} });

  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);

  return String(envelope.data.run);
}

async function readAtPin(config: LocalConfig, runId: string, file: string, { revision }: { revision?: string } = {}) {
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') throw new Error(`run ${runId} is ${run}`);
  const pinned = revision === undefined || run.teamPin === undefined ? run : { ...run, teamPin: { ...run.teamPin, revision } };

  return TeamPin.withTree(config, pinned, async (at) => fs.readFileSync(path.join(at.repo.localPath, file), 'utf8'));
}

describe('a run reads team files at the team revision it started from', () => {
  it('keeps the bytes it started with after the checkout pushes an edit, and the next run reads the edit', async () => {
    const { config, write, push } = await pushedTeam({ 'scorers/quality.md': 'v1\n' });
    const first = await started(config);
    write('scorers/quality.md', 'v2\n');
    push('edit quality');
    const second = await started(config);

    expect(await readAtPin(config, first, 'scorers/quality.md')).toEqual({ ok: true, value: 'v1\n' });
    expect(await readAtPin(config, second, 'scorers/quality.md')).toEqual({ ok: true, value: 'v2\n' });
  });

  it('pins the checkout\'s own commit when the team remote holds none of its history', async () => {
    const { config } = await pushedTeam({ 'scorers/quality.md': 'v1\n' }, { pushed: false });

    expect(await TeamPin.capture(config)).toEqual({ pin: { revision: git(config.repo.localPath, 'rev-parse', 'HEAD') } });
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

    expect(await readAtPin(config, runId, 'scorers/quality.md')).toEqual({ ok: true, value: 'edited\n' });
    expect(await readAtPin(config, runId, 'scorers/coverage.md')).toEqual({ ok: true, value: 'new\n' });
    expect(await readAtPin(config, runId, 'skills/notes/SKILL.md')).toEqual({ ok: true, value: 'committed, not pushed\n' });
  });

  it('answers why, rather than throwing, when the changes it started from do not apply to the revision it reads', async () => {
    const { config, write, push } = await pushedTeam({ 'scorers/quality.md': 'v1\n' });
    write('scorers/quality.md', 'edited\n');
    const runId = await started(config);
    git(config.repo.localPath, 'checkout', '--', 'scorers/quality.md');
    write('scorers/quality.md', 'v2\n');
    push('edit quality');

    expect(await readAtPin(config, runId, 'scorers/quality.md', { revision: git(config.repo.localPath, 'rev-parse', 'HEAD') })).toEqual({
      ok: false, failed: expect.stringContaining(`the changes run ${runId} started from do not apply to team commit`),
    });
  });

  it('keeps what use answers apart from a failure, though it has a failed key', async () => {
    const { config } = await pushedTeam({});
    const run = await readRun(config, await started(config));

    if (run === 'missing' || run === 'corrupt') throw new Error(`run is ${run}`);

    expect(await TeamPin.withTree(config, run, async () => ({ failed: 'a scorer of that name' }))).toEqual({ ok: true, value: { failed: 'a scorer of that name' } });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('warns, naming what failed, when git cannot read the edits past the pushed commit, and pins that commit', async () => {
    const { config, write } = await pushedTeam({ 'scorers/quality.md': 'v1\n' });
    write('scorers/locked.md', 'unreadable\n');
    fs.chmodSync(path.join(config.repo.localPath, 'scorers', 'locked.md'), 0o000);
    const warn = vi.spyOn(log, 'warn');

    try {
      expect(await TeamPin.capture(config)).toEqual({ pin: { revision: git(config.repo.localPath, 'rev-parse', 'HEAD') } });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^The run reads team commit [0-9a-f]{7} without the edits past it: git add -A failed: .+/));
    } finally {
      fs.chmodSync(path.join(config.repo.localPath, 'scorers', 'locked.md'), 0o644);
    }
  });
});
