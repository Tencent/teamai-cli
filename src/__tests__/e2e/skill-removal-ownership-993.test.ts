/**
 * E2E (#993): teamai deletes a skill directory only when it is teamai's: a
 * file under it is on the checkout's delivery record, every file in it is a
 * version of that team skill from the team repo's history, or it holds a
 * CLI built-in's name. A member's own skill that shares a team skill's name
 * stays, and the command that left it names it:
 *
 * - pull's sweep of namespace-nested copies of a skill the member excluded;
 * - `teamai remove skills <name>` in each tool's skills directory;
 * - `teamai uninstall` in each tool's skills directory.
 *
 * Each case gets its own HOME and team remote: a local bare repo reached
 * through a synthetic HTTPS URL (`url.<path>.insteadOf` in that HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
/** Keeps a retried case off the directories its first attempt left. */
let attempt = 0;

function env(home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  delete base.CODEX_HOME;
  return base;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;
const MY_SKILL = '---\nname: fe-skill\ndescription: my own skill\n---\nMY OWN CONTENT\n';
const TEAM = {
  'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Team skill.'),
  'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other skill.'),
};
const notTeamais = (dir: string, command: string): string =>
  `Kept ${dir}: it is not teamai's (no delivery record, and it matches no team version of skills/fe-skill), so ${command} left it.`;

/** One member's machine: a HOME with Claude Code and Codex installed, a team remote, and a business repo. */
interface Machine {
  dir: string;
  run(args: string[]): Run;
  ok(args: string[]): Run;
}

function machine(base: string, files: Record<string, string>, businessFiles: Record<string, string>): Machine {
  const name = `${base}-${++attempt}`;
  const home = path.join(sandbox, `${name}-home`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): void => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  };
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [`team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', ''].join('\n'));
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

  const dir = path.join(sandbox, `${name}-biz`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(businessFiles)) writeFile(path.join(dir, rel), content);
  const realDir = fs.realpathSync.native(dir);

  const teamai = (args: string[]): Run => run(process.execPath, [CLI, ...args], realDir);
  const ok = (args: string[]): Run => {
    const r = teamai(args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  ok(['init', url, '--provider', 'git', '--agent', 'claude,codex', '--scope', 'project', '--force']);
  ok(['pull']);
  return { dir: realDir, run: teamai, ok };
}

describe('teamai deletes only its own skill directories (#993)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-removal-e2e-')));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pull removes an earlier release\'s nested copy of an excluded skill, and keeps the member\'s own skill of that name', () => {
    const m = machine('nested', TEAM, {
      // What an earlier release left: the team skill nested under a namespace.
      '.claude/skills/old-ns/fe-skill/SKILL.md': TEAM['skills/fe-skill/SKILL.md'],
      // The member's own skill, in a folder of their own, with the team skill's name.
      '.claude/skills/my-ns/fe-skill/SKILL.md': MY_SKILL,
    });
    m.ok(['skill', 'exclude', 'add', 'fe-skill']);
    const pulled = m.ok(['pull', '--force']);
    expect(fs.existsSync(path.join(m.dir, '.claude', 'skills', 'old-ns', 'fe-skill')), pulled.output).toBe(false);
    expect(read(path.join(m.dir, '.claude', 'skills', 'my-ns', 'fe-skill', 'SKILL.md'))).toBe(MY_SKILL);
  });

  it('teamai remove deletes teamai\'s copies of the skill and keeps the member\'s own, naming it', () => {
    const m = machine('remove', TEAM, { '.claude/skills/fe-skill/SKILL.md': MY_SKILL });
    const mine = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    const codex = path.join(m.dir, '.codex', 'skills', 'fe-skill');
    expect(read(path.join(codex, 'SKILL.md'))).toBe(TEAM['skills/fe-skill/SKILL.md']);

    const removed = m.ok(['remove', 'skills', 'fe-skill', '--force']);
    expect(fs.existsSync(codex), removed.output).toBe(false);
    expect(read(path.join(mine, 'SKILL.md'))).toBe(MY_SKILL);
    expect(removed.output).toContain(notTeamais(mine, 'remove'));
  });

  it('keeps a member\'s link inside a delivered skill through pull, remove and uninstall, and a link at a built-in\'s name', () => {
    // A team skill with a CLI built-in's name, which teamai remove reaches.
    const m = machine('links', { ...TEAM, 'skills/team-wiki-codebase/SKILL.md': skillMd('team-wiki-codebase', 'Team wiki.') }, {});
    const codex = path.join(m.dir, '.codex', 'skills', 'fe-skill');
    const claude = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    // The member points a delivered file at one of their own, with the same bytes.
    const linkTargets = [codex, claude].map((dir, i) => {
      const target = path.join(sandbox, `links-${attempt}-${i}-SKILL.md`);
      writeFile(target, read(path.join(dir, 'SKILL.md')));
      fs.rmSync(path.join(dir, 'SKILL.md'));
      fs.symlinkSync(target, path.join(dir, 'SKILL.md'));
      return target;
    });
    // A link of theirs at a CLI built-in skill's name.
    const builtinTarget = path.join(sandbox, `links-${attempt}-builtin`);
    writeFile(path.join(builtinTarget, 'SKILL.md'), '---\nname: team-wiki-codebase\ndescription: mine\n---\nMine.\n');
    const builtinLink = path.join(m.dir, '.claude', 'skills', 'team-wiki-codebase');
    fs.rmSync(builtinLink, { recursive: true, force: true });
    fs.symlinkSync(builtinTarget, builtinLink);

    const pulled = m.ok(['pull', '--force']);
    expect(fs.lstatSync(path.join(codex, 'SKILL.md')).isSymbolicLink(), pulled.output).toBe(true);
    expect(pulled.output).toContain(`Kept ${path.join(codex, 'SKILL.md')}: it is a link of yours, so teamai does not replace it.`);

    const removedBuiltin = m.ok(['remove', 'skills', 'team-wiki-codebase', '--force']);
    expect(fs.lstatSync(builtinLink).isSymbolicLink(), removedBuiltin.output).toBe(true);

    const removed = m.ok(['remove', 'skills', 'fe-skill', '--force']);
    expect(fs.lstatSync(path.join(codex, 'SKILL.md')).isSymbolicLink(), removed.output).toBe(true);

    const uninstalled = m.ok(['uninstall', '--force']);
    expect(fs.lstatSync(path.join(claude, 'SKILL.md')).isSymbolicLink(), uninstalled.output).toBe(true);
    expect(fs.lstatSync(builtinLink).isSymbolicLink()).toBe(true);
    for (const target of linkTargets) expect(read(target)).toBe(TEAM['skills/fe-skill/SKILL.md']);
  });

  it('teamai remove and uninstall keep a git repository the member made inside a delivered skill', () => {
    const m = machine('skill-git', TEAM, {});
    const claude = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    const codex = path.join(m.dir, '.codex', 'skills', 'fe-skill');
    const git = (args: string[], cwd: string): void => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
    };
    for (const skill of [claude, codex]) {
      git(['init', '-q', '-b', 'main'], skill);
      git(['add', '-A'], skill);
      git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'my local work'], skill);
    }

    m.ok(['remove', 'skills', 'fe-skill', '--force']);
    expect(fs.existsSync(path.join(claude, '.git', 'HEAD'))).toBe(true);
    m.ok(['uninstall', '--force']);
    expect(fs.existsSync(path.join(codex, '.git', 'HEAD'))).toBe(true);
  });

  it('teamai remove of a built-in skill deletes its packaged files and keeps a file the member added', () => {
    const m = machine('builtin-notes', { ...TEAM, 'skills/team-wiki-codebase/SKILL.md': skillMd('team-wiki-codebase', 'Team wiki.') }, {});
    const builtin = path.join(m.dir, '.claude', 'skills', 'team-wiki-codebase');
    expect(fs.existsSync(path.join(builtin, 'SKILL.md'))).toBe(true);
    writeFile(path.join(builtin, 'notes.md'), 'My notes.\n');

    const removed = m.ok(['remove', 'skills', 'team-wiki-codebase', '--force']);
    expect(read(path.join(builtin, 'notes.md')), removed.output).toBe('My notes.\n');
    expect(fs.existsSync(path.join(builtin, 'SKILL.md'))).toBe(false);
    expect(removed.output).toContain(`Kept ${builtin}`);
  });

  it('teamai uninstall deletes teamai\'s copies of team skills and keeps the member\'s own, naming it', () => {
    const m = machine('uninstall', TEAM, { '.claude/skills/fe-skill/SKILL.md': MY_SKILL });
    const mine = path.join(m.dir, '.claude', 'skills', 'fe-skill');
    const codex = path.join(m.dir, '.codex', 'skills', 'fe-skill');
    const other = path.join(m.dir, '.claude', 'skills', 'other-skill');
    expect(fs.existsSync(other)).toBe(true);

    const uninstalled = m.ok(['uninstall', '--force']);
    expect(fs.existsSync(codex), uninstalled.output).toBe(false);
    expect(fs.existsSync(other), uninstalled.output).toBe(false);
    expect(read(path.join(mine, 'SKILL.md'))).toBe(MY_SKILL);
    expect(uninstalled.output).toContain(notTeamais(mine, 'uninstall'));
  });
});
