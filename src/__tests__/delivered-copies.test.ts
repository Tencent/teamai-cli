import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { classifyCopy, describeKeptDir, judgeRemoval, keepsTrackedCopy, type DeliveredFile } from '../resources/delivered-copies.js';
import { commitTeamRepo } from './helpers/team-repo-history.js';

// #822 item 5: pull keeps a copy only when the record proves teamai wrote
// other bytes there than the member has now.
describe('classifyCopy', () => {
  const file = (disk: string | null, recorded: string | undefined, next: string | null): DeliveredFile => (
    { disk, recorded, next }
  );

  it('writes a copy teamai has no record of', () => {
    expect(classifyCopy([file('mine', undefined, 'team')])).toEqual({ kind: 'write' });
  });

  it('writes an untouched copy, and one already at the team version', () => {
    expect(classifyCopy([file('v1', 'v1', 'v2')])).toEqual({ kind: 'write' });
    expect(classifyCopy([file('v2', 'v1', 'v2')])).toEqual({ kind: 'write' });
  });

  it('writes a copy the member deleted, so pull brings the team version back', () => {
    expect(classifyCopy([file(null, 'v1', 'v1')])).toEqual({ kind: 'write' });
    expect(classifyCopy([file(null, 'v1', 'v1'), file(null, 'x1', 'x2')])).toEqual({ kind: 'write' });
  });

  it('keeps an edited copy and says whether the team version moved since', () => {
    expect(classifyCopy([file('edit', 'v1', 'v1')])).toEqual({ kind: 'keep', teamChanged: false });
    expect(classifyCopy([file('edit', 'v1', 'v2')])).toEqual({ kind: 'keep', teamChanged: true });
  });

  it('keeps a whole skill when one file of it was edited or deleted', () => {
    expect(classifyCopy([file('s1', 's1', 's1'), file('edit', 'x1', 'x1')])).toEqual({ kind: 'keep', teamChanged: false });
    expect(classifyCopy([file('s1', 's1', 's1'), file(null, 'x1', 'x1')])).toEqual({ kind: 'keep', teamChanged: false });
    // A file the team added, or removed, since the last delivery is a team change.
    expect(classifyCopy([file('edit', 's1', 's1'), file(null, undefined, 'new')])).toEqual({ kind: 'keep', teamChanged: true });
    expect(classifyCopy([file('edit', 's1', 's1'), file('old', 'old', null)])).toEqual({ kind: 'keep', teamChanged: true });
  });

  it('keeps nothing without proof: only a recorded file whose bytes are neither the record nor the team version', () => {
    const hash = fc.constantFrom('a', 'b', 'c');
    const files = fc.array(fc.record({
      disk: fc.option(hash, { nil: null }),
      recorded: fc.option(hash, { nil: undefined }),
      next: fc.option(hash, { nil: null }),
    }), { maxLength: 4 });
    fc.assert(fc.property(files, (copy) => {
      const proven = copy.some((f) => f.recorded !== undefined && f.disk !== f.recorded && f.disk !== f.next)
        && copy.some((f) => f.disk !== null);
      expect(classifyCopy(copy).kind).toBe(proven ? 'keep' : 'write');
    }));
  });
});

// #993: a copy of a resource no longer delivered is removed, kept as the
// member's edit, or kept as not teamai's; the caller words each one.
describe('judgeRemoval', () => {
  let root: string;
  let repo: string;
  let copy: string;
  const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
  const origin = (): { repoPath: string; pathspec: string } => ({ repoPath: repo, pathspec: 'rules/r.md' });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-removal-'));
    repo = path.join(root, 'team');
    fs.mkdirSync(path.join(repo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'rules', 'r.md'), 'team v1');
    commitTeamRepo(repo);
    copy = path.join(root, 'r.md');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes a recorded copy the member did not change', async () => {
    fs.writeFileSync(copy, 'team v1');
    expect(await judgeRemoval({ [copy]: sha('team v1') }, copy, origin())).toBe('remove');
  });

  it('keeps a recorded copy the member changed as an edit', async () => {
    fs.writeFileSync(copy, 'mine');
    expect(await judgeRemoval({ [copy]: sha('team v1') }, copy, origin())).toBe('edited');
  });

  it('removes an unrecorded copy that holds a team version', async () => {
    fs.writeFileSync(copy, 'team v1');
    expect(await judgeRemoval({}, copy, origin())).toBe('remove');
  });

  it('keeps an unrecorded copy that holds no team version as not teamai\'s', async () => {
    fs.writeFileSync(copy, 'mine');
    expect(await judgeRemoval({}, copy, origin())).toBe('notTeamais');
  });

  it('keeps it as an edit when another checkout record shows teamai wrote that path', async () => {
    fs.writeFileSync(copy, 'mine');
    expect(await judgeRemoval({}, copy, origin(), { [copy]: sha('team v1') })).toBe('edited');
  });

  it('keeps a link at the path, recorded or not, and never follows it', async () => {
    const target = path.join(root, 'elsewhere.md');
    fs.writeFileSync(target, 'team v1');
    fs.symlinkSync(target, copy);
    expect(await judgeRemoval({}, copy, origin())).toBe('notTeamais');
    expect(await judgeRemoval({ [copy]: sha('team v1') }, copy, origin())).toBe('edited');
  });

  it('keeps a recorded skill directory as an edit when the member replaced a file in it with a link to the same bytes', async () => {
    const skill = path.join(root, 'skill');
    fs.mkdirSync(skill);
    const target = path.join(root, 'elsewhere.md');
    fs.writeFileSync(target, 'team v1');
    fs.symlinkSync(target, path.join(skill, 'SKILL.md'));
    expect(await judgeRemoval({ [path.join(skill, 'SKILL.md')]: sha('team v1') }, skill, origin())).toBe('edited');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps an unrecorded file it cannot read as not teamai\'s', async () => {
    fs.writeFileSync(copy, 'team v1');
    fs.chmodSync(copy, 0o000);
    expect(await judgeRemoval({}, copy, origin())).toBe('notTeamais');
    fs.chmodSync(copy, 0o600);
  });

  it('removes an unrecorded copy when no origin can prove whose it is, as before', async () => {
    fs.writeFileSync(copy, 'mine');
    expect(await judgeRemoval({}, copy)).toBe('remove');
  });
});

// #993: a skill directory remove or uninstall left is named for why it stayed.
describe('describeKeptDir', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-dir-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('names a link, a directory holding a link, and a directory of the member\'s apart', async () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    const link = path.join(root, 'linked');
    fs.symlinkSync(target, link);
    const holding = path.join(root, 'holding');
    fs.mkdirSync(holding);
    fs.symlinkSync(path.join(target, 'x'), path.join(holding, 'x'));
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await describeKeptDir(link, 'skills/a', 'uninstall')).toBe(`Kept ${link}: it is a link of yours, so uninstall left it.`);
    expect(await describeKeptDir(holding, 'skills/a', 'uninstall')).toBe(`Kept ${holding}: it holds a link of yours, so uninstall left it.`);
    expect(await describeKeptDir(plain, 'skills/a', 'uninstall')).toContain('it is not teamai\'s');
  });
});

describe('keepsTrackedCopy (#915)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tracked-copy-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('keeps a copy in a repository git cannot read, and lets one in no repository go', async () => {
    const repo = path.join(tmp, 'repo');
    const copy = path.join(repo, '.claude', 'rules', 'team-rule.md');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'x\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'team');
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'not a ref\n');
    const plain = path.join(tmp, 'plain', 'team-rule.md');
    fs.mkdirSync(path.dirname(plain), { recursive: true });
    fs.writeFileSync(plain, 'x\n');

    expect(await keepsTrackedCopy(copy)).toBe(true);
    expect(await keepsTrackedCopy(plain)).toBe(false);
  });
});
