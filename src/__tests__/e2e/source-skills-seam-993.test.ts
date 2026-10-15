import { execFileSync } from 'node:child_process';
/**
 * E2E (#993 bug 8): skills from a team's `sources:` go where the team's own
 * skills go. They resolve through the team-skill seam (the agent-exclusion
 * check, the tool's skills directory, then Codex's shared-destination rule),
 * so Hermes and OpenClaw receive them in their homes, a tool the member did
 * not enable receives nothing, and nothing lands in the project's `.hermes/`
 * or `.openclaw/`. Copies an earlier release left there are reclaimed when
 * they are a version of the source skill, and kept and named otherwise.
 *
 * Ownership (bugs 3 and 12, for source skills): the installation's source
 * manifest is the delivery record. An existing destination with no record is
 * the source's only when it is the source skill as pulled now or a version of
 * it in the source repo's history; otherwise it is the member's and is kept.
 *
 * Every case gets its own sandbox: a HOME with global git config isolated,
 * and local bare repos reached through synthetic HTTPS URLs
 * (`url.<path>.insteadOf` in that HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TeamaiConfigSchema } from '../../types.js';

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
let attempt = 0;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;

const SOURCE_SKILL = skillMd('other-skill', 'Source skill.');
const TEAM_SKILL = skillMd('fe-skill', 'Team skill.');
const MINE = '---\nname: other-skill\ndescription: my own\n---\nMY OWN CONTENT\n';

const keptLegacyLine = (file: string): string =>
  `Kept ${file}: teamai no longer delivers source skills here, and this copy differs from other/other-skill. `
  + 'Delete it when you no longer need it.';
const conflictLine = (name: string): string =>
  `Codex skill conflict for ${name}: .agents/skills/${name} is not teamai's, so it was left alone; `
  + `the team skill is in .codex/skills/${name}. Codex now sees two skills named ${name}.`;

/** One member's machine: a HOME, a team remote subscribing to one source remote. */
interface World {
  home: string;
  teamUrl: string;
  sourceCache: string;
  ok(args: string[], cwd: string): Run;
  run(args: string[], cwd: string): Run;
  business(label: string, files?: Record<string, string>): string;
  /** This installation's source manifest: the one recording `destinationRoot`. */
  manifestPath(destinationRoot: string): string;
  /** Commit `files` (null deletes) to the source repo and push them to its remote. */
  publishSource(files: Record<string, string | null>): void;
}

function world(base: string): World {
  const name = `${base}-${++attempt}`;
  const root = path.join(sandbox, name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_WORKSPACE_DIR', 'COPILOT_HOME']) delete env[key];
  const exec = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): void => {
    const r = exec('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  };
  const remote = (label: string, files: Record<string, string>): string => {
    const url = `https://git.example.com/${label}/${name}.git`;
    const seed = path.join(root, `${label}-seed`);
    const bare = path.join(root, `${label}.git`);
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content.replaceAll('$URL', url));
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'seed'], seed);
    gitOk(['clone', '-q', '--bare', seed, bare], root);
    gitOk(['config', '--global', `url.${bare}.insteadOf`, url], root);
    return url;
  };
  const sourceUrl = remote('source', {
    'teamai.yaml': ['team: other', 'repo: $URL', 'provider: git', 'reviewers: []', 'publicSkills:', '  - other-skill', ''].join('\n'),
    'skills/other-skill/SKILL.md': SOURCE_SKILL,
  });
  const teamUrl = remote('team', {
    'teamai.yaml': ['team: consumer', 'repo: $URL', 'provider: git', 'reviewers: []', 'sources:', '  - name: other', `    repo: ${sourceUrl}`, ''].join('\n'),
    'skills/fe-skill/SKILL.md': TEAM_SKILL,
  });
  const teamai = (args: string[], cwd: string): Run => exec(process.execPath, [CLI, ...args], cwd);
  return {
    home,
    teamUrl,
    sourceCache: path.join(home, '.teamai', 'source-repos', createHash('sha256').update(sourceUrl).digest('hex'), 'repo'),
    run: teamai,
    ok: (args, cwd) => {
      const r = teamai(args, cwd);
      if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
      return r;
    },
    business: (label, files = {}) => {
      const dir = path.join(root, label);
      writeFile(path.join(dir, 'README.md'), '# app\n');
      gitOk(['init', '-q', '-b', 'main'], dir);
      gitOk(['add', '-A'], dir);
      gitOk(['commit', '-q', '-m', 'app'], dir);
      for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
      return fs.realpathSync.native(dir);
    },
    publishSource: (files) => {
      const seed = path.join(root, 'source-seed');
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) fs.rmSync(path.join(seed, rel), { recursive: true, force: true });
        else writeFile(path.join(seed, rel), content);
      }
      gitOk(['add', '-A'], seed);
      gitOk(['commit', '-q', '-m', 'update'], seed);
      gitOk(['push', '-q', path.join(root, 'source.git'), 'main'], seed);
    },
    manifestPath: (destinationRoot) => {
      const dir = path.join(home, '.teamai', 'sources', 'other', 'installations');
      const found = fs.readdirSync(dir).map((file) => path.join(dir, file))
        .filter((file) => JSON.parse(read(file)).destinationRoot === destinationRoot);
      expect(found).toHaveLength(1);
      return found[0]!;
    },
  };
}

const init = (w: World, agents: string[], scope: 'project' | 'user' = 'project'): string[] =>
  ['init', w.teamUrl, '--provider', 'git', '--agent', agents.join(','), '--scope', scope, '--force'];

/** Init no longer copies team resources. Deliver them the way a later pull does. */
const deliver = (w: World, agents: string[], dir: string, scope: 'project' | 'user' = 'project'): Run => {
  const started = w.ok(init(w, agents, scope), dir);
  const pulled = w.ok(['pull'], dir);
  return { ...pulled, output: `${started.output}${pulled.output}` };
};

/** Every file under `dir`, none when it is missing. */
const filesUnder = (dir: string): string[] => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name)
  : []);

/** The parent directory of every `<name>/SKILL.md` teamai delivered, outside its own caches. */
function landings(roots: string[], name: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === '.teamai') continue;
      const child = path.join(dir, entry.name);
      if (entry.name === name && fs.existsSync(path.join(child, 'SKILL.md'))) found.add(dir);
      else walk(child);
    }
  };
  for (const r of roots) walk(r);
  return [...found].sort();
}

describe('source skills go where team skills go (#993 bug 8)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-seam-e2e-')));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers to the Hermes home and OpenClaw workspace, never into the project, and only to enabled tools', () => {
    const w = world('homes');
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.openclaw', 'workspace'), { recursive: true });
    const dir = w.business('biz', { '.claude/.keep': '' });

    deliver(w, ['claude', 'hermes', 'openclaw'], dir);
    for (const skills of [
      path.join(w.home, '.hermes', 'skills'),
      path.join(w.home, '.openclaw', 'workspace', 'skills'),
      path.join(dir, '.claude', 'skills'),
    ]) {
      expect(read(path.join(skills, 'fe-skill', 'SKILL.md'))).toBe(TEAM_SKILL);
      expect(read(path.join(skills, 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);
    }
    // init creates the enabled tools' (empty) roots; no file lands in them.
    expect(filesUnder(path.join(dir, '.hermes'))).toEqual([]);
    expect(filesUnder(path.join(dir, '.openclaw'))).toEqual([]);

    // A tool directory that exists but is not enabled receives nothing.
    fs.mkdirSync(path.join(dir, '.cursor'));
    const second = w.ok(['pull', '--force'], dir);
    expect(second.output).not.toContain('Pull failed');
    expect(fs.existsSync(path.join(dir, '.cursor', 'skills'))).toBe(false);
    expect(filesUnder(path.join(dir, '.hermes'))).toEqual([]);
    expect(read(path.join(w.home, '.hermes', 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    // The HOME copies are this installation's: removing the source deletes them.
    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(removed.output).toContain('Removed source "other"');
    expect(fs.existsSync(path.join(w.home, '.hermes', 'skills', 'other-skill'))).toBe(false);
    expect(fs.existsSync(path.join(w.home, '.openclaw', 'workspace', 'skills', 'other-skill'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'other-skill'))).toBe(false);
  });

  it('two projects on the same source: removing it from one keeps the HOME copy the other still lists', () => {
    const w = world('two');
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true });
    const first = w.business('first', { '.claude/.keep': '' });
    const second = w.business('second', { '.claude/.keep': '' });
    const shared = path.join(w.home, '.hermes', 'skills', 'other-skill');
    deliver(w, ['claude', 'hermes'], first);
    deliver(w, ['claude', 'hermes'], second);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(SOURCE_SKILL);

    const removed = w.ok(['source', 'remove', 'other'], first);
    expect(removed.output).toContain('Removed source "other"');
    expect(removed.output).toContain(`Kept "${shared}" because another source installation owns it`);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(SOURCE_SKILL);
    expect(fs.existsSync(path.join(first, '.claude', 'skills', 'other-skill'))).toBe(false);

    // The other project still pulls, and its removal releases the last claim.
    w.ok(['pull', '--force'], second);
    expect(read(path.join(shared, 'SKILL.md'))).toBe(SOURCE_SKILL);
    w.ok(['source', 'remove', 'other'], second);
    expect(fs.existsSync(shared)).toBe(false);
  });

  it('reclaims what an earlier release left in the project: an unchanged copy goes, a changed one is kept and named', () => {
    const w = world('legacy');
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.openclaw', 'workspace'), { recursive: true });
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude', 'hermes', 'openclaw'], dir);

    // An earlier release copied the source skill into the project's
    // `.hermes/skills` and `.openclaw/skills` and recorded both.
    const hermesCopy = path.join(dir, '.hermes', 'skills', 'other-skill');
    const openclawCopy = path.join(dir, '.openclaw', 'skills', 'other-skill');
    writeFile(path.join(hermesCopy, 'SKILL.md'), SOURCE_SKILL);
    writeFile(path.join(openclawCopy, 'SKILL.md'), `${SOURCE_SKILL}\nMy notes.\n`);
    const manifestPath = w.manifestPath(dir);
    const manifest = JSON.parse(read(manifestPath));
    for (const [rel, abs] of [['.hermes/skills/other-skill', hermesCopy], ['.openclaw/skills/other-skill', openclawCopy]]) {
      manifest.installedPaths['other-skill'].push(rel);
      manifest.installedPhysicalPaths[rel] = abs;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const pulled = w.ok(['pull', '--force'], dir);
    expect(fs.existsSync(hermesCopy)).toBe(false);
    expect(read(path.join(openclawCopy, 'SKILL.md'))).toBe(`${SOURCE_SKILL}\nMy notes.\n`);
    expect(pulled.output).toContain(keptLegacyLine(openclawCopy));
    expect(read(path.join(w.home, '.hermes', 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    // Named on every pull until the member deletes it; then nothing is left.
    expect(w.ok(['pull', '--force'], dir).output).toContain(keptLegacyLine(openclawCopy));
    fs.rmSync(openclawCopy, { recursive: true });
    expect(w.ok(['pull', '--force'], dir).output).not.toContain('teamai no longer delivers source skills here');
    expect(Object.values(JSON.parse(read(manifestPath)).installedPaths).flat()).not.toContain('.openclaw/skills/other-skill');
  });

  it('delivers to the OpenClaw workspace in user scope', () => {
    const w = world('user');
    fs.mkdirSync(path.join(w.home, '.openclaw', 'workspace'), { recursive: true });
    deliver(w, ['openclaw'], w.home, 'user');
    const workspace = path.join(w.home, '.openclaw', 'workspace', 'skills');
    expect(read(path.join(workspace, 'fe-skill', 'SKILL.md'))).toBe(TEAM_SKILL);
    expect(read(path.join(workspace, 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);
    expect(fs.existsSync(path.join(w.home, '.openclaw', 'skills'))).toBe(false);
    w.ok(['pull', '--force'], w.home);
    expect(fs.existsSync(path.join(w.home, '.openclaw', 'skills'))).toBe(false);
  });

  it('keeps pulling after a custom OpenClaw workspace outside ~/.openclaw is removed', () => {
    const w = world('ows');
    const workspace = path.join(path.dirname(w.home), 'custom-ows');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(w.home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(w.home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace } } }));
    deliver(w, ['openclaw'], w.home, 'user');
    expect(read(path.join(workspace, 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    fs.rmSync(workspace, { recursive: true });
    w.publishSource({ 'skills/other-skill/SKILL.md': `${SOURCE_SKILL}v2\n` });
    const pulled = w.run(['pull', '--force'], w.home);
    expect(pulled.output).not.toContain('Invalid source ownership record');
    expect(pulled.code).toBe(0);
    const removed = w.run(['source', 'remove', 'other'], w.home);
    expect(removed.output).not.toContain('Invalid source ownership record');
    expect(removed.code).toBe(0);
  });

  it('keeps pulling after OpenClaw is configured to another workspace, and leaves the copy in the old one', () => {
    const w = world('ows-moved');
    const first = path.join(path.dirname(w.home), 'ows-a');
    const second = path.join(path.dirname(w.home), 'ows-b');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const config = path.join(w.home, '.openclaw', 'openclaw.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace: first } } }));
    deliver(w, ['openclaw'], w.home, 'user');
    expect(read(path.join(first, 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    fs.writeFileSync(config, JSON.stringify({ agents: { defaults: { workspace: second } } }));
    const pulled = w.run(['pull', '--force'], w.home);
    expect(pulled.output).not.toContain('Invalid source ownership record');
    expect(pulled.code).toBe(0);
    expect(read(path.join(second, 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);
    expect(read(path.join(first, 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    const removed = w.run(['source', 'remove', 'other'], w.home);
    expect(removed.code).toBe(0);
    expect(fs.existsSync(path.join(second, 'skills', 'other-skill'))).toBe(false);
    expect(read(path.join(first, 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);
  });

  it('source remove keeps a member\'s file at the path of a link the source has, which delivery skipped', () => {
    const w = world('source-link-path');
    const dir = w.business('biz', { '.claude/.keep': '' });
    // The source skill holds a link; delivery never copies it.
    const seed = path.join(path.dirname(w.home), 'source-seed');
    fs.symlinkSync('SKILL.md', path.join(seed, 'skills', 'other-skill', 'linked.md'));
    w.publishSource({});
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    expect(fs.existsSync(path.join(copy, 'linked.md'))).toBe(false);
    writeFile(path.join(copy, 'linked.md'), 'MY FILE\n');

    w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'linked.md'))).toBe('MY FILE\n');
  });

  it('keeps a delivered source skill when the source later adds a directory where the member has a file', () => {
    const w = world('source-new-dir');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    writeFile(path.join(copy, 'notes'), 'MY NOTES\n');
    w.publishSource({ 'skills/other-skill/notes/info.md': 'SOURCE INFO\n' });
    const pulled = w.ok(['pull', '--force'], dir);
    expect(read(path.join(copy, 'notes'))).toBe('MY NOTES\n');
    expect(pulled.output).toContain(`Kept ${copy}: notes there is yours`);
  });

  it('keeps a file the member added to a delivered source skill when the source later adds one at that path', () => {
    const w = world('source-new-path');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    writeFile(path.join(copy, 'notes.md'), 'MY NOTES\n');
    w.publishSource({ 'skills/other-skill/notes.md': 'SOURCE NOTES\n' });
    const pulled = w.ok(['pull', '--force'], dir);
    expect(read(path.join(copy, 'notes.md'))).toBe('MY NOTES\n');
    expect(pulled.output).toContain(`Kept ${copy}: notes.md there is yours`);

    // Still on the record: source remove judges the copy rather than forget it.
    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'notes.md'))).toBe('MY NOTES\n');
    expect(removed.output).toContain(`Kept ${copy}: it holds notes.md, a file of yours`);
  });

  it('source remove keeps a delivered source skill directory holding a file the member added', () => {
    const w = world('extra-file');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    expect(read(path.join(copy, 'SKILL.md'))).toBe(SOURCE_SKILL);
    writeFile(path.join(copy, 'notes.md'), 'MY NOTES\n');

    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'notes.md'))).toBe('MY NOTES\n');
    expect(removed.output).toContain(`Kept ${copy}: it holds notes.md, a file of yours`);
  });

  it('source remove keeps a delivered source skill whose every file the member edited', () => {
    const w = world('all-edited');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    writeFile(path.join(copy, 'SKILL.md'), `${SOURCE_SKILL}\nMy own notes.\n`);

    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'SKILL.md'))).toBe(`${SOURCE_SKILL}\nMy own notes.\n`);
    expect(removed.output).toContain(`Kept ${copy}: it holds SKILL.md, a file of yours`);
  });

  it('source remove keeps a delivered source skill directory left holding only a file the member added', () => {
    const w = world('only-member-file');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude'], dir);
    const copy = path.join(dir, '.claude', 'skills', 'other-skill');
    fs.rmSync(path.join(copy, 'SKILL.md'));
    writeFile(path.join(copy, 'notes.md'), 'MY NOTES\n');

    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'notes.md'))).toBe('MY NOTES\n');
    expect(removed.output).toContain(`Kept ${copy}: it holds notes.md, a file of yours`);
  });

  it('puts the source skill in the same directory as the team skill for every built-in tool', () => {
    const w = world('all');
    const toolPaths = TeamaiConfigSchema.parse({ team: 't', repo: 'r' }).toolPaths;
    const tools = Object.keys(toolPaths).filter((tool) => toolPaths[tool]!.skills);
    const files: Record<string, string> = {
      // Teamai's copies in Codex's shared directory: both kinds stay there.
      '.agents/skills/fe-skill/SKILL.md': TEAM_SKILL,
      '.agents/skills/other-skill/SKILL.md': SOURCE_SKILL,
    };
    for (const tool of tools) {
      if (tool === 'hermes' || tool === 'openclaw' || tool === 'copilot') continue;
      const probe = tool === 'workbuddy' ? '.workbuddy' : toolPaths[tool]!.skills!.split('/')[0]!;
      files[`${probe}/.keep`] = '';
    }
    const dir = w.business('biz', files);
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.openclaw', 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(w.home, '.copilot'), { recursive: true });

    deliver(w, tools, dir);
    const team = landings([dir, w.home], 'fe-skill');
    const source = landings([dir, w.home], 'other-skill');
    expect(source).toEqual(team);
    expect(team).toEqual(expect.arrayContaining([
      path.join(dir, '.agents', 'skills'),
      path.join(dir, '.github', 'skills'),
      path.join(w.home, '.hermes', 'skills'),
      path.join(w.home, '.openclaw', 'workspace', 'skills'),
    ]));
    expect(team).not.toContain(path.join(dir, '.codex', 'skills'));
  });

  it('keeps the member\'s own skill: an unrecorded copy that is no version of the source skill', () => {
    const w = world('member');
    const dir = w.business('biz', {
      '.claude/skills/other-skill/SKILL.md': MINE,
      '.agents/skills/other-skill/SKILL.md': MINE,
      '.codex/.keep': '',
      // An earlier copy of the source skill, without a record, is the source's.
      '.cursor/skills/other-skill/SKILL.md': SOURCE_SKILL,
    });
    const claude = path.join(dir, '.claude', 'skills', 'other-skill');

    const initRun = deliver(w, ['claude', 'codex', 'cursor'], dir);
    expect(read(path.join(claude, 'SKILL.md'))).toBe(MINE);
    // A source repo has no team version: the line names the source's.
    expect(initRun.output).toContain(`Kept ${claude}: it is not teamai's (no delivery record, and it matches no source version of other/other-skill). `
      + 'Rename or delete it, then run teamai pull, to receive the source version.');
    expect(read(path.join(dir, '.agents', 'skills', 'other-skill', 'SKILL.md'))).toBe(MINE);
    expect(read(path.join(dir, '.codex', 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);
    expect(initRun.output).toContain(conflictLine('other-skill'));
    expect(read(path.join(dir, '.cursor', 'skills', 'other-skill', 'SKILL.md'))).toBe(SOURCE_SKILL);

    // Still the member's on the next pull, and `source remove` leaves it.
    const pulled = w.ok(['pull', '--force'], dir);
    expect(pulled.output).toContain(`Kept ${claude}: it is not teamai's`);
    expect(pulled.output).toContain(conflictLine('other-skill'));
    w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(claude, 'SKILL.md'))).toBe(MINE);
    expect(read(path.join(dir, '.agents', 'skills', 'other-skill', 'SKILL.md'))).toBe(MINE);
    expect(fs.existsSync(path.join(dir, '.codex', 'skills', 'other-skill'))).toBe(false);
  });

  it('with a source cache that has no history, never reads an enclosing repository\'s history', () => {
    const w = world('enclosing');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude', 'codebuddy'], dir);
    fs.rmSync(path.join(w.sourceCache, '.git'), { recursive: true });
    // HOME is a dotfiles repository whose history holds the member's version at the cache's path.
    const cached = path.join(w.sourceCache, 'skills', 'other-skill', 'SKILL.md');
    const today = read(cached);
    writeFile(cached, MINE);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: w.home });
    execFileSync('git', ['add', '-A', path.relative(w.home, w.sourceCache)], { cwd: w.home });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'dotfiles'], { cwd: w.home });
    writeFile(cached, today);

    // The member's own copy, with no record: only proof would make it the source's.
    const codebuddy = path.join(dir, '.codebuddy', 'skills', 'other-skill');
    const manifestPath = w.manifestPath(dir);
    const manifest = JSON.parse(read(manifestPath));
    manifest.installedPaths['other-skill'] = manifest.installedPaths['other-skill'].filter((p: string) => !p.startsWith('.codebuddy/'));
    for (const key of Object.keys(manifest.installedPhysicalPaths ?? {})) if (key.startsWith('.codebuddy/')) delete manifest.installedPhysicalPaths[key];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.rmSync(codebuddy, { recursive: true, force: true });
    writeFile(path.join(codebuddy, 'SKILL.md'), MINE);
    w.ok(['pull', '--force'], dir);
    expect(read(path.join(codebuddy, 'SKILL.md'))).toBe(MINE);
  });

  it('with a source cache that has no history, the record and today\'s source decide', () => {
    const w = world('nohistory');
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude', 'cursor', 'codebuddy'], dir);
    fs.rmSync(path.join(w.sourceCache, '.git'), { recursive: true });

    // Recorded: still the source's, edited or not.
    const claude = path.join(dir, '.claude', 'skills', 'other-skill', 'SKILL.md');
    writeFile(claude, 'edited\n');
    // Unrecorded: the source's only when it is today's source skill.
    const cursor = path.join(dir, '.cursor', 'skills', 'other-skill');
    const codebuddy = path.join(dir, '.codebuddy', 'skills', 'other-skill');
    const manifestPath = w.manifestPath(dir);
    const manifest = JSON.parse(read(manifestPath));
    manifest.installedPaths['other-skill'] = ['.claude/skills/other-skill'];
    manifest.installedPhysicalPaths = { '.claude/skills/other-skill': path.dirname(claude) };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFile(path.join(cursor, 'SKILL.md'), MINE);

    const pulled = w.ok(['pull', '--force'], dir);
    expect(read(claude)).toBe(SOURCE_SKILL);
    expect(read(path.join(cursor, 'SKILL.md'))).toBe(MINE);
    expect(pulled.output).toContain(`Kept ${cursor}: it is not teamai's`);
    expect(read(path.join(codebuddy, 'SKILL.md'))).toBe(SOURCE_SKILL);
    expect(pulled.output).not.toContain(`Kept ${codebuddy}`);
  });

  /**
   * Follow-up 06b: a legacy copy the member changed stays on record, so the
   * record must never be what deletes it. Every command that releases source
   * copies leaves it while its content is no version of the source skill.
   */
  const CHANGED = `${SOURCE_SKILL}\nMy notes.\n`;
  function changedLegacyCopy(label: string): { w: World; dir: string; copy: string } {
    const w = world(label);
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true });
    const dir = w.business('biz', { '.claude/.keep': '' });
    deliver(w, ['claude', 'hermes'], dir);
    // What an earlier release left and recorded, then the member changed.
    const copy = path.join(dir, '.hermes', 'skills', 'other-skill');
    writeFile(path.join(copy, 'SKILL.md'), CHANGED);
    const manifestPath = w.manifestPath(dir);
    const manifest = JSON.parse(read(manifestPath));
    manifest.installedPaths['other-skill'].push('.hermes/skills/other-skill');
    manifest.installedPhysicalPaths['.hermes/skills/other-skill'] = copy;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return { w, dir, copy };
  }

  it('uninstall leaves a changed legacy copy that is on record', () => {
    const { w, dir, copy } = changedLegacyCopy('legacy-uninstall');
    const uninstalled = w.ok(['uninstall', '--force'], dir);
    expect(read(path.join(copy, 'SKILL.md')), uninstalled.output).toBe(CHANGED);
    // Uninstall did run: teamai's team skill copies are gone.
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'fe-skill'))).toBe(false);
  });

  it('remove skills and source remove leave a changed legacy copy that is on record', () => {
    const { w, dir, copy } = changedLegacyCopy('legacy-remove');
    const removedSkill = w.run(['remove', 'skills', 'other-skill', '--force'], dir);
    expect(read(path.join(copy, 'SKILL.md')), removedSkill.output).toBe(CHANGED);
    const removed = w.ok(['source', 'remove', 'other'], dir);
    expect(read(path.join(copy, 'SKILL.md')), removed.output).toBe(CHANGED);
    expect(removed.output).toContain(keptLegacyLine(copy));
    expect(fs.existsSync(path.join(w.home, '.hermes', 'skills', 'other-skill'))).toBe(false);
  });

  it('a pull after the source drops the skill leaves a changed legacy copy that is on record', () => {
    const { w, dir, copy } = changedLegacyCopy('legacy-dropped');
    w.publishSource({
      'teamai.yaml': ['team: other', 'repo: x', 'provider: git', 'reviewers: []', 'publicSkills: []', ''].join('\n'),
      'skills/other-skill': null,
    });
    const pulled = w.ok(['pull', '--force'], dir);
    expect(read(path.join(copy, 'SKILL.md')), pulled.output).toBe(CHANGED);
    expect(pulled.output).toContain(keptLegacyLine(copy));
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'other-skill'))).toBe(false);
    expect(fs.existsSync(path.join(w.home, '.hermes', 'skills', 'other-skill'))).toBe(false);
    // Still named, and still left, on the next pull.
    expect(w.ok(['pull', '--force'], dir).output).toContain(keptLegacyLine(copy));
    expect(read(path.join(copy, 'SKILL.md'))).toBe(CHANGED);
  });
});
