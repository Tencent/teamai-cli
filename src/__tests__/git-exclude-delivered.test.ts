import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { applyDeliveredGitExclude, createDeliveryRecorder, deliveredUnion, describeForeign, type DeliveryRecorder } from '../git-exclude-delivered.js';
import { checkoutKey, liveDeliveredLists, syncDeliveredGitExclude } from '../pull.js';
import { StateSchema, type LocalConfig } from '../types.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

describe('deliveredUnion', () => {
  const rel = '.claude/rules/team.md';
  let tmp: string;
  let main: string;
  let wt: string;
  // The main checkout lists its delivered copy; the worktree has its own file at that path, not in its list.
  const union = () => deliveredUnion([{ root: main, paths: [path.join(main, rel)] }, { root: wt, paths: [] }]);
  // The exclude file every checkout of the repository shares.
  const exclude = (): string => path.resolve(main, git(main, 'rev-parse', '--git-path', 'info/exclude').trim());

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-delivered-union-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    await fse.outputFile(path.join(main, 'README.md'), 'app\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    await fse.outputFile(path.join(main, rel), 'team\n');
    await fse.outputFile(path.join(wt, rel), 'mine\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmp);
  });

  it('lists a path another checkout\'s own git ignore rule already hides there', async () => {
    await fse.outputFile(path.join(wt, '.gitignore'), '.claude/\n');
    expect(await union()).toEqual({ paths: [path.join(main, rel)], foreign: [] });
  });

  it('lists a path a member\'s line in the shared info/exclude already hides in another checkout', async () => {
    await fse.outputFile(exclude(), `.claude/\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({ paths: [path.join(main, rel)], foreign: [] });
  });

  it('keeps listing a path a member\'s rule for that file hides once teamai\'s delivered block below it lists the path too', async () => {
    const listed = { paths: [path.join(main, rel)], foreign: [] };
    await fse.outputFile(exclude(), `/${rel}\n`);
    expect(await union()).toEqual(listed);
    // The block the pull writes for it; its line now decides for git.
    await fse.outputFile(exclude(), `/${rel}\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(listed);
  });

  it('keeps listing a path the member\'s core.excludesFile hides once teamai\'s delivered block lists the path too', async () => {
    const listed = { paths: [path.join(main, rel)], foreign: [] };
    const globalFile = path.join(tmp, 'global-ignore');
    await fse.outputFile(globalFile, `/${rel}\n`);
    git(main, 'config', 'core.excludesFile', globalFile);
    expect(await union()).toEqual(listed);
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(listed);
  });

  it('holds a path back while the member\'s own rule re-includes another checkout\'s file there, before and after teamai\'s block', async () => {
    const foreign = { paths: [], foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }] };
    await fse.outputFile(exclude(), `!/${rel}\n`);
    expect(await union()).toEqual(foreign);
    await fse.outputFile(exclude(), `!/${rel}\n# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual(foreign);
  });

  it('holds a path back when the other checkout\'s .gitignore re-includes the directory the member\'s core.excludesFile hides', async () => {
    const globalFile = path.join(tmp, 'global-ignore');
    await fse.outputFile(globalFile, '/.claude/\n');
    git(main, 'config', 'core.excludesFile', globalFile);
    await fse.outputFile(path.join(wt, '.gitignore'), '!/.claude/\n');
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back when core.excludesFile is set empty, whatever git\'s default ignore file holds', async () => {
    const xdg = path.join(tmp, 'xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    await fse.outputFile(path.join(xdg, 'git', 'ignore'), `/${rel}\n`);
    git(main, 'config', 'core.excludesFile', '');
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back while another checkout\'s own file there is visible to git', async () => {
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it.skipIf(process.platform === 'win32')('asks git about another checkout\'s file once, however many checkouts list its path', async () => {
    const rels = ['a', 'b', 'c', 'd'].map((name) => `.claude/skills/${name}/SKILL.md`);
    for (const r of rels) await fse.outputFile(path.join(wt, r), 'mine\n');
    const listers = async (count: number) => Promise.all(Array.from({ length: count }, async (_, i) => {
      const root = path.join(tmp, `lister-${count}-${i}`);
      for (const r of rels) await fse.outputFile(path.join(root, r), 'team\n');
      return { root, paths: rels.map((r) => path.join(root, r)) };
    }));
    const log = path.join(tmp, 'git-spawns.log');
    const bin = path.join(tmp, 'bin');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await fse.outputFile(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    const spawnsFor = async (count: number) => {
      const checkouts = [...await listers(count), { root: wt, paths: [] }];
      await fse.remove(log);
      const result = await deliveredUnion(checkouts);
      expect(result.foreign).toHaveLength(count * rels.length);
      return (await fse.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    };
    await spawnsFor(1);

    const one = await spawnsFor(1);
    const six = await spawnsFor(6);

    expect(one).toBeGreaterThan(0);
    expect(six).toBe(one);
  });

  it('holds a path back when only teamai\'s own delivered block ignores the other checkout\'s file', async () => {
    await fse.outputFile(exclude(), `# [teamai:delivered:start]\n/${rel}\n# [teamai:delivered:end]\n`);
    expect(git(wt, 'check-ignore', '--', rel).trim()).toBe(rel);
    expect(await union()).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel) }],
    });
  });

  it('holds a path back while a checkout teamai has no list for holds other bytes there, and names that checkout', async () => {
    const result = await deliveredUnion([{ root: main, paths: [path.join(main, rel)] }, { root: wt, paths: null }]);

    expect(result).toEqual({
      paths: [],
      foreign: [{ path: path.join(main, rel), rel, checkout: wt, file: path.join(wt, rel), unlisted: true }],
    });
    expect(describeForeign(result.foreign)).toEqual([
      `Left ${rel} visible to git in every checkout until \`teamai pull\` runs in ${wt}: teamai has no record yet of what it delivered there, so ${path.join(wt, rel)} may be the member's, and a git exclude line would hide it too.`,
    ]);
    expect(await fse.readFile(path.join(wt, rel), 'utf8')).toBe('mine\n');
  });
});

describe('liveDeliveredLists', () => {
  let tmp: string;
  let main: string;
  let wt: string;

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-live-lists-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    await fse.outputFile(path.join(main, 'README.md'), 'app\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('lists the current checkout once beside records an older release saved without a root', async () => {
    const skill = path.join(main, '.claude/skills/team/SKILL.md');
    // An older release wrote neither `root` nor `gitExcludePaths`.
    const records = { 'old-1': { rev: 'a', targets: ['claude'] }, 'old-2': { rev: 'a', targets: ['claude'] } };

    const lists = await liveDeliveredLists(main, records, { key: 'current', paths: { skills: [skill] } });

    expect(lists).toEqual([{ root: main, paths: [skill] }, { root: wt, paths: null }]);
  });
});

describe('applyDeliveredGitExclude', () => {
  let tmp: string;
  let repo: string;
  let config: LocalConfig;
  const skill = (): string => path.join(repo, '.claude', 'skills', 'fe-skill', 'SKILL.md');
  const deliveredLines = async (): Promise<string[]> => {
    const lines = (await fse.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    return lines.slice(lines.indexOf('# [teamai:delivered:start]') + 1, lines.indexOf('# [teamai:delivered:end]'));
  };
  const status = (): string => git(repo, 'status', '--porcelain', '-uall');

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-apply-delivered-')));
    repo = path.join(tmp, 'repo');
    await fse.outputFile(path.join(repo, 'README.md'), 'app\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    await fse.outputFile(skill(), 'team skill\n');
    config = {
      repo: { localPath: path.join(tmp, 'team'), remote: 'local', kind: 'git' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: repo,
      dataHome: path.join(tmp, 'data'),
    };
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it('keeps every delivered line while git cannot locate a tool folder\'s repository, and says so once', async () => {
    expect(await applyDeliveredGitExclude(config, true, [skill()])).toEqual({ failures: [], notices: [] });
    const lines = await deliveredLines();
    expect(lines).toContain('/.claude/skills/fe-skill/SKILL.md');
    // A tool folder that was a linked checkout or a submodule, its git directory since deleted: git still shows its files here.
    await fse.outputFile(path.join(repo, '.claude', '.git'), `gitdir: ${path.join(repo, 'gone')}\n`);

    const outcome = await applyDeliveredGitExclude(config, true, [skill()]);

    expect(await deliveredLines()).toEqual(lines);
    expect(status()).not.toContain('fe-skill');
    expect(outcome.failures.filter((failure) => failure.startsWith(`Could not keep ${skill()} out of git`))).toHaveLength(1);
  });

  it('fails the sync, naming the rule, when a member\'s negation re-includes a file of a delivered skill', async () => {
    await fse.outputFile(path.join(repo, '.gitignore'), '!*.md\n');

    const outcome = await applyDeliveredGitExclude(config, true, [skill()]);

    expect(await deliveredLines()).toContain('/.claude/skills/fe-skill/SKILL.md');
    expect(outcome.failures).toContain(`git still sees .claude/skills/fe-skill/SKILL.md: \`!*.md\` (${path.join(repo, '.gitignore')}:1) re-includes it. Remove that rule.`);
    expect(status()).toContain('?? .claude/skills/fe-skill/SKILL.md');
  });
});

describe('syncDeliveredGitExclude', () => {
  let tmp: string;
  let main: string;
  const checkout = (name: string): string => path.join(tmp, name);
  const configFor = (projectRoot: string): LocalConfig => ({
    repo: { localPath: path.join(tmp, 'team'), remote: 'local', kind: 'git' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot, dataHome: path.join(tmp, 'data'),
  });
  const exclude = (): string => path.resolve(main, git(main, 'rev-parse', '--git-path', 'info/exclude').trim());
  const deliveredLines = async (): Promise<string[]> => {
    const lines = (await fse.readFile(exclude(), 'utf8')).split('\n');
    return lines.slice(lines.indexOf('# [teamai:delivered:start]') + 1, lines.indexOf('# [teamai:delivered:end]'));
  };
  const rule = '.claude/rules/shared.md';
  const skill = '.claude/skills/review/SKILL.md';

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-sync-delivered-')));
    main = checkout('main');
    await fse.outputFile(path.join(tmp, 'team', 'teamai.yaml'), 'team: t\nrepo: https://example.test/t.git\nsharing:\n  gitExclude:\n    enabled: true\n');
    await fse.outputFile(path.join(main, 'README.md'), 'app\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    // A branch that tracks the rule every checkout is delivered.
    git(main, 'checkout', '-q', '-b', 'tracked');
    await fse.outputFile(path.join(main, rule), 'tracked\n');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'rule');
    git(main, 'checkout', '-q', 'main');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmp);
  });

  it('lists a new checkout\'s lines asking git about that checkout alone while its hook waits, and leaves dropping lines to the full pull after it', async () => {
    const pulled = [main, checkout('wt-1'), checkout('wt-2')];
    for (const root of pulled.slice(1)) git(main, 'worktree', 'add', '-q', '-b', path.basename(root), root);
    const records: Record<string, { rev: string; targets: string[]; root: string; gitExcludePaths: Record<string, string[]> }> = {};
    for (const root of pulled) {
      for (const rel of [rule, skill]) await fse.outputFile(path.join(root, rel), 'team\n');
      records[await checkoutKey(root)] = { rev: 'a', targets: ['claude'], root, gitExcludePaths: { rules: [path.join(root, rule)], skills: [path.join(root, skill)] } };
    }
    await fse.outputFile(exclude(), ['# [teamai:delivered:start]', `/${rule}`, `/${skill}`, '/.claude/rules/gone.md', '# [teamai:delivered:end]', ''].join('\n'));
    const files = { delivered: [exclude()] };
    await saveStateForScope(StateSchema.parse({ lastPullRev: 'a', lastPullByWorkspace: records, gitExcludeFiles: files }), configFor(main));

    // The fourth checkout tracks the rule, and the team added a skill since the others pulled.
    const fresh = checkout('wt-3');
    git(main, 'worktree', 'add', '-q', fresh, 'tracked');
    const added = '.claude/skills/new/SKILL.md';
    for (const rel of [skill, added]) await fse.outputFile(path.join(fresh, rel), 'team\n');
    const recorder = (): DeliveryRecorder => {
      const delivered = createDeliveryRecorder();
      delivered.report('rules', path.join(fresh, rule));
      for (const rel of [skill, added]) delivered.report('skills', path.join(fresh, rel));
      return delivered;
    };
    const bin = path.join(tmp, 'bin');
    const log = path.join(tmp, 'git-calls.log');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await fse.outputFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);

    expect(await syncDeliveredGitExclude(configFor(fresh), recorder(), { silent: true, gitHook: 'post-checkout', gitExcludeAddOnly: true })).toBe(true);
    vi.unstubAllEnvs();
    const listed = (await fse.readFile(log, 'utf8')).split('\n').filter((line) => /\bls-files\b/.test(line));

    expect(listed.map((line) => line.split('\t')[0])).toEqual([fresh, fresh]);
    expect(git(fresh, 'status', '--porcelain', '-uall')).toBe('');
    expect(await deliveredLines()).toEqual([`/${rule}`, `/${skill}`, '/.claude/rules/gone.md', `/${added}`].sort());
    expect((await loadStateForScope(configFor(main))).gitExcludeFiles).toEqual(files);

    expect(await syncDeliveredGitExclude(configFor(fresh), recorder(), { silent: true, gitHook: 'post-checkout' })).toBe(true);

    expect(await deliveredLines()).toEqual([`/${rule}`, `/${skill}`, `/${added}`].sort());
    expect(git(fresh, 'status', '--porcelain', '-uall')).toBe('');
  });
});
