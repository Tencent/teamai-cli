import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStateForScope, saveState, saveStateForScope } from '../config.js';
import { buildIndex, loadIndex } from '../utils/search-index.js';
import type { LocalConfig, State } from '../types.js';

// Issue #854: state.json and search-index.json were written in place. Opening
// the target for writing truncates it, so a reader mid-save saw an empty file —
// and readJson answers null for what it cannot parse: state.json came back as
// parse({}), dropping every pull/push base (the stale-base overwrite class the
// worktree fixes closed), and the search index as no index at all, wiping
// recall until the next rebuild. config.yaml got the same fix in #831, and
// saveUserVotes documents the identical failure mode for the votes file.
describe('machine state saves are atomic', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let stateDir: string;
  let statePath: string;
  let localConfig: LocalConfig;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'teamai-atomic-state-'));
    process.env.HOME = home;
    stateDir = path.join(home, '.teamai');
    statePath = path.join(stateDir, 'state.json');
    mkdirSync(stateDir, { recursive: true });
    localConfig = {
      repo: { localPath: '/nonexistent/team-repo', remote: 'https://github.com/acme/team.git' },
      username: 'dev',
      updatePolicy: 'auto',
      scope: 'user',
    } as unknown as LocalConfig;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const initialState = JSON.stringify({
    lastPull: '2026-09-27T00:00:00.000Z',
    lastPullRev: 'abc1234',
    lastPullByWorkspace: { work: { rev: 'abc1234', targets: ['claude'], pushBaseRevs: ['def5678'] } },
  }, null, 2) + '\n';

  const updatedState = {
    lastPull: null,
    lastPush: null,
    lastPullRev: 'fedcba9',
  } as unknown as State;

  /**
   * Every write into the state dir first truncates its target — the state an
   * in-place write exposes between open(O_TRUNC) and the data landing. Then
   * `during` runs (a concurrent reader), and the write either completes or
   * fails with ENOSPC. Same method as the config.yaml save test (#831).
   */
  function interruptStateWrites(during: () => Promise<void>, outcome: 'complete' | 'fail'): void {
    const realWriteFile = fse.writeFile;
    vi.spyOn(fse, 'writeFile').mockImplementation(async (file: unknown, data: unknown) => {
      if (typeof file !== 'string' || typeof data !== 'string') throw new Error('unexpected writeFile call in test');
      if (path.dirname(file) !== stateDir) return realWriteFile(file, data, 'utf-8');
      await realWriteFile(file, '', 'utf-8');
      await during();
      if (outcome === 'fail') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWriteFile(file, data, 'utf-8');
    });
  }

  describe.each([
    ['saveState', (state: State) => saveState(state)],
    ['saveStateForScope', (state: State) => saveStateForScope(state, localConfig)],
  ] as const)('%s', (_name, save) => {
    it('never lets a concurrent reader see an empty or partial state', async () => {
      writeFileSync(statePath, initialState, 'utf-8');
      let seenMidSave: string | null | undefined;
      interruptStateWrites(async () => {
        seenMidSave = (await loadStateForScope(localConfig))?.lastPullRev ?? null;
      }, 'complete');

      await save(updatedState);

      expect(seenMidSave).toBe('abc1234');
      expect((await loadStateForScope(localConfig))?.lastPullRev).toBe('fedcba9');
    });

    it('a failed write leaves the previous state intact', async () => {
      writeFileSync(statePath, initialState, 'utf-8');
      interruptStateWrites(async () => {}, 'fail');

      await expect(save(updatedState)).rejects.toThrow('ENOSPC');

      expect((await loadStateForScope(localConfig))?.lastPullRev).toBe('abc1234');
    });
  });

  describe('search index', () => {
    let tmpDir: string;
    let learnings: string;
    let indexPath: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-atomic-index-'));
      learnings = path.join(tmpDir, 'learnings');
      mkdirSync(learnings, { recursive: true });
      indexPath = path.join(tmpDir, 'search-index.json');
      writeFileSync(path.join(learnings, 'a.md'), '---\ntitle: note a\n---\nretry budget');
    });

    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('never lets a concurrent loadIndex see a torn index', async () => {
      await buildIndex({ learningsDirs: [learnings], indexPath });

      const realWriteFile = fse.writeFile;
      vi.spyOn(fse, 'writeFile').mockImplementation(async (file: unknown, data: unknown) => {
        if (typeof file !== 'string' || typeof data !== 'string') throw new Error('unexpected writeFile call in test');
        if (path.dirname(file) !== tmpDir) return realWriteFile(file, data, 'utf-8');
        await realWriteFile(file, '', 'utf-8');
        const seenMidSave = await loadIndex(indexPath);
        expect(seenMidSave?.entries.map((e) => e.filename)).toEqual(['a.md']);
        return realWriteFile(file, data, 'utf-8');
      });

      // The shrink guard must not mistake the tiny fixture corpus for a partial
      // build: one entry rebuilt as one entry is a full index, not a shrink.
      await buildIndex({ learningsDirs: [learnings], indexPath });

      expect((await loadIndex(indexPath))?.entries.map((e) => e.filename)).toEqual(['a.md']);
    });
  });
});
