import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { DataBranches } from '../utils/data-branches.js';
import { finishDataCheckout, openDataCheckout } from '../workflow/place/data.js';
import type { AttemptId, RunId } from '../workflow/store.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const RUN = 'r0000000000000001' as RunId;
const ATTEMPT = 'a1' as AttemptId;

let sandbox = '';
let remote = '';
let config: LocalConfig;

beforeEach(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-data-')));
  remote = path.join(sandbox, 'remote.git');
  const seed = path.join(sandbox, 'seed');
  const clone = path.join(sandbox, 'team-repo');
  fs.mkdirSync(seed);
  git(sandbox, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'main only\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'checkout', '-q', '--orphan', 'teamai-reports');
  git(seed, 'rm', '-qrf', '.');
  fs.mkdirSync(path.join(seed, 'scores', 'bob'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'scores', 'bob', '2026-11.jsonl'), '{"bob":1}\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'reports');
  git(seed, 'push', '-q', '-u', 'origin', 'teamai-reports');
  git(sandbox, 'clone', '-q', remote, clone);
  config = { repo: { localPath: clone, remote }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(sandbox, 'data') };
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  attempts = 0;
});

const onOrigin = (file: string): string | undefined => {
  const shown = spawnSync('git', ['--git-dir', remote, 'show', `teamai-reports:${file}`], { encoding: 'utf8' });
  return shown.status === 0 ? shown.stdout : undefined;
};
const tip = (): string => git(sandbox, '--git-dir', remote, 'rev-parse', 'teamai-reports');

/** Opens the place of step `note`, has it stage `files`, and finishes it. */
async function publish(files: Record<string, string>, before?: () => void) {
  const opened = await openDataCheckout({ config, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(opened.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(opened.dir, file), text);
    if (opened.at.kind === 'checkout') git(opened.dir, 'add', '--', file);
  }
  before?.();
  const finished = await finishDataCheckout({ config, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at });
  return { opened, finished };
}

const NOTES = 'standups/tester/2026-11.md';
let attempts = 0;

/** Opens the place of step `note` for a new attempt, has it append `line` to `file` as share-standup does, and finishes it. */
async function append(file: string, line: string) {
  attempts += 1;
  const opened = await openDataCheckout({ config, run: RUN, attempt: `a${String(attempts).padStart(3, '0')}` as AttemptId, branch: 'teamai-reports' });
  fs.mkdirSync(path.dirname(path.join(opened.dir, file)), { recursive: true });
  fs.appendFileSync(path.join(opened.dir, file), `${line}\n`);
  git(opened.dir, 'add', '--', file);
  return finishDataCheckout({ config, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at });
}

/** Another machine of this member sets `file` on origin to `text`. */
function onAnotherMachine(file: string, text: string): void {
  const other = path.join(sandbox, 'other');
  if (!fs.existsSync(other)) git(sandbox, 'clone', '-q', '--branch', 'teamai-reports', remote, other);
  git(other, 'pull', '-q', '--ff-only');
  fs.writeFileSync(path.join(other, file), text);
  git(other, 'commit', '-qam', 'another machine');
  git(other, 'push', '-q', 'origin', 'teamai-reports');
}

/** What `teamai score --push` says of kept patches `files` that no longer apply to teamai-reports. */
const stuckMessage = (files: string[]): string => 'What workflow steps published to teamai-reports stays pending on this machine: kept patches no longer apply to teamai-reports. '
  + `To publish them, apply each by hand in a checkout of teamai-reports (git apply --3way <patch>), resolve any conflict, commit and push, then delete the patch: ${files.join(', ')}.`;

async function whileLocked<T>(action: () => Promise<T>): Promise<T> {
  const lock = path.join(path.dirname(config.repo.localPath), '.reports-lock');
  await DataBranches.checkout('teamai-reports').refresh(config);
  expect(await acquireLock(lock)).toBe(true);
  return action().finally(() => releaseLock(lock));
}

describe('the place of a deliver: publish step', () => {
  it('opens at origin\'s tip of the data branch, without the default branch, and publishes what the step staged in the member\'s files', async () => {
    const { opened, finished } = await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n', 'votes/tester.yaml': 'up: 1\n' });

    expect(opened.at).toEqual({ kind: 'checkout', base: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(fs.existsSync(path.join(opened.dir, 'README.md'))).toBe(false);
    expect(finished).toEqual({});
    expect(onOrigin('scores/tester/2026-11.jsonl')).toBe('{"tester":1}\n');
    expect(onOrigin('votes/tester.yaml')).toBe('up: 1\n');
    expect(onOrigin('scores/bob/2026-11.jsonl')).toBe('{"bob":1}\n');
    expect(git(sandbox, '--git-dir', remote, 'log', '-1', '--format=%s', 'teamai-reports')).toBe('[teamai] note: tester');
    expect(fs.existsSync(opened.dir)).toBe(false);
  });

  it('refuses every staged path outside the member\'s own, a deletion included, and publishes nothing', async () => {
    const before = tip();
    const opened = await openDataCheckout({ config, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });
    fs.mkdirSync(path.join(opened.dir, 'scores', 'tester'), { recursive: true });
    fs.writeFileSync(path.join(opened.dir, 'scores', 'tester', 'ok.jsonl'), '{}\n');
    fs.writeFileSync(path.join(opened.dir, 'top.txt'), 'x\n');
    git(opened.dir, 'add', '--', 'scores/tester/ok.jsonl', 'top.txt');
    git(opened.dir, 'rm', '-q', '--', 'scores/bob/2026-11.jsonl');

    const finished = await finishDataCheckout({ config, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at });

    expect(finished).toEqual({
      code: 'push_failed',
      message: 'Step "note" staged files outside tester\'s own on teamai-reports, so nothing was published:\n'
        + 'scores/bob/2026-11.jsonl: belongs to bob, not tester\ntop.txt: in no member\'s directory or file\n'
        + 'A step publishes only paths such as scores/tester/… or votes/tester.yaml. Have it stage only those, then run the workflow again.',
    });
    expect(tip()).toBe(before);
  });

  it('refuses a deletion of the member\'s own file', async () => {
    const opened = await openDataCheckout({ config: { ...config, username: 'bob' }, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });
    git(opened.dir, 'rm', '-q', '--', 'scores/bob/2026-11.jsonl');

    const finished = await finishDataCheckout({ config: { ...config, username: 'bob' }, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at });

    expect(finished).toMatchObject({ code: 'push_failed', message: expect.stringContaining('scores/bob/2026-11.jsonl: deleted; a step publishes new and changed files only') });
    expect(onOrigin('scores/bob/2026-11.jsonl')).toBe('{"bob":1}\n');
  });

  it('succeeds with nothing published when the step staged nothing', async () => {
    const before = tip();

    const { finished } = await publish({});

    expect(finished).toEqual({});
    expect(tip()).toBe(before);
  });

  it('leaves the data pending, in an empty directory, with an http team repo', async () => {
    const http: LocalConfig = { ...config, repo: { ...config.repo, kind: 'http' } };
    const opened = await openDataCheckout({ config: http, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });

    expect(opened.at).toEqual({ kind: 'unavailable', reason: 'the team repo is served over http, which has no teamai-reports branch' });
    expect(fs.readdirSync(opened.dir)).toEqual([]);
    expect(await finishDataCheckout({ config: http, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at })).toEqual({
      message: 'Step "note" left its data on this machine, pending: the team repo is served over http, which has no teamai-reports branch. Run teamai score --push to publish it.',
    });
  });

  it('opens offline at the tip this machine last fetched', async () => {
    await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n' });
    const last = tip();
    fs.renameSync(remote, `${remote}.away`);

    const opened = await openDataCheckout({ config, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });

    expect(opened.at).toEqual({ kind: 'checkout', base: last });
    expect(fs.readFileSync(path.join(opened.dir, 'scores', 'tester', '2026-11.jsonl'), 'utf8')).toBe('{"tester":1}\n');
  });

  it('opens at origin\'s tip when this machine\'s checkout of the branch is behind it and another process holds that checkout', async () => {
    await append(NOTES, 'NOTE-ONE');

    const opened = await whileLocked(async () => {
      onAnotherMachine(NOTES, 'NOTE-ONE\nNOTE-TWO\n');
      git(config.repo.localPath, 'fetch', '-q', 'origin', '+refs/heads/teamai-reports:refs/remotes/origin/teamai-reports');
      return openDataCheckout({ config, run: RUN, attempt: ATTEMPT, branch: 'teamai-reports' });
    });

    expect(opened.at).toEqual({ kind: 'checkout', base: tip() });
    expect(fs.readFileSync(path.join(opened.dir, NOTES), 'utf8')).toBe('NOTE-ONE\nNOTE-TWO\n');
  });

  it('opens offline, on a machine that never fetched the branch, on the branch this machine starts, and leaves the data pending', async () => {
    git(config.repo.localPath, 'update-ref', '-d', 'refs/remotes/origin/teamai-reports');
    fs.renameSync(remote, `${remote}.away`);

    const { opened, finished } = await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n' });

    expect(opened.at).toEqual({ kind: 'checkout', base: git(config.repo.localPath, 'rev-parse', 'refs/heads/teamai-reports~1') });
    expect(finished).toMatchObject({ message: expect.stringMatching(/^Step "note" left its data on this machine, pending: .+\. Run teamai score --push to publish it\.$/) });
  });

  it('leaves the data pending when origin changed the file the step staged, and publishes nothing', async () => {
    config = { ...config, username: 'bob' };
    const before = { tip: '' };
    const { finished } = await publish({ 'scores/bob/2026-11.jsonl': '{"bob":2}\n' }, () => {
      const other = path.join(sandbox, 'other');
      git(sandbox, 'clone', '-q', '--branch', 'teamai-reports', remote, other);
      fs.writeFileSync(path.join(other, 'scores', 'bob', '2026-11.jsonl'), '{"bob":3}\n');
      git(other, 'commit', '-qam', 'teammate');
      git(other, 'push', '-q', 'origin', 'teamai-reports');
      before.tip = tip();
    });

    const [kept] = await DataBranches.kept(config, 'teamai-reports');
    expect(finished).toMatchObject({ message: expect.stringMatching(/^Step "note" left its data on this machine: it no longer applies to teamai-reports \(.*scores\/bob\/2026-11\.jsonl.*\)\. /s) });
    expect(finished).toMatchObject({ message: expect.stringContaining(`. To publish it, apply it by hand in a checkout of teamai-reports (git apply --3way ${kept}), resolve any conflict, commit and push, then delete ${kept}.`) });
    expect(onOrigin('scores/bob/2026-11.jsonl')).toBe('{"bob":3}\n');
    expect(tip()).toBe(before.tip);
  });
});

describe('DataBranches.pushPending', () => {
  it('sends the commit a publish left on this machine while origin could not take it', async () => {
    const away = `${remote}.away`;
    const { finished } = await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n' }, () => fs.renameSync(remote, away));

    expect(finished).toMatchObject({ message: expect.stringMatching(/^Step "note" left its data on this machine, pending: .+\. Run teamai score --push to publish it\.$/) });
    fs.renameSync(away, remote);
    expect(onOrigin('scores/tester/2026-11.jsonl')).toBeUndefined();

    const pushed = await DataBranches.pushPending(config);

    expect(pushed).toEqual([{ branch: 'teamai-reports', result: expect.objectContaining({ status: 'published' }) }]);
    expect(onOrigin('scores/tester/2026-11.jsonl')).toBe('{"tester":1}\n');
  });

  it('creates no data branch on origin from a checkout that holds only the commit that started it', async () => {
    git(sandbox, '--git-dir', remote, 'branch', '-D', 'teamai-reports');
    git(config.repo.localPath, 'fetch', '-q', '--prune', 'origin');
    await DataBranches.checkout('teamai-reports').ensure(config, { pushIfCreated: false });

    expect(await DataBranches.pushPending(config)).toEqual([]);
    expect(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'teamai-reports']).status).not.toBe(0);
  });

  it('sends what a publish staged while another teamai process wrote the branch', async () => {
    const lock = path.join(path.dirname(config.repo.localPath), '.reports-lock');
    await DataBranches.checkout('teamai-reports').refresh(config);
    expect(await acquireLock(lock)).toBe(true);
    const { finished } = await publish({ 'standups/tester/2026-11.md': 'Shipped the retry fix.\n' }).finally(() => releaseLock(lock));

    expect(finished).toMatchObject({ message: expect.stringContaining('another teamai process is writing teamai-reports') });
    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin('standups/tester/2026-11.md')).toBe('Shipped the retry fix.\n');
    expect(await DataBranches.sendPending(config)).toEqual([]);
  });

  it('keeps, and names, what a publish staged when origin changed the same file so it no longer applies', async () => {
    config = { ...config, username: 'bob' };
    await publish({ 'scores/bob/2026-11.jsonl': '{"bob":2}\n' }, () => {
      const other = path.join(sandbox, 'other');
      git(sandbox, 'clone', '-q', '--branch', 'teamai-reports', remote, other);
      fs.writeFileSync(path.join(other, 'scores', 'bob', '2026-11.jsonl'), '{"bob":3}\n');
      git(other, 'commit', '-qam', 'teammate');
      git(other, 'push', '-q', 'origin', 'teamai-reports');
    });

    expect(await DataBranches.sendPending(config)).toEqual([{ branch: 'teamai-reports', message: stuckMessage(await DataBranches.kept(config, 'teamai-reports')) }]);
    expect(onOrigin('scores/bob/2026-11.jsonl')).toBe('{"bob":3}\n');
  });

  it('keeps sending nothing twice: labels a later publish put on the branch are not added again from what a busy publish kept', async () => {
    const lock = path.join(path.dirname(config.repo.localPath), '.reports-lock');
    await DataBranches.checkout('teamai-reports').refresh(config);
    expect(await acquireLock(lock)).toBe(true);
    await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n' }).finally(() => releaseLock(lock));
    await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n{"tester":2}\n' });

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin('scores/tester/2026-11.jsonl')).toBe('{"tester":1}\n{"tester":2}\n');
  });

  it('keeps what a busy publish staged to remove a line when origin changed that file so it no longer applies', async () => {
    const lock = path.join(path.dirname(config.repo.localPath), '.reports-lock');
    await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n{"tester":2}\n' });
    expect(await acquireLock(lock)).toBe(true);
    await publish({ 'scores/tester/2026-11.jsonl': '{"tester":1}\n' }).finally(() => releaseLock(lock));
    const other = path.join(sandbox, 'other');
    git(sandbox, 'clone', '-q', '--branch', 'teamai-reports', remote, other);
    fs.writeFileSync(path.join(other, 'scores', 'tester', '2026-11.jsonl'), '{"tester":0}\n{"tester":2}\n');
    git(other, 'commit', '-qam', 'another machine');
    git(other, 'push', '-q', 'origin', 'teamai-reports');

    expect(await DataBranches.sendPending(config)).toEqual([{ branch: 'teamai-reports', message: stuckMessage(await DataBranches.kept(config, 'teamai-reports')) }]);
    expect(onOrigin('scores/tester/2026-11.jsonl')).toBe('{"tester":0}\n{"tester":2}\n');
  });

  it('lands, in order, two notes appended to one file while another teamai process held the branch', async () => {
    await append(NOTES, 'NOTE-ONE');
    await whileLocked(async () => {
      await append(NOTES, 'NOTE-TWO');
      await append(NOTES, 'NOTE-THREE');
    });

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin(NOTES)).toBe('NOTE-ONE\nNOTE-TWO\nNOTE-THREE\n');
  });

  it('lands a note kept while another teamai process held the branch before a later note appended to the same file', async () => {
    await append(NOTES, 'NOTE-ONE');
    await whileLocked(() => append(NOTES, 'NOTE-TWO'));

    expect(await append(NOTES, 'NOTE-THREE')).toEqual({});
    expect(onOrigin(NOTES)).toBe('NOTE-ONE\nNOTE-TWO\nNOTE-THREE\n');
    expect(git(sandbox, '--git-dir', remote, 'log', '-1', '--format=%s', 'teamai-reports')).toBe('[teamai] note: tester');
    expect(await DataBranches.sendPending(config)).toEqual([]);
  });

  it('lands a note appended offline after an earlier one origin could not take, and keeps no patch for what it committed', async () => {
    const away = `${remote}.away`;
    await append(NOTES, 'NOTE-ONE');
    fs.renameSync(remote, away);

    expect(await append(NOTES, 'NOTE-TWO')).toMatchObject({ message: expect.stringMatching(/Run teamai score --push to publish it\.$/) });
    expect(await append(NOTES, 'NOTE-THREE')).toMatchObject({ message: expect.stringMatching(/Run teamai score --push to publish it\.$/) });
    expect(await DataBranches.kept(config, 'teamai-reports')).toEqual([]);
    fs.renameSync(away, remote);

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin(NOTES)).toBe('NOTE-ONE\nNOTE-TWO\nNOTE-THREE\n');
  });

  it('sends the commits a publish left on this machine while a kept patch does not apply', async () => {
    config = { ...config, username: 'bob' };
    await publish({ 'scores/bob/2026-11.jsonl': '{"bob":2}\n' }, () => {
      const other = path.join(sandbox, 'other');
      git(sandbox, 'clone', '-q', '--branch', 'teamai-reports', remote, other);
      fs.writeFileSync(path.join(other, 'scores', 'bob', '2026-11.jsonl'), '{"bob":3}\n');
      git(other, 'commit', '-qam', 'teammate');
      git(other, 'push', '-q', 'origin', 'teamai-reports');
    });
    const away = `${remote}.away`;
    await publish({ 'votes/bob.yaml': 'up: 1\n' }, () => fs.renameSync(remote, away));
    fs.renameSync(away, remote);

    expect(await DataBranches.sendPending(config)).toEqual([{ branch: 'teamai-reports', message: expect.any(String) }]);
    expect(onOrigin('votes/bob.yaml')).toBe('up: 1\n');
    expect(onOrigin('scores/bob/2026-11.jsonl')).toBe('{"bob":3}\n');
  });

  it('appends a note that repeats a line the file holds elsewhere at the end of the file when origin changed the lines it follows', async () => {
    await append(NOTES, 'Mon: fixed CI.');
    await append(NOTES, 'No blockers.');
    await append(NOTES, 'Tue: paired.');
    await whileLocked(() => append(NOTES, 'No blockers.'));
    onAnotherMachine(NOTES, 'Mon: fixed CI.\nNo blockers.\nTue: paired on the flaky test.\n');

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin(NOTES)).toBe('Mon: fixed CI.\nNo blockers.\nTue: paired on the flaky test.\nNo blockers.\n');
    expect(await DataBranches.kept(config, 'teamai-reports')).toEqual([]);
  });

  it('appends a note that adds a second copy of the line it follows at the end of the file when origin changed the lines before it', async () => {
    await append(NOTES, 'Paired on the flaky test.');
    await whileLocked(() => append(NOTES, 'Paired on the flaky test.'));
    onAnotherMachine(NOTES, 'Mon:\nPaired on the flaky test.\n');

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin(NOTES)).toBe('Mon:\nPaired on the flaky test.\nPaired on the flaky test.\n');
    expect(await DataBranches.kept(config, 'teamai-reports')).toEqual([]);
  });

  it('lands both notes two steps opened at once appended to one file', async () => {
    await append(NOTES, 'Mon: fixed CI.');
    const open = async (attempt: string, line: string) => {
      const opened = await openDataCheckout({ config, run: RUN, attempt: attempt as AttemptId, branch: 'teamai-reports' });
      fs.appendFileSync(path.join(opened.dir, NOTES), `${line}\n`);
      git(opened.dir, 'add', '--', NOTES);
      return () => finishDataCheckout({ config, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at });
    };
    const first = await open('b001', 'Tue: paired.');
    const second = await open('b002', 'Wed: shipped.');

    expect(await first()).toEqual({});
    expect(await second()).toEqual({});
    expect(onOrigin(NOTES)).toBe('Mon: fixed CI.\nTue: paired.\nWed: shipped.\n');
    expect(await DataBranches.kept(config, 'teamai-reports')).toEqual([]);
  });

  it('keeps a note whose patch changes a line origin changed too, rather than appending it', async () => {
    await append(NOTES, 'Mon: fixed CI.');
    const opened = await openDataCheckout({ config, run: RUN, attempt: 'c001' as AttemptId, branch: 'teamai-reports' });
    fs.writeFileSync(path.join(opened.dir, NOTES), 'Mon: fixed CI and the flaky test.\n');
    git(opened.dir, 'add', '--', NOTES);
    onAnotherMachine(NOTES, 'Mon: fixed CI on Monday.\n');

    expect(await finishDataCheckout({ config, dir: opened.dir, step: 'note', branch: 'teamai-reports', at: opened.at })).toEqual({ message: expect.stringContaining('git apply --3way') });
    expect(onOrigin(NOTES)).toBe('Mon: fixed CI on Monday.\n');
    expect(await DataBranches.kept(config, 'teamai-reports')).toHaveLength(1);
  });

  it('sends a note later whose commit failed after its patch applied', async () => {
    await append(NOTES, 'Mon: fixed CI.');
    git(config.repo.localPath, 'config', 'commit.gpgsign', 'true');
    git(config.repo.localPath, 'config', 'gpg.program', 'false');
    await append(NOTES, 'Tue: paired.');
    git(config.repo.localPath, 'config', '--unset', 'commit.gpgsign');

    expect(await DataBranches.sendPending(config)).toEqual([]);
    expect(onOrigin(NOTES)).toBe('Mon: fixed CI.\nTue: paired.\n');
    expect(await DataBranches.kept(config, 'teamai-reports')).toEqual([]);
  });

  it('pushes nothing for an http team repo', async () => {
    expect(await DataBranches.pushPending({ ...config, repo: { ...config.repo, kind: 'http' } })).toEqual([]);
  });
});
