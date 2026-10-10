/**
 * E2E (#915): removing the HTTP local agent (`teamai source remove-http`, or
 * `teamai uninstall`) removes the copy it installed for each tool, keeps a
 * member's file and a file git tracks, and leaves no teamai file git would
 * now offer to commit: the `local-agent` block goes, but for the files the
 * teardown left on disk.
 *
 * Runs the built CLI against an in-process mock backend, so the CLI is spawned
 * asynchronously. Each case gets its own HOME and repositories.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { startMockServer, type MockCommand, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const API_KEY = 'e2e-http-key';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;
let server: MockServerHandle;

beforeAll(async () => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-agent-teardown-915-')));
  detached = trackDetachedProcesses(sandbox);
  server = await startMockServer({ apiKey: API_KEY });
});

afterAll(async () => {
  await detached?.waitForExit();
  await server?.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function machine(name: string) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  const git = (args: string[], cwd: string): { code: number | null; out: string } => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // Spawned asynchronously: the mock backend runs in this process.
  const cli = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input ?? '');
  });
  const repository = (dir: string): string => {
    const root = path.join(base, dir);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(root, '.workbuddy'));
    fs.writeFileSync(path.join(root, 'README.md'), `# ${dir}\n`);
    git(['init', '-q', '-b', 'main'], root);
    git(['add', 'README.md'], root);
    git(['commit', '-q', '-m', dir], root);
    return fs.realpathSync.native(root);
  };
  return {
    base,
    home,
    git,
    cli,
    repository,
    /** A committed repository with teamai initialized in HTTP mode, project scope, for Claude and WorkBuddy, its git exclude flag on. */
    async project(dir: string): Promise<string> {
      const root = repository(dir);
      const init = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'claude,workbuddy', '--force'], root);
      expect(init.code, init.output).toBe(0);
      const projects = path.join(home, '.teamai', 'projects');
      const config = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml'))
        .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`projectRoot: ${root}\n`));
      if (!config) throw new Error(`no partition config for ${root}`);
      fs.appendFileSync(config, 'gitExcludeEnabled: true\n');
      return root;
    },
    async sessionStart(cwd: string, tool: string, commands: MockCommand[]): Promise<void> {
      server.seedCommands(commands);
      const run = await cli(['hook-dispatch', 'session-start', '--tool', tool], cwd,
        JSON.stringify({ cwd, session_id: `s-${path.basename(cwd)}-${tool}`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      expect(run.code, run.output).toBe(0);
    },
  };
}

let nextId = 1;
const installRule = (slug: string, workspace: string): MockCommand => ({
  id: nextId++,
  type: 'install_rule',
  rule_slug: slug,
  rule_version: '1.0.0',
  download_url: `${server.url}/download?kind=rule&slug=${slug}`,
  scope: 'workspace',
  workspace_path: workspace,
});
const installSkill = (slug: string, workspace: string): MockCommand => ({
  id: nextId++,
  type: 'install_skill',
  skill_slug: slug,
  skill_version: '1.0.0',
  download_url: `${server.url}/download?kind=skill&slug=${slug}`,
  scope: 'workspace',
  workspace_path: workspace,
});

const installPrompt = (slug: string, workspace: string): MockCommand => ({
  id: nextId++,
  type: 'install_rule',
  rule_type: 'prompt',
  rule_slug: slug,
  rule_version: '1.0.0',
  download_url: `${server.url}/download?kind=rule&slug=${slug}`,
  scope: 'workspace',
  workspace_path: workspace,
});

const block = (project: string, owner = 'local-agent'): string[] | null => {
  const file = path.join(project, '.git', 'info', 'exclude');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const match = new RegExp(`# \\[teamai:${owner}:start\\]\\n([\\s\\S]*?)# \\[teamai:${owner}:end\\]\\n`).exec(content);
  return match ? match[1].split('\n').filter(Boolean) : null;
};

describe.skipIf(process.platform === 'win32')('removing the HTTP local agent removes each tool\'s copies (#915)', () => {
  it('remove-http removes the rule it installed for Claude and for WorkBuddy, and keeps an edited copy out of git and named', async () => {
    const m = machine('two-tools');
    const app = await m.project('app');
    const status = (): string[] => m.git(['status', '--porcelain', '-uall'], app).out.split('\n').filter(Boolean);
    await m.sessionStart(app, 'claude', [installRule('team-rule', app), installRule('edited-rule', app)]);
    await m.sessionStart(app, 'workbuddy', [installRule('team-rule', app), installRule('edited-rule', app)]);
    const claudeRule = path.join(app, '.claude', 'rules', 'team-rule.md');
    const workbuddyRules = path.join(app, '.codebuddy', 'rules');
    const edited = path.join(app, '.claude', 'rules', 'edited-rule.md');
    expect(fs.existsSync(claudeRule)).toBe(true);
    expect(fs.readdirSync(workbuddyRules).sort()).toEqual(['edited-rule.md', 'team-rule.md']);
    expect(status()).toEqual([]);
    fs.appendFileSync(edited, '\nMy own note.\n');

    const out = await m.cli(['source', 'remove-http'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(claudeRule), out.output).toBe(false);
    expect(fs.readdirSync(workbuddyRules), out.output).toEqual([]);
    // The member's edit stays, named, and still out of git until they delete it.
    expect(fs.readFileSync(edited, 'utf8')).toContain('My own note.');
    expect(out.output).toContain(edited);
    expect(block(app), out.output).toEqual(['/.claude/rules/edited-rule.md']);
    expect(status(), out.output).toEqual([]);
  }, 180_000);

  it('remove-http tries every tool for an older CLI\'s entry: removes the copies equal to the cached source, keeps a member\'s file and one git tracks', async () => {
    const m = machine('legacy');
    const app = await m.project('app');
    const status = (): string[] => m.git(['status', '--porcelain', '-uall'], app).out.split('\n').filter(Boolean);
    await m.sessionStart(app, 'claude', [installRule('legacy-rule', app), installSkill('legacy-skill', app)]);
    await m.sessionStart(app, 'workbuddy', [installRule('legacy-rule', app), installSkill('legacy-skill', app)]);
    const copies = ['.claude/rules/legacy-rule.md', '.claude/skills/legacy-skill/SKILL.md', '.workbuddy/skills/legacy-skill/SKILL.md'];
    for (const copy of copies) expect(fs.existsSync(path.join(app, copy)), copy).toBe(true);
    // The member committed WorkBuddy's copy, and has a rule of that name of their own for Cursor.
    const tracked = path.join(app, '.codebuddy', 'rules', 'legacy-rule.md');
    expect(m.git(['add', '-f', '.codebuddy/rules/legacy-rule.md'], app).code).toBe(0);
    expect(m.git(['commit', '-q', '-m', 'keep the rule'], app).code).toBe(0);
    const members = path.join(app, '.cursor', 'rules', 'legacy-rule.mdc');
    fs.mkdirSync(path.dirname(members), { recursive: true });
    fs.writeFileSync(members, '# My Cursor rule\n');
    // An older CLI recorded no tools.
    const manifestFile = path.join(m.home, '.teamai', 'local-agent', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { scopes: Record<string, Record<string, Record<string, { tools?: string[] }>>> };
    for (const scope of Object.values(manifest.scopes)) for (const kind of Object.values(scope)) for (const entry of Object.values(kind)) delete entry.tools;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));

    const out = await m.cli(['source', 'remove-http'], app);

    expect(out.code, out.output).toBe(0);
    for (const copy of copies) expect(fs.existsSync(path.join(app, copy)), `${copy}\n${out.output}`).toBe(false);
    expect(fs.existsSync(tracked)).toBe(true);
    expect(out.output).toContain(`Kept ${tracked}: this repository tracks it`);
    expect(fs.readFileSync(members, 'utf8')).toBe('# My Cursor rule\n');
    expect(out.output).toContain(`Kept ${members}`);
    expect(block(app), out.output).toBeNull();
    expect(status(), out.output).toEqual(['?? .cursor/rules/legacy-rule.mdc']);
  }, 180_000);

  it('remove-http removes a project prompt from the instruction file of every tool it reached, and their lines', async () => {
    const m = machine('prompt');
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude,workbuddy', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    fs.appendFileSync(path.join(m.home, '.teamai', 'config.yaml'), 'gitExcludeEnabled: true\n');
    // A repository with no teamai project of its own: no project pull rewrites the files.
    const app = m.repository('app');
    await m.sessionStart(app, 'claude', [installPrompt('team-prompt', app)]);
    await m.sessionStart(app, 'workbuddy', [installPrompt('team-prompt', app)]);
    const files = ['.claude/rules/teamai-context.md', '.codebuddy/rules/teamai-context.md'];
    for (const file of files) expect(fs.readFileSync(path.join(app, file), 'utf8'), file).toContain('team-prompt');
    expect(block(app)).toEqual([...files.map((file) => `/${file}`), '/.teamai/.gitignore']);

    const out = await m.cli(['source', 'remove-http'], app);

    expect(out.code, out.output).toBe(0);
    for (const file of files) expect(fs.existsSync(path.join(app, file)), `${file}\n${out.output}`).toBe(false);
    expect(block(app), out.output).toBeNull();
  }, 180_000);

  it('a block remove-http could not remove is still found, and removed, by a later teamai uninstall', async () => {
    const m = machine('kept-block');
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    fs.appendFileSync(path.join(m.home, '.teamai', 'config.yaml'), 'gitExcludeEnabled: true\n');
    // A repository with no teamai project of its own: the user scope's flag applies.
    const app = m.repository('app');
    await m.sessionStart(app, 'claude', [installRule('kept-rule', app)]);
    expect(block(app)).toEqual(['/.claude/rules/kept-rule.md', '/.teamai/.gitignore']);
    const exclude = path.join(app, '.git', 'info', 'exclude');

    fs.chmodSync(exclude, 0o444);
    let removed: Run;
    try {
      removed = await m.cli(['source', 'remove-http'], app);
    } finally {
      fs.chmodSync(exclude, 0o644);
    }
    expect(removed.output).toContain(`Kept the local agent's git exclude block in ${exclude}`);
    expect(fs.existsSync(path.join(app, '.claude', 'rules', 'kept-rule.md')), removed.output).toBe(false);
    expect(block(app)).toEqual(['/.claude/rules/kept-rule.md', '/.teamai/.gitignore']);

    const out = await m.cli(['uninstall', '--force'], m.home);

    expect(out.code, out.output).toBe(0);
    expect(block(app), `${removed.output}\n${out.output}`).toBeNull();
    expect(fs.existsSync(path.join(m.home, '.teamai')), out.output).toBe(false);
  }, 180_000);

  it('a project uninstall keeps a member\'s file inside a local agent skill and an edited rule, named, and removes teamai\'s other files', async () => {
    const m = machine('members-files');
    const app = await m.project('app');
    await m.sessionStart(app, 'claude', [installSkill('la-skill', app), installRule('la-rule', app), installRule('plain-rule', app)]);
    const skillDir = path.join(app, '.claude', 'skills', 'la-skill');
    const notes = path.join(skillDir, 'notes.md');
    fs.writeFileSync(notes, '# My notes\n');
    const rule = path.join(app, '.claude', 'rules', 'la-rule.md');
    fs.appendFileSync(rule, '\nMy own note.\n');

    const out = await m.cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md')), out.output).toBe(false);
    expect(fs.readFileSync(notes, 'utf8')).toBe('# My notes\n');
    expect(out.output).toContain(`Kept ${notes}`);
    expect(fs.readFileSync(rule, 'utf8')).toContain('My own note.');
    expect(out.output).toContain(`Kept ${rule}`);
    expect(fs.existsSync(path.join(app, '.claude', 'rules', 'plain-rule.md')), out.output).toBe(false);
  }, 180_000);

  it('remove-http keeps a member\'s file inside a skill it installed, named, and removes the skill\'s own files', async () => {
    const m = machine('members-skill-file');
    const app = await m.project('app');
    await m.sessionStart(app, 'claude', [installSkill('kept-skill', app)]);
    const skillDir = path.join(app, '.claude', 'skills', 'kept-skill');
    const notes = path.join(skillDir, 'notes.md');
    fs.writeFileSync(notes, '# My notes\n');

    const out = await m.cli(['source', 'remove-http'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md')), out.output).toBe(false);
    expect(fs.readFileSync(notes, 'utf8')).toBe('# My notes\n');
    expect(out.output).toContain(`Kept ${notes}`);
    expect(block(app), out.output).toBeNull();
  }, 180_000);

  it('an uninstall that finds no configuration removes every teamai line whose file is gone, and keeps, and names, those of files it leaves', async () => {
    const m = machine('home-only');
    const app = await m.project('app');
    await m.sessionStart(app, 'claude', [installRule('home-rule', app), installSkill('home-skill', app)]);
    expect(block(app)).toEqual(['/.claude/rules/home-rule.md', '/.claude/skills/home-skill/SKILL.md']);
    expect(block(app, 'delivered')).toEqual(['/.claude/skills/teamai/SKILL.md', '/.workbuddy/skills/teamai/SKILL.md']);
    // The member removed WorkBuddy's copy of the CLI's skill.
    fs.rmSync(path.join(app, '.workbuddy', 'skills'), { recursive: true });
    const exclude = path.join(app, '.git', 'info', 'exclude');

    // Outside the project, no configuration applies.
    const out = await m.cli(['uninstall', '--force'], m.base);

    expect(out.code, out.output).toBe(0);
    expect(out.output).toContain('home directory only');
    expect(fs.existsSync(path.join(m.home, '.teamai')), out.output).toBe(false);
    expect(block(app), out.output).toBeNull();
    expect(fs.existsSync(path.join(app, '.claude', 'rules', 'home-rule.md'))).toBe(false);
    // This uninstall leaves the CLI's skill in the project: its line stays, named.
    expect(block(app, 'delivered'), out.output).toEqual(['/.claude/skills/teamai/SKILL.md']);
    expect(out.output).toContain(`Kept /.claude/skills/teamai/SKILL.md in ${exclude}, so git still ignores ${path.join(app, '.claude', 'skills', 'teamai', 'SKILL.md')}`);
    expect(m.git(['status', '--porcelain', '-uall'], app).out, out.output).toBe('');
  }, 180_000);
});
