/**
 * E2E (#993 bug 12): ownership of skill directories and docs-mirror files
 * teamai has no delivery record of.
 *
 * A skill directory with no record is teamai's only when every file in it
 * holds that file of the team skill at some revision of the team repo's
 * history (SKILL.md also as pull repairs its frontmatter); one file that does
 * not, the member's own included, makes the directory the member's. The docs
 * mirror keeps no record, so a file there at a team doc's path is teamai's
 * only when it holds some revision of that doc. An older team copy is updated
 * as before; anything else is kept and named, and `doctor` repeats the line.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME).
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
let home: string;
/** Keeps a retried case off the directories its first attempt left. */
let attempt = 0;

function env(): NodeJS.ProcessEnv {
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
  return base;
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function gitOk(args: string[], cwd: string): string {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  return r.output.trim();
}

const teamai = (args: string[], cwd: string): Run => run(process.execPath, [CLI, ...args], cwd);

function teamaiOk(args: string[], cwd: string): Run {
  const r = teamai(args, cwd);
  if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
  return r;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/** A team: the bare remote its synthetic URL reaches, and a way to publish to it. */
interface Team { url: string; seed: string; publish(files: Record<string, string | null>, message: string): void }

function team(base: string, files: Record<string, string>): Team {
  const name = `${base}-${++attempt}`;
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
  return { url, seed, publish };
}

/** A git business repo holding `files` before teamai is set up in it. */
function business(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(sandbox, `${name}-${++attempt}`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return fs.realpathSync.native(dir);
}

function init(t: Team, dir: string): Run {
  const started = teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], dir);
  const pulled = teamaiOk(['pull'], dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
}

const membersLine = (file: string, resource: string): string =>
  `Kept ${file}: it is not teamai's (no delivery record, and it matches no team version of ${resource}). `
  + 'Rename or delete it, then run teamai pull, to receive the team version.';

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;

describe('ownership of unrecorded skills and docs (#993 bug 12)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-ownership-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('keeps a member\'s own skill and doc at a team resource\'s path, names them, and doctor lists them', () => {
    const t = team('own', {
      'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team skill.'),
      'skills/team-skill/scripts/run.sh': 'echo team\n',
      'docs/guide.md': '# Team guide\n',
    });
    const mySkill = skillMd('team-skill', 'MY SKILL');
    const dir = business('own-biz', {
      '.claude/skills/team-skill/SKILL.md': mySkill,
      '.teamai/docs/guide.md': 'MY GUIDE\n',
    });
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');
    const guide = path.join(dir, '.teamai', 'docs', 'guide.md');
    const skillLine = membersLine(skill, 'skills/team-skill');
    const guideLine = membersLine(guide, 'docs/guide.md');

    const initRun = init(t, dir);
    expect(read(path.join(skill, 'SKILL.md'))).toBe(mySkill);
    // The team skill is not written into the member's directory, not even its other files.
    expect(fs.existsSync(path.join(skill, 'scripts', 'run.sh'))).toBe(false);
    expect(read(guide)).toBe('MY GUIDE\n');
    expect(initRun.output).toContain(skillLine);
    expect(initRun.output).toContain(guideLine);

    const forced = teamaiOk(['pull', '--force'], dir);
    expect(read(path.join(skill, 'SKILL.md'))).toBe(mySkill);
    expect(fs.existsSync(path.join(skill, 'scripts', 'run.sh'))).toBe(false);
    expect(read(guide)).toBe('MY GUIDE\n');
    expect(forced.output).toContain(skillLine);
    expect(forced.output).toContain(guideLine);

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain(skillLine);
    expect(doctor.output).toContain(guideLine);

    // As the message says: once the member's files are out of the way, a plain pull delivers the team version.
    fs.renameSync(skill, path.join(dir, '.claude', 'skills', 'my-skill'));
    fs.rmSync(guide);
    const plain = teamaiOk(['pull'], dir);
    expect(read(path.join(skill, 'SKILL.md'))).toBe(skillMd('team-skill', 'Team skill.'));
    expect(read(path.join(skill, 'scripts', 'run.sh'))).toBe('echo team\n');
    expect(read(guide)).toBe('# Team guide\n');
    expect(plain.output).not.toContain('it is not teamai\'s');
  });

  it('updates an older team version of a skill and a doc that has no record, and keeps a skill holding a file of the member\'s', () => {
    // SKILL.md without frontmatter: pull delivers it repaired, and that render is a team version too.
    const t = team('older', {
      'skills/team-skill/SKILL.md': '# Team skill\n\nVersion one.\n',
      'skills/team-skill/scripts/run.sh': 'echo one\n',
      'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other one.'),
      'docs/guide.md': '# Guide v1\n',
    });
    // What an earlier release left: the team's v1 as pull delivered it, with no record in the new checkout.
    const first = business('older-first');
    init(t, first);
    const delivered = (dir: string, ...rel: string[]): string => path.join(dir, '.claude', 'skills', ...rel);
    const renderedV1 = read(delivered(first, 'team-skill', 'SKILL.md'));
    expect(renderedV1).not.toBe('# Team skill\n\nVersion one.\n');

    t.publish({
      'skills/team-skill/SKILL.md': skillMd('team-skill', 'Version two.'),
      'skills/team-skill/scripts/run.sh': 'echo two\n',
      'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other two.'),
      'docs/guide.md': '# Guide v2\n',
    }, 'v2');
    const dir = business('older-biz', {
      '.claude/skills/team-skill/SKILL.md': renderedV1,
      '.claude/skills/team-skill/scripts/run.sh': 'echo one\n',
      '.claude/skills/other-skill/SKILL.md': skillMd('other-skill', 'Other one.'),
      '.claude/skills/other-skill/notes.md': 'my notes\n',
      '.teamai/docs/guide.md': '# Guide v1\n',
    });

    const initRun = init(t, dir);
    expect(read(delivered(dir, 'team-skill', 'SKILL.md'))).toBe(skillMd('team-skill', 'Version two.'));
    expect(read(delivered(dir, 'team-skill', 'scripts', 'run.sh'))).toBe('echo two\n');
    expect(read(path.join(dir, '.teamai', 'docs', 'guide.md'))).toBe('# Guide v2\n');
    // Every file of a skill must be a team version: one of the member's makes the directory theirs.
    expect(read(delivered(dir, 'other-skill', 'SKILL.md'))).toBe(skillMd('other-skill', 'Other one.'));
    expect(read(delivered(dir, 'other-skill', 'notes.md'))).toBe('my notes\n');
    expect(initRun.output).toContain(membersLine(delivered(dir, 'other-skill'), 'skills/other-skill'));
    expect(initRun.output).not.toContain(`Kept ${delivered(dir, 'team-skill')}`);
    expect(initRun.output).not.toContain('docs/guide.md).');
  });

  it('keeps a member\'s own file at a team doc\'s path when the team deletes that doc', () => {
    const t = team('docs-removed', {
      'docs/guide.md': '# Guide\n',
      'docs/gone.md': '# Gone v1\n',
      'docs/old.md': '# Old\n',
    });
    t.publish({ 'docs/gone.md': '# Gone v2\n' }, 'gone v2');
    const dir = business('docs-removed-biz', {
      '.teamai/docs/old.md': 'MY OLD NOTES\n',
      // An unrecorded copy of an earlier team version: teamai's.
      '.teamai/docs/gone.md': '# Gone v1\n',
    });
    const docs = path.join(dir, '.teamai', 'docs');
    init(t, dir);
    expect(read(path.join(docs, 'old.md'))).toBe('MY OLD NOTES\n');
    expect(read(path.join(docs, 'gone.md'))).toBe('# Gone v2\n');
    // A draft at a path the team never had is the member's: it stays, unnamed.
    writeFile(path.join(docs, 'draft.md'), 'draft\n');

    t.publish({ 'docs/old.md': null, 'docs/gone.md': null }, 'remove docs');
    const pulled = teamaiOk(['pull'], dir);

    expect(read(path.join(docs, 'old.md'))).toBe('MY OLD NOTES\n');
    expect(pulled.output).toContain(
      `Kept ${path.join(docs, 'old.md')}: the team removed docs/old.md, but this copy matches no team version of it. Delete it when you no longer need it.`,
    );
    expect(fs.existsSync(path.join(docs, 'gone.md'))).toBe(false);
    expect(read(path.join(docs, 'draft.md'))).toBe('draft\n');
    expect(pulled.output).not.toContain(path.join(docs, 'draft.md'));
    expect(read(path.join(docs, 'guide.md'))).toBe('# Guide\n');
    // Pull keeps it, so doctor does not ask pull --force to remove it.
    expect(teamai(['doctor'], dir).output).not.toContain('Stale docs');
  });

  it('keeps a member\'s link that replaced a team doc when the team deletes that doc, without following it', () => {
    const t = team('docs-link', { 'docs/guide.md': '# Guide\n', 'docs/keep.md': '# Keep\n' });
    const dir = business('docs-link-biz');
    const docs = path.join(dir, '.teamai', 'docs');
    init(t, dir);
    const mine = path.join(sandbox, 'docs-link-mine.md');
    writeFile(mine, 'MY GUIDE\n');
    const link = path.join(docs, 'guide.md');
    fs.rmSync(link);
    fs.symlinkSync(mine, link);

    t.publish({ 'docs/guide.md': null }, 'remove guide');
    const pulled = teamaiOk(['pull'], dir);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(mine)).toBe('MY GUIDE\n');
    expect(pulled.output).toContain(`Kept ${link}: the team removed docs/guide.md`);
  });

  it('uninstall removes teamai\'s docs from the mirror and keeps the member\'s files, directories and links, naming them', () => {
    const t = team('docs-uninstall', { 'docs/guide.md': '# Guide\n', 'docs/sub/deep.md': '# Deep\n', 'docs/old.md': '# Old\n' });
    const dir = business('docs-uninstall-biz');
    const docs = path.join(dir, '.teamai', 'docs');
    init(t, dir);
    t.publish({ 'docs/old.md': null }, 'remove old');
    teamaiOk(['pull'], dir);
    // At a removed doc's path, at paths the team never had, and a link to a file of the member's.
    writeFile(path.join(docs, 'old.md'), 'MY OLD NOTES\n');
    writeFile(path.join(docs, 'notes.md'), 'MY NOTES\n');
    writeFile(path.join(docs, 'mine', 'draft.md'), 'MY DRAFT\n');
    const external = path.join(sandbox, `docs-uninstall-${attempt}.md`);
    writeFile(external, '# Guide\n');
    fs.symlinkSync(external, path.join(docs, 'linked.md'));

    const uninstalled = teamaiOk(['uninstall', '--force'], dir);

    expect(fs.existsSync(path.join(docs, 'guide.md')), uninstalled.output).toBe(false);
    expect(fs.existsSync(path.join(docs, 'sub'))).toBe(false);
    expect(read(path.join(docs, 'old.md'))).toBe('MY OLD NOTES\n');
    expect(read(path.join(docs, 'notes.md'))).toBe('MY NOTES\n');
    expect(read(path.join(docs, 'mine', 'draft.md'))).toBe('MY DRAFT\n');
    expect(fs.lstatSync(path.join(docs, 'linked.md')).isSymbolicLink()).toBe(true);
    expect(read(external)).toBe('# Guide\n');
    expect(uninstalled.output).toContain(`Kept ${path.join(docs, 'old.md')}: it is not teamai's (no delivery record, `
      + 'and it matches no team version of docs/old.md), so uninstall left it.');
  });

  it('keeps a member\'s directory holding a link where the team deleted a doc file, without following it', () => {
    const t = team('docs-dir-link', { 'docs/guide': '# Guide file\n', 'docs/keep.md': '# Keep\n' });
    const dir = business('docs-dir-link-biz');
    const docs = path.join(dir, '.teamai', 'docs');
    init(t, dir);
    const mine = path.join(sandbox, 'docs-dir-link-mine.md');
    writeFile(mine, 'MY NOTES\n');
    fs.rmSync(path.join(docs, 'guide'));
    fs.mkdirSync(path.join(docs, 'guide'));
    const link = path.join(docs, 'guide', 'personal.md');
    fs.symlinkSync(mine, link);

    t.publish({ 'docs/guide': null }, 'remove guide');
    teamaiOk(['pull'], dir);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(mine)).toBe('MY NOTES\n');
  });

  it('keeps a member\'s skill directory holding a link at a team skill\'s path, and never writes through the link', () => {
    const t = team('skill-link', { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.') });
    const external = path.join(sandbox, 'skill-link-mine.md');
    writeFile(external, skillMd('team-skill', 'Team.'));
    const dir = business('skill-link-biz', { '.claude/skills/.keep': '' });
    const skillDir = path.join(dir, '.claude', 'skills', 'team-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(external, path.join(skillDir, 'SKILL.md'));
    t.publish({ 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team v2.') }, 'v2');

    const initRun = init(t, dir);
    expect(fs.lstatSync(path.join(skillDir, 'SKILL.md')).isSymbolicLink()).toBe(true);
    expect(read(external)).toBe(skillMd('team-skill', 'Team.'));
    // Named by the link itself (#993).
    expect(initRun.output).toContain(`Kept ${path.join(skillDir, 'SKILL.md')}: it is a link of yours, so teamai does not replace it.`);
  });

  it('uninstall keeps hidden files of the member\'s in the docs mirror, even when nothing else of theirs is there', () => {
    const t = team('docs-hidden', { 'docs/guide.md': '# Guide\n' });
    const dir = business('docs-hidden-biz');
    const docs = path.join(dir, '.teamai', 'docs');
    init(t, dir);
    writeFile(path.join(docs, '.draft'), 'MY HIDDEN DRAFT\n');
    writeFile(path.join(docs, 'sub', '.notes'), 'MY HIDDEN NOTES\n');

    const uninstalled = teamaiOk(['uninstall', '--force'], dir);

    expect(fs.existsSync(path.join(docs, 'guide.md'))).toBe(false);
    expect(read(path.join(docs, '.draft'))).toBe('MY HIDDEN DRAFT\n');
    expect(read(path.join(docs, 'sub', '.notes'))).toBe('MY HIDDEN NOTES\n');
    expect(uninstalled.output).toContain(`Kept ${path.join(docs, '.draft')}`);
  });

  it('keeps a member\'s link in place of a team skill directory through pull, remove and uninstall, and names it', () => {
    const t = team('skill-leaf-link', { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.') });
    const mine = path.join(sandbox, 'skill-leaf-link-mine');
    writeFile(path.join(mine, 'SKILL.md'), skillMd('team-skill', 'Team.'));
    const dir = business('skill-leaf-link-biz', { '.claude/skills/.keep': '' });
    const link = path.join(dir, '.claude', 'skills', 'team-skill');
    fs.symlinkSync(mine, link, 'dir');

    const initRun = init(t, dir);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(initRun.output).toContain(
      `Kept ${link}: it is a link of yours, so teamai does not replace it. Remove the link to receive skills/team-skill from the team.`,
    );
    teamai(['remove', 'skills', 'team-skill', '--force'], dir);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    teamai(['uninstall', '--force'], dir);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(path.join(mine, 'SKILL.md'))).toBe(skillMd('team-skill', 'Team.'));
  });

  it('keeps a delivered skill directory holding a file the member added, through remove, uninstall and a team removal', () => {
    const files = { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.'), 'skills/gone-skill/SKILL.md': skillMd('gone-skill', 'Gone.') };
    const t = team('skill-extra-file', files);
    const dir = business('skill-extra-file-biz', { '.claude/skills/.keep': '' });
    init(t, dir);
    const teamSkill = path.join(dir, '.claude', 'skills', 'team-skill');
    const goneSkill = path.join(dir, '.claude', 'skills', 'gone-skill');
    writeFile(path.join(teamSkill, 'notes.md'), 'MY NOTES\n');
    writeFile(path.join(goneSkill, 'notes.md'), 'MY GONE NOTES\n');

    // The team removes a skill: the copy holding the member's file stays.
    t.publish({ 'skills/gone-skill/SKILL.md': null, 'skills/.removed': 'gone-skill\n' }, 'remove gone-skill');
    teamaiOk(['pull'], dir);
    expect(read(path.join(goneSkill, 'notes.md'))).toBe('MY GONE NOTES\n');

    // remove takes teamai's files and leaves the member's, naming it.
    const removed = teamai(['remove', 'skills', 'team-skill', '--force'], dir);
    expect(read(path.join(teamSkill, 'notes.md'))).toBe('MY NOTES\n');
    expect(fs.existsSync(path.join(teamSkill, 'SKILL.md'))).toBe(false);
    expect(removed.output).toContain(`Kept ${path.join(teamSkill, 'notes.md')}`);
  });

  it('uninstall takes teamai\'s files from a delivered skill and leaves the file the member added', () => {
    const t = team('skill-extra-uninstall', { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.') });
    const dir = business('skill-extra-uninstall-biz', { '.claude/skills/.keep': '' });
    init(t, dir);
    const teamSkill = path.join(dir, '.claude', 'skills', 'team-skill');
    writeFile(path.join(teamSkill, 'notes.md'), 'MY NOTES\n');

    const uninstalled = teamaiOk(['uninstall', '--force'], dir);
    expect(read(path.join(teamSkill, 'notes.md'))).toBe('MY NOTES\n');
    expect(fs.existsSync(path.join(teamSkill, 'SKILL.md'))).toBe(false);
    expect(uninstalled.output).toContain(`Kept ${path.join(teamSkill, 'notes.md')}`);
  });

  it('treats a CONTRIBUTORS file the member put in a delivered skill as theirs, through remove and uninstall', () => {
    const t = team('skill-contributors', {
      'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.'),
      'skills/other-skill/SKILL.md': skillMd('other-skill', 'Other.'),
    });
    const dir = business('skill-contributors-biz', { '.claude/skills/.keep': '' });
    init(t, dir);
    const teamSkill = path.join(dir, '.claude', 'skills', 'team-skill');
    const otherSkill = path.join(dir, '.claude', 'skills', 'other-skill');
    writeFile(path.join(teamSkill, 'CONTRIBUTORS'), 'me\n');
    writeFile(path.join(otherSkill, 'CONTRIBUTORS'), 'me too\n');

    teamai(['remove', 'skills', 'team-skill', '--force'], dir);
    expect(read(path.join(teamSkill, 'CONTRIBUTORS'))).toBe('me\n');
    expect(fs.existsSync(path.join(teamSkill, 'SKILL.md'))).toBe(false);
    teamaiOk(['uninstall', '--force'], dir);
    expect(read(path.join(otherSkill, 'CONTRIBUTORS'))).toBe('me too\n');
    expect(fs.existsSync(path.join(otherSkill, 'SKILL.md'))).toBe(false);
  });

  it('keeps a file the member added to a delivered skill when the team later adds one at that path', () => {
    const t = team('skill-new-path', { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.') });
    const dir = business('skill-new-path-biz', { '.claude/skills/.keep': '' });
    init(t, dir);
    const notes = path.join(dir, '.claude', 'skills', 'team-skill', 'notes.md');
    writeFile(notes, 'MY NOTES\n');
    t.publish({ 'skills/team-skill/notes.md': 'TEAM NOTES\n' }, 'add notes');
    const pulled = teamaiOk(['pull'], dir);
    expect(read(notes)).toBe('MY NOTES\n');
    expect(pulled.output).toContain(`Kept ${path.dirname(notes)}`);
  });

  it('leaves undelivered only the files a member\'s entry of the other type blocks, and delivers them once it is gone', () => {
    const t = team('skill-new-path-type', { 'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team.') });
    const dir = business('skill-new-path-type-biz', { '.claude/skills/.keep': '' });
    init(t, dir);
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');
    writeFile(path.join(skill, 'assets', 'mine.txt'), 'MINE\n');
    writeFile(path.join(skill, 'docs'), 'MY DOCS\n');
    t.publish({
      'skills/team-skill/SKILL.md': skillMd('team-skill', 'Team, v2.'),
      'skills/team-skill/assets': 'TEAM ASSETS\n',
      'skills/team-skill/docs/guide.md': 'TEAM GUIDE\n',
    }, 'add files');

    const pulled = teamaiOk(['pull'], dir);
    expect(read(path.join(skill, 'assets', 'mine.txt'))).toBe('MINE\n');
    expect(read(path.join(skill, 'docs'))).toBe('MY DOCS\n');
    expect(pulled.output).toContain(`Kept ${path.join(skill, 'assets')}: it is not teamai's`);
    expect(pulled.output).toContain(`Kept ${path.join(skill, 'docs')}: it is not teamai's`);
    // The rest of the skill is delivered.
    expect(read(path.join(skill, 'SKILL.md'))).toContain('Team, v2.');

    fs.rmSync(path.join(skill, 'assets'), { recursive: true });
    fs.rmSync(path.join(skill, 'docs'));
    teamaiOk(['pull'], dir);
    expect(read(path.join(skill, 'assets'))).toBe('TEAM ASSETS\n');
    expect(read(path.join(skill, 'docs', 'guide.md'))).toBe('TEAM GUIDE\n');
  });

  it('keeps a member\'s own doc with the bytes of a team doc that is a link', () => {
    const t = team('doc-link-bytes', { 'docs/content.md': '# Shared\n' });
    fs.symlinkSync('content.md', path.join(t.seed, 'docs', 'guide.md'));
    t.publish({}, 'link guide');
    const dir = business('doc-link-bytes-biz', { '.teamai/docs/guide.md': '# Shared\n' });
    const guide = path.join(dir, '.teamai', 'docs', 'guide.md');

    const first = init(t, dir);
    expect(fs.lstatSync(guide).isSymbolicLink(), first.output).toBe(false);
    expect(read(guide)).toBe('# Shared\n');
    expect(first.output).toContain(membersLine(guide, 'docs/guide.md'));
  });

  it('keeps a member\'s file of a deactivated docs namespace with the bytes of a team doc that is a link', () => {
    const roles = [
      'version: 1', 'roles:',
      '  - id: frontend', '    resources:', '      knowledge: []', '      skills: []', '      docs: [frontend]',
      '  - id: backend', '    resources:', '      knowledge: []', '      skills: []', '      docs: [backend]', '',
    ].join('\n');
    const t = team('ns-link-bytes', {
      'manifest/roles.yaml': roles, 'docs/frontend/target.md': '# Shared\n', 'docs/backend/b.md': '# B\n',
    });
    fs.symlinkSync('target.md', path.join(t.seed, 'docs', 'frontend', 'linked.md'));
    t.publish({}, 'link');
    const dir = business('ns-link-bytes-biz');
    teamaiOk(['init', t.url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force', '--role', 'frontend'], dir);
    teamaiOk(['pull'], dir);
    const linked = path.join(dir, '.teamai', 'docs', 'frontend', 'linked.md');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    // The member replaces the delivered link with a file of their own holding the same text.
    fs.rmSync(linked);
    writeFile(linked, '# Shared\n');

    teamaiOk(['roles', 'set', 'backend'], dir);
    const pulled = teamaiOk(['pull'], dir);
    expect(read(linked)).toBe('# Shared\n');
    expect(pulled.output).toContain('frontend/linked.md');
  });

  it('never writes through or deletes behind a docs mirror that is a link of the member\'s', () => {
    const t = team('docs-root-link', { 'docs/guide.md': '# Guide\n', 'docs/extra.md': '# Extra\n' });
    const dir = business('docs-root-link-biz');
    init(t, dir);
    const mirror = path.join(dir, '.teamai', 'docs');
    // The member points the mirror at a directory of their own, holding a file equal to a team doc.
    const personal = path.join(sandbox, `personal-docs-${attempt}`);
    writeFile(path.join(personal, 'guide.md'), '# Guide\n');
    fs.rmSync(mirror, { recursive: true });
    fs.symlinkSync(personal, mirror);

    const pulled = teamaiOk(['pull', '--force'], dir);
    expect(fs.readdirSync(personal)).toEqual(['guide.md']);
    const uninstalled = teamaiOk(['uninstall', '--force'], dir);
    expect(fs.existsSync(path.join(personal, 'guide.md')), uninstalled.output).toBe(true);
    expect(read(path.join(personal, 'guide.md'))).toBe('# Guide\n');
    expect(fs.lstatSync(mirror).isSymbolicLink()).toBe(true);
    expect(pulled.output).toContain(`Kept ${mirror}: it is a link of yours`);
    expect(uninstalled.output).toContain(`Kept ${mirror}: it is a link of yours`);
  });

  it('names a docs mirror that is a link without walking it, also when the team has no docs and on a dry run', () => {
    const t = team('docs-root-link-empty', { 'docs/guide.md': '# Guide\n' });
    const dir = business('docs-root-link-empty-biz');
    init(t, dir);
    t.publish({ 'docs/guide.md': null }, 'no docs');
    const mirror = path.join(dir, '.teamai', 'docs');
    // A personal tree with a directory nothing may read.
    const personal = path.join(sandbox, `personal-tree-${attempt}`);
    const locked = path.join(personal, 'private');
    writeFile(path.join(locked, 'secret.md'), 'mine\n');
    fs.rmSync(mirror, { recursive: true });
    fs.symlinkSync(personal, mirror);
    fs.chmodSync(locked, 0o000);
    try {
      const dry = teamaiOk(['pull', '--dry-run'], dir);
      expect(dry.output).toContain(`Kept ${mirror}: it is a link of yours`);
      const pulled = teamaiOk(['pull'], dir);
      expect(pulled.output).toContain(`Kept ${mirror}: it is a link of yours`);
      expect(pulled.output).not.toContain('Failed to sync docs');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('keeps a recorded skill the member edited whole, as before', () => {
    const t = team('edited', {
      'skills/team-skill/SKILL.md': skillMd('team-skill', 'Version one.'),
      'skills/team-skill/scripts/run.sh': 'echo one\n',
    });
    const dir = business('edited-biz');
    init(t, dir);
    const skill = path.join(dir, '.claude', 'skills', 'team-skill');
    fs.appendFileSync(path.join(skill, 'SKILL.md'), 'member edit\n');
    t.publish({ 'skills/team-skill/scripts/run.sh': 'echo two\n' }, 'v2');

    const pulled = teamaiOk(['pull'], dir);
    expect(read(path.join(skill, 'SKILL.md'))).toBe(`${skillMd('team-skill', 'Version one.')}member edit\n`);
    // Kept whole: not even the file the member did not touch is updated.
    expect(read(path.join(skill, 'scripts', 'run.sh'))).toBe('echo one\n');
    expect(pulled.output).toContain(`Kept ${skill}: you changed it`);
    expect(pulled.output).not.toContain('it is not teamai\'s');
  });

  it('removes an unrecorded copy of a skill the team removed only when it is a team version', () => {
    const t = team('removed', {
      'skills/gone-skill/SKILL.md': skillMd('gone-skill', 'Gone.'),
      'skills/old-skill/SKILL.md': skillMd('old-skill', 'Old.'),
      'skills/kept-skill/SKILL.md': skillMd('kept-skill', 'Kept.'),
    });
    t.publish({ 'skills/gone-skill': null, 'skills/old-skill': null, 'skills/.removed': 'gone-skill\nold-skill\n' }, 'remove');
    const dir = business('removed-biz', {
      '.claude/skills/gone-skill/SKILL.md': skillMd('gone-skill', 'Gone.'),
      '.claude/skills/old-skill/SKILL.md': skillMd('old-skill', 'MY OLD SKILL'),
    });

    const initRun = init(t, dir);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'gone-skill'))).toBe(false);
    const old = path.join(dir, '.claude', 'skills', 'old-skill');
    expect(read(path.join(old, 'SKILL.md'))).toBe(skillMd('old-skill', 'MY OLD SKILL'));
    // The member's own copy is named as not teamai's, not as an edit of a teamai copy.
    expect(initRun.output).toContain(`Kept ${old}: it is not teamai's (no delivery record, and it matches no team version of skills/old-skill), so pull left it.`);
  });
});
