import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';
import { getVotesDir } from '../types.js';
import { readIndexVoteFiles, stageVotesMerge, readUserVotes, incrementUpvoted } from '../votes.js';
import { indexInMemory } from '../utils/search-index.js';
import * as searchIndex from '../utils/search-index.js';
import { buildVizData } from '../viz.js';
import { acquireLock, releaseLock } from '../update.js';
import * as gitUtils from '../utils/git.js';
import { indexableVotesDir } from '../utils/reports-branch.js';

vi.mock('../utils/reports-branch.js', () => ({
  indexableVotesDir: vi.fn(async (config: LocalConfig) => path.join(config.repo.localPath, 'votes')),
}));

let dir: string;
let config: LocalConfig;
let localPath: string;
const docId = 'retry';
const date = new Date().toISOString();
const entry = (recalled = 1, upvoted = 1) => ({ recalled_count: recalled, upvoted_count: upvoted, last_recalled_at: date });
const snapshot = (recalled = 1, upvoted = 1) => ({ version: 2 as const, votes: { [docId]: entry(recalled, upvoted) }, deltas: {} });
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: config.repo.localPath, encoding: 'utf8' }).trim();
}
async function confirmed(data: unknown, name = 'alice.yaml'): Promise<void> {
  await fs.mkdir(path.join(config.repo.localPath, 'votes'), { recursive: true });
  await fs.writeFile(path.join(config.repo.localPath, 'votes', name), YAML.stringify(data));
  git('add', '.'); git('commit', '-qm', 'votes');
  git('update-ref', 'refs/remotes/origin/teamai-reports', 'HEAD');
}
async function pending(upvoted = 1): Promise<void> {
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, YAML.stringify({ ...snapshot(1, upvoted), deltas: { [docId]: { recalled_delta: 1, upvoted_delta: upvoted } } }));
}
async function indexed() {
  const index = await indexInMemory({ learningsDir: path.join(dir, 'learnings'), voteScope: config });
  return index.entries[0];
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-index-votes-'));
  config = { repo: { kind: 'git', localPath: path.join(dir, 'repo'), remote: 'local' }, username: 'alice', scope: 'project', projectRoot: dir, dataHome: path.join(dir, 'data'), additionalRoles: [] } as LocalConfig;
  localPath = path.join(getVotesDir(config), 'alice.yaml');
  await fs.mkdir(config.repo.localPath);
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(dir, 'learnings'));
  await fs.writeFile(path.join(dir, 'learnings', `${docId}.md`), '---\ntitle: Retry\ndate: 2026-10-21\n---\nRetry failed requests.\n');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('index local votes (#1233)', () => {
  it('uses the first local vote without a reports branch or votes directory, without consuming it', async () => {
    await pending();
    const before = await fs.readFile(localPath, 'utf8');
    const result = await indexed();
    expect(result.votes).toBe(1.3);
    expect(result.confidence).toBe(0.76);
    expect(result.hotness).toBe(1);
    expect(await fs.readFile(localPath, 'utf8')).toBe(before);
    expect((await indexed()).votes).toBe(1.3);
  });
  it('adds only deltas, not local historical totals, to all team members', async () => {
    await confirmed(snapshot(2, 1));
    await confirmed(snapshot(3, 2), 'bob.yaml');
    await pending();
    const data = await readUserVotes(localPath);
    data.votes[docId] = entry(100, 100);
    await fs.writeFile(localPath, YAML.stringify(data));
    expect((await indexed()).votes).toBeCloseTo(5.8);
  });
  it('does not add staged-but-unpushed votes twice', async () => {
    await confirmed(snapshot()); await pending();
    await stageVotesMerge(config.repo.localPath, 'alice', getVotesDir(config), snapshot());
    const before = await fs.readFile(localPath, 'utf8');
    expect((await indexed()).votes).toBe(2.6);
    expect(await fs.readFile(localPath, 'utf8')).toBe(before);
  });
  it('counts a pushed-but-unconfirmed stage only once without clearing its metadata', async () => {
    await confirmed(snapshot()); await pending();
    await stageVotesMerge(config.repo.localPath, 'alice', getVotesDir(config), snapshot());
    git('add', '.'); git('commit', '-qm', 'delivered'); git('update-ref', 'refs/remotes/origin/teamai-reports', 'HEAD');
    const before = await fs.readFile(localPath, 'utf8');
    expect((await indexed()).votes).toBe(2.6);
    expect(await fs.readFile(localPath, 'utf8')).toBe(before);
  });
  it('subtracts pushed-but-unconfirmed deltas and keeps new feedback', async () => {
    await confirmed(snapshot()); await pending();
    await stageVotesMerge(config.repo.localPath, 'alice', getVotesDir(config), snapshot());
    git('add', '.'); git('commit', '-qm', 'delivered'); git('update-ref', 'refs/remotes/origin/teamai-reports', 'HEAD');
    await incrementUpvoted(localPath, [docId]);
    const before = await fs.readFile(localPath, 'utf8');
    expect((await indexed()).votes).toBe(3.6);
    expect(await fs.readFile(localPath, 'utf8')).toBe(before);
  });
  it('keeps the receipt intact when reading a legacy YAML-aliased pending stage', async () => {
    await confirmed({ ...snapshot(2, 2), deliveredSyncIds: ['legacy-stage'] });
    const deltas = { [docId]: { recalled_delta: 1, upvoted_delta: 1 } };
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, YAML.stringify({
      ...snapshot(), deltas, pendingSync: { syncId: 'legacy-stage', deltas },
    }));
    expect(await fs.readFile(localPath, 'utf8')).toMatch(/&[a-zA-Z0-9]+/);
    await incrementUpvoted(localPath, [docId]);
    expect((await indexed()).votes).toBe(3.6);
    const persisted = YAML.parse(await fs.readFile(localPath, 'utf8'));
    expect(persisted.pendingSync.deltas[docId].upvoted_delta).toBe(1);
    expect(persisted.deltas[docId].upvoted_delta).toBe(2);
  });
  it('falls back to confirmed votes immediately while the votes lock is held', async () => {
    await confirmed(snapshot()); await pending();
    await stageVotesMerge(config.repo.localPath, 'alice', getVotesDir(config), snapshot());
    expect(await acquireLock(`${localPath}.lock`)).toBe(true);
    try {
      const result = await Promise.race([indexed(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('waited for votes lock')), 1500); timer.unref(); })]);
      expect(result.votes).toBe(1.3);
      expect(await fs.readFile(`${localPath}.lock`, 'utf8')).toContain('pid');
    } finally { await releaseLock(`${localPath}.lock`); }
    expect((await indexed()).votes).toBe(2.6);
  });
  it('uses the same vote snapshot for the real viz temporary-index rebuild', async () => {
    await confirmed(snapshot()); await pending();
    const original = searchIndex.buildIndex;
    let captured: number | undefined;
    const observe = vi.spyOn(searchIndex, 'buildIndex').mockImplementation(async (...args) => {
      const elapsed = await original(...args);
      const options = args[0];
      if (typeof options !== 'string' && options.indexPath) {
        captured = (await searchIndex.loadIndex(options.indexPath))?.entries.find((e) => e.filename === `${docId}.md`)?.votes;
      }
      return elapsed;
    });
    const learnings = path.join(dir, 'learnings');
    try {
      await buildVizData({
        root: config.repo.localPath, knowledgeRoot: config.repo.localPath,
        votesDir: path.join(config.repo.localPath, 'votes'),
        learningsDir: learnings, learningsDirs: [learnings], indexLearningsDirs: [learnings],
        learningsNamespaces: { ok: true, namespaces: [] }, scope: config,
        statsDir: path.join(dir, 'stats'), indexPath: undefined,
        source: { scope: 'team', label: 'Test team' },
      });
      expect(observe).toHaveBeenCalledOnce();
      expect(captured).toBe(2.6);
      expect(captured).toBe((await indexed()).votes);
    } finally { observe.mockRestore(); }
  });
  it('uses local deltas for HTTP repos without reading a reports branch', async () => {
    await confirmed(snapshot(100, 100)); await pending();
    config.repo.kind = 'http';
    expect((await indexed()).votes).toBe(1.3);
  });
  it('does not create local state when there are no local votes', async () => {
    await confirmed(snapshot());
    expect((await indexed()).votes).toBe(1.3);
    await expect(fs.stat(path.dirname(localPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it("excludes a foreign reports checkout but still includes this scope's local feedback", async () => {
    await confirmed(snapshot(100, 100)); await pending();
    vi.mocked(indexableVotesDir).mockResolvedValueOnce(undefined);
    expect((await indexed()).votes).toBe(1.3);
  });
  it('preserves legacy team vote scoring without migrating files', async () => {
    const legacy = { votes: { [docId]: { at: date } } };
    await confirmed(legacy, 'bob.yml');
    const file = path.join(config.repo.localPath, 'votes', 'bob.yml');
    const before = await fs.readFile(file, 'utf8');
    expect((await indexed()).votes).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
  it('clamps a negative pending delta at zero and clears its timestamp in memory', async () => {
    await confirmed(snapshot(0, 1)); await pending(-2);
    const files = await readIndexVoteFiles(config);
    const data = YAML.parse(files[0].content);
    expect(data.votes[docId].upvoted_count).toBe(0);
    expect(data.votes[docId].last_upvoted_at).toBeUndefined();
  });
  it('keeps unrelated same-member v1 scores while applying local feedback', async () => {
    await confirmed({ votes: { retry: { at: date }, other: { at: date } } });
    const before = await fs.readFile(path.join(config.repo.localPath, 'votes', 'alice.yaml'), 'utf8');
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, YAML.stringify({ version: 2, votes: { other: entry(0, 1) }, deltas: { other: { recalled_delta: 0, upvoted_delta: 1 } } }));
    await fs.writeFile(path.join(dir, 'learnings', 'other.md'), '# Other\nOther knowledge.\n');
    const index = await indexInMemory({ learningsDir: path.join(dir, 'learnings'), voteScope: config });
    expect(index.entries.find(e => e.filename === 'retry.md')?.votes).toBe(1);
    expect(index.entries.find(e => e.filename === 'other.md')?.votes).toBe(1.3);
    expect(await fs.readFile(path.join(config.repo.localPath, 'votes', 'alice.yaml'), 'utf8')).toBe(before);
  });
  it.each([false, true])('names a corrupt votes file, including with local deltas: %s', async (withLocal) => {
    const { log } = await import('../utils/logger.js');
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      await confirmed(snapshot());
      const file = path.join(config.repo.localPath, 'votes', 'alice.yaml');
      await fs.writeFile(file, 'votes: [');
      git('add', '.'); git('commit', '-qm', 'corrupt'); git('update-ref', 'refs/remotes/origin/teamai-reports', 'HEAD');
      if (withLocal) await pending();
      expect((await indexed()).votes).toBe(withLocal ? 1.3 : 0);
      expect(error).toHaveBeenCalledWith(`Failed to parse index votes: ${file}`);
    } finally { error.mockRestore(); }
  });

  it('releases the votes lock before reading member blobs and keeps a coherent snapshot', async () => {
    await confirmed(snapshot()); await pending();
    const createGit = gitUtils.createGit;
    let checked = false;
    const spy = vi.spyOn(gitUtils, 'createGit').mockImplementation((...args) => {
      const client = createGit(...args);
      return new Proxy(client, {
        get(target, key, receiver) {
          if (key !== 'raw') return Reflect.get(target, key, receiver);
          return async (...rawArgs: unknown[]) => {
            if (!checked) {
              const held = await acquireLock(`${localPath}.lock`);
              expect(held).toBe(true);
              if (held) await releaseLock(`${localPath}.lock`);
              // A writer can proceed during the slow read; this index must still
              // use the local snapshot captured with its pinned remote ref.
              await incrementUpvoted(localPath, [docId]);
              checked = true;
            }
            return Reflect.apply(target.raw, target, rawArgs);
          };
        },
      });
    });
    try {
      expect((await indexed()).votes).toBe(2.6);
      expect(checked).toBe(true);
    } finally { spy.mockRestore(); }
    expect((await indexed()).votes).toBe(3.6);
  });

  // #1278: upvoting a never-recalled doc must not apply the cold penalty.
  it('keeps an upvote-only document hot when last_upvoted_at is recent (#1278)', async () => {
    await confirmed({
      version: 2,
      votes: {
        [docId]: {
          recalled_count: 0,
          upvoted_count: 1,
          last_recalled_at: '',
          last_upvoted_at: date,
        },
      },
      deltas: {},
    });
    const result = await indexed();
    expect(result.confidence).toBe(0.72);
    expect(result.hotness).toBe(1);
  });
});
