/**
 * E2E (#993 bug 3): Codex reads skills from both `.codex/skills` and the
 * shared `.agents/skills`, which other tools and the member write to as well.
 * teamai delivers a team skill into `.agents/skills/<name>` only when the copy
 * there is teamai's: on record, or a version of that team skill from the team
 * repo's history. Otherwise the copy is the member's: teamai leaves it alone,
 * delivers to `.codex/skills/<name>`, and names the conflict on every full
 * pull. `teamai remove` and `teamai uninstall` delete only teamai's copy.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME), and its
 * own HOME, as user scope writes there.
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
const conflictLine = (name: string): string =>
  `Codex skill conflict for ${name}: .agents/skills/${name} is not teamai's, so it was left alone; `
  + `the team skill is in .codex/skills/${name}. Codex now sees two skills named ${name}.`;

/** One member's machine: a HOME with Codex installed, and a team remote it reaches. */
interface Machine {
  home: string;
  url: string;
  run(args: string[], cwd: string): Run;
  ok(args: string[], cwd: string): Run;
  publish(files: Record<string, string | null>, message: string): void;
  /** A git business repo holding `files` before teamai is set up in it. */
  business(files?: Record<string, string>): string;
}

function machine(base: string, files: Record<string, string>): Machine {
  const name = `${base}-${++attempt}`;
  const home = path.join(sandbox, `${name}-home`);
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
  gitOk(['init', '-q', '-b', 'main'], seed);
  const publish = (next: Record<string, string | null>, message: string): void => {
    for (const [rel, content] of Object.entries(next)) {
      if (content === null) fs.rmSync(path.join(seed, rel), { recursive: true, force: true });
      else writeFile(path.join(seed, rel), content);
    }
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', message], seed);
    if (fs.existsSync(remote)) gitOk(['push', '-q', remote, 'main'], seed);
  };
  publish(files, 'seed');
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  const teamai = (args: string[], cwd: string): Run => run(process.execPath, [CLI, ...args], cwd);
  return {
    home,
    url,
    run: teamai,
    ok: (args, cwd) => {
      const r = teamai(args, cwd);
      if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
      return r;
    },
    publish,
    business: (extra = {}) => {
      const dir = path.join(sandbox, `${name}-biz`);
      writeFile(path.join(dir, 'README.md'), '# app\n');
      gitOk(['init', '-q', '-b', 'main'], dir);
      gitOk(['add', '-A'], dir);
      gitOk(['commit', '-q', '-m', 'app'], dir);
      for (const [rel, content] of Object.entries(extra)) writeFile(path.join(dir, rel), content);
      return fs.realpathSync.native(dir);
    },
  };
}

const initArgs = (m: Machine, scope: 'project' | 'user'): string[] =>
  ['init', m.url, '--provider', 'git', '--agent', 'codex', '--scope', scope, '--force'];

/** Init no longer copies skills. Deliver them the way the old closing pull did. */
const deliver = (m: Machine, scope: 'project' | 'user', dir: string): Run => {
  const started = m.ok(initArgs(m, scope), dir);
  const pulled = m.ok(['pull'], dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
};

const TEAM = {
  'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Team skill.'),
  'skills/fe-skill/scripts/run.sh': 'echo team\n',
};

describe('Codex skills in the shared .agents/skills directory (#993 bug 3)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-shared-e2e-')));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('leaves the member\'s skill that was there before init, delivers to .codex/skills, and remove deletes only teamai\'s copy', () => {
    const m = machine('before', TEAM);
    const dir = m.business({ '.agents/skills/fe-skill/SKILL.md': MY_SKILL });
    const shared = path.join(dir, '.agents', 'skills', 'fe-skill');
    const codex = path.join(dir, '.codex', 'skills', 'fe-skill');

    const initRun = deliver(m, 'project', dir);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
    expect(fs.readdirSync(shared)).toEqual(['SKILL.md']);
    expect(read(path.join(codex, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Team skill.'));
    expect(read(path.join(codex, 'scripts', 'run.sh'))).toBe('echo team\n');
    expect(initRun.output).toContain(conflictLine('fe-skill'));
    expect(initRun.output).not.toContain('keeping different copies');

    // Every full pull names the conflict while both copies exist.
    const forced = m.ok(['pull', '--force'], dir);
    expect(forced.output).toContain(conflictLine('fe-skill'));
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);

    // doctor checks the copy teamai delivered, not the member's.
    const doctor = m.run(['doctor'], dir);
    expect(doctor.output).not.toMatch(/Skills delivered to codex[^\n]*\n[^\n]*(not delivered|not teamai's)/);
    expect(doctor.output).not.toContain(`Kept ${shared}`);

    const removed = m.ok(['remove', 'skills', 'fe-skill', '--force'], dir);
    expect(fs.existsSync(codex), removed.output).toBe(false);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
  });

  it('leaves the member\'s skill created after delivery on pull --force, and uninstall deletes only teamai\'s copy', () => {
    const m = machine('after', TEAM);
    const dir = m.business();
    const shared = path.join(dir, '.agents', 'skills', 'fe-skill');
    const codex = path.join(dir, '.codex', 'skills', 'fe-skill');
    deliver(m, 'project', dir);
    expect(read(path.join(codex, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Team skill.'));

    writeFile(path.join(shared, 'SKILL.md'), MY_SKILL);
    const forced = m.ok(['pull', '--force'], dir);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
    expect(fs.readdirSync(shared)).toEqual(['SKILL.md']);
    expect(read(path.join(codex, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Team skill.'));
    expect(forced.output).toContain(conflictLine('fe-skill'));

    const uninstalled = m.ok(['uninstall', '--force'], dir);
    expect(fs.existsSync(codex), uninstalled.output).toBe(false);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
  });

  it('keeps delivering into .agents/skills a copy that is teamai\'s, deduplicating an identical .codex/skills copy, and updates it in place', () => {
    const m = machine('teamais', TEAM);
    // What an earlier release left: the team skill as pull delivers it, in both
    // Codex directories, with no record in this checkout.
    const dir = m.business({
      '.agents/skills/fe-skill/SKILL.md': TEAM['skills/fe-skill/SKILL.md'],
      '.agents/skills/fe-skill/scripts/run.sh': TEAM['skills/fe-skill/scripts/run.sh'],
      '.codex/skills/fe-skill/SKILL.md': TEAM['skills/fe-skill/SKILL.md'],
      '.codex/skills/fe-skill/scripts/run.sh': TEAM['skills/fe-skill/scripts/run.sh'],
    });
    const shared = path.join(dir, '.agents', 'skills', 'fe-skill');
    const codex = path.join(dir, '.codex', 'skills', 'fe-skill');

    const initRun = deliver(m, 'project', dir);
    expect(fs.existsSync(codex)).toBe(false);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Team skill.'));
    expect(initRun.output).not.toContain('Codex skill conflict');

    m.publish({
      'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Version two.'),
      'skills/fe-skill/scripts/run.sh': 'echo two\n',
    }, 'v2');
    const pulled = m.ok(['pull'], dir);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Version two.'));
    expect(read(path.join(shared, 'scripts', 'run.sh'))).toBe('echo two\n');
    expect(fs.existsSync(codex)).toBe(false);
    expect(pulled.output).not.toContain('Codex skill conflict');
    expect(pulled.output).not.toContain('new: fe-skill');

    // teamai's copy in the shared directory is the one uninstall deletes.
    m.ok(['uninstall', '--force'], dir);
    expect(fs.existsSync(shared)).toBe(false);
  });

  it('updates in place an unrecorded older team copy in .agents/skills, with no copy in .codex/skills', () => {
    const m = machine('older', TEAM);
    m.publish({
      'skills/fe-skill/SKILL.md': skillMd('fe-skill', 'Version two.'),
      'skills/fe-skill/scripts/run.sh': 'echo two\n',
    }, 'v2');
    // What an earlier release left in the shared directory: the team's first version, with no record.
    const dir = m.business({
      '.agents/skills/fe-skill/SKILL.md': TEAM['skills/fe-skill/SKILL.md'],
      '.agents/skills/fe-skill/scripts/run.sh': TEAM['skills/fe-skill/scripts/run.sh'],
    });
    const shared = path.join(dir, '.agents', 'skills', 'fe-skill');

    const initRun = deliver(m, 'project', dir);

    expect(read(path.join(shared, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Version two.'));
    expect(read(path.join(shared, 'scripts', 'run.sh'))).toBe('echo two\n');
    expect(fs.existsSync(path.join(dir, '.codex', 'skills', 'fe-skill'))).toBe(false);
    expect(initRun.output).not.toContain('Codex skill conflict');
    expect(initRun.output).not.toContain('not teamai\'s');
  });

  it('protects the member\'s skill in ~/.agents/skills in user scope', () => {
    const m = machine('user', TEAM);
    const shared = path.join(m.home, '.agents', 'skills', 'fe-skill');
    const codex = path.join(m.home, '.codex', 'skills', 'fe-skill');
    writeFile(path.join(shared, 'SKILL.md'), MY_SKILL);

    const initRun = deliver(m, 'user', m.home);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
    expect(fs.readdirSync(shared)).toEqual(['SKILL.md']);
    expect(read(path.join(codex, 'SKILL.md'))).toBe(skillMd('fe-skill', 'Team skill.'));
    expect(initRun.output).toContain(conflictLine('fe-skill'));

    const uninstalled = m.ok(['uninstall', '--force'], m.home);
    expect(fs.existsSync(codex), uninstalled.output).toBe(false);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(MY_SKILL);
  });
});
