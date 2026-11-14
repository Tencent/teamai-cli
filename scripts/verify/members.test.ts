import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addMember, ensureOrigin, memberLayout, setupBaseline } from './members.js';
import { gitconfigText, TEAM_URL, type World } from './world.js';
import { parseTarget } from './target.js';

const RUN = '20261112T113044-479be0';

describe('a run id with a member', () => {
  it('names the world alone, or one member of it after @', () => {
    expect(parseTarget(RUN)).toEqual({ runId: RUN, target: { kind: 'world' } });
    expect(parseTarget(`${RUN}@bob`)).toEqual({ runId: RUN, target: { kind: 'member', name: 'bob' } });
  });

  it('refuses a member name a path or a container name could not hold', () => {
    for (const name of ['', 'Bob', '../x', 'a b', 'abcdefghijklm', '-bob']) expect(() => parseTarget(`${RUN}@${name}`)).toThrow(/member name/);
  });
});

describe("a member's layout", () => {
  it('keeps its HOME and clone under the world, and its TMPDIR beside the world\'s, named after the run and the member', () => {
    expect(memberLayout({ dir: `/w/${RUN}`, runId: RUN }, { name: 'bob', tmpRoot: '/private/tmp' })).toEqual({
      root: `/w/${RUN}/members/bob`,
      home: `/w/${RUN}/members/bob/home`,
      project: `/w/${RUN}/members/bob/project`,
      writers: `/w/${RUN}/members/bob/writers.json`,
      tmp: `/private/tmp/teamai-verify-${RUN}-bob`,
    });
  });
});

describe("the harness's own setup", () => {
  it('moves into the baseline only what it changed itself, so what teamai changed before or meanwhile stays a change', () => {
    const baseline = { 'home/.gitconfig': 'a', 'project/.git/config': 'git config', 'project/.git/config#core.bare': 'false' };
    const before = { ...baseline, 'home/.teamai/state.json': 'teamai-wrote', 'project/.git/config#teamai.x': '1' };
    // A command of the world that ran beside the setup wrote the last two.
    const after = { ...before, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1', 'home/.teamai/state.json': 'teamai-wrote-again', 'project/.git/config#teamai.y': '2' };

    expect(setupBaseline(baseline, before, after)).toEqual({ ...baseline, 'home/.gitconfig': 'b', 'project/.git/config#remote.origin.url': 'https://teamai.test/world/project.git', 'project/.git/refs/remotes/origin/main': 'c1' });
  });

  it('drops from the baseline what its setup removed', () => {
    const kept = { 'home/.gitconfig': 'git config', 'project/.git/refs/remotes/origin/main': 'c1' };

    expect(setupBaseline(kept, kept, { 'home/.gitconfig': 'git config' })).toEqual({ 'home/.gitconfig': 'git config' });
  });
});

describe('a cleaned world', () => {
  const cleaned: World = {
    runId: RUN, dir: `/nonexistent/${RUN}`, project: `/nonexistent/${RUN}/project`, team: `/nonexistent/${RUN}/team.git`, home: `/nonexistent/${RUN}/home`, tmp: `/nonexistent/${RUN}/tmp`,
    logs: `/nonexistent/${RUN}/logs`, bin: `/nonexistent/${RUN}/bin`, build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' },
    createdAt: '2026-11-12T11:30:44.000Z', baseline: { teamRefs: {}, checkoutStatus: [] }, env: {}, cleanedAt: '2026-11-12T12:00:00.000Z',
  };

  it('gets no origin and no member, and says to make a new world', () => {
    expect(() => ensureOrigin(cleaned)).toThrow(`World ${RUN} was cleaned up at 2026-11-12T12:00:00.000Z. Make a new one.`);
    expect(() => addMember(cleaned, { name: 'bob' })).toThrow(`World ${RUN} was cleaned up at 2026-11-12T12:00:00.000Z. Make a new one.`);
  });
});

describe("a world's origin", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A world with a project of one commit and a ~/.gitconfig with one setting of the member's own. */
  function originWorld() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'world-origin-')));
    roots.push(dir);
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' };
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    // As `sh <run> git config --global alias.co checkout` leaves it.
    fs.writeFileSync(path.join(home, '.gitconfig'), `${gitconfigText({ name: 'TeamAI World', email: 'world@teamai.test', urls: [{ repo: path.join(dir, 'team.git'), url: TEAM_URL }] })}[alias]\n\tco = checkout\n`);
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: project, env });
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'base'], { cwd: project, env });
    const world: World = {
      runId: RUN, dir, project, team: path.join(dir, 'team.git'), home, tmp: path.join(dir, 'tmp'), logs: path.join(dir, 'logs'), bin: path.join(dir, 'bin'),
      build: { commit: 'c', dirty: false, version: '0.0.0', tarball: 't.tgz', sha256: 's', node: 'v20' }, createdAt: '2026-11-12T11:30:44.000Z',
      baseline: { teamRefs: {}, checkoutStatus: [] }, env,
    };
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(world));

    return { world, env, project, dir };
  }

  it("keeps every setting already in the world HOME's ~/.gitconfig", () => {
    const { world, env, project } = originWorld();

    ensureOrigin(world);

    expect(execFileSync('git', ['config', '--global', 'alias.co'], { env, encoding: 'utf8' }).trim()).toBe('checkout');
    expect(execFileSync('git', ['ls-remote', 'origin', 'main'], { cwd: project, env, encoding: 'utf8' })).toMatch(/refs\/heads\/main/);
  });

  it('leaves alone the origin another command of the world is making, and says so', () => {
    const { world, env, project, dir } = originWorld();
    const bare = path.join(dir, 'origin.git');
    // Another `origin` or `member` of this world, halfway through: its bare repository and remote are there, world.json says nothing yet.
    execFileSync('git', ['init', '--quiet', '--bare', bare], { env });
    execFileSync('git', ['remote', 'add', 'origin', 'https://teamai.test/world/project.git'], { cwd: project, env });

    expect(() => ensureOrigin(world)).toThrow('Another command of the world is giving it its origin');
    expect(fs.existsSync(path.join(bare, 'HEAD'))).toBe(true);
    expect(execFileSync('git', ['remote'], { cwd: project, env, encoding: 'utf8' }).trim()).toBe('origin');
  });

  it('leaves alone the member another command of the world is adding under the same name, and says so', () => {
    const { world, dir } = originWorld();
    const withOrigin = ensureOrigin(world);
    // Another `member <run> bob`, halfway through its clone: its folder is there, world.json says nothing yet.
    const theirs = path.join(dir, 'members', 'bob', 'project', 'cloning');
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, '');

    expect(() => addMember(withOrigin, { name: 'bob' })).toThrow('Another command of the world is adding member bob');
    expect(fs.existsSync(theirs)).toBe(true);
  });
});
