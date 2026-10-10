/**
 * E2E (#915): the skills and rules the HTTP local agent installs in a project
 * stay out of git, in the `local-agent` block of the exclude file of the
 * repository they land in, while the workspace's git exclude flag is on. The
 * flag is read per project: one project on, one off. A member's file at a path
 * the agent would install to is kept, and named. A project `teamai uninstall`
 * removes that project's lines only: the agent still serves the others.
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
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-agent-915-')));
  detached = trackDetachedProcesses(sandbox);
  server = await startMockServer({ apiKey: API_KEY, skillNames: { 'renamed-slug': 'renamed-skill' } });
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
  return {
    home,
    git,
    cli,
    /** A committed repository with teamai initialized in HTTP mode, project scope, for Claude. */
    async project(dir: string): Promise<string> {
      const root = path.join(base, dir);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'README.md'), `# ${dir}\n`);
      git(['init', '-q', '-b', 'main'], root);
      git(['add', '-A'], root);
      git(['commit', '-q', '-m', dir], root);
      const real = fs.realpathSync.native(root);
      const init = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'claude', '--force'], real);
      expect(init.code, init.output).toBe(0);
      return real;
    },
    /** The member's git exclude override in the project's partition config. */
    setFlag(project: string, on: boolean): void {
      const projects = path.join(home, '.teamai', 'projects');
      const config = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml'))
        .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`projectRoot: ${project}\n`));
      if (!config) throw new Error(`no partition config for ${project}`);
      const lines = fs.readFileSync(config, 'utf8').split('\n').filter((line) => !line.startsWith('gitExcludeEnabled:'));
      fs.writeFileSync(config, [...lines.filter(Boolean), `gitExcludeEnabled: ${on}`, ''].join('\n'));
    },
    async sessionStart(cwd: string, commands: MockCommand[]): Promise<void> {
      server.seedCommands(commands);
      const run = await cli(['hook-dispatch', 'session-start', '--tool', 'claude'], cwd,
        JSON.stringify({ cwd, session_id: `s-${path.basename(cwd)}`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      expect(run.code, run.output).toBe(0);
    },
  };
}

const install = (id: number, kind: 'skill' | 'rule', slug: string, workspace: string): MockCommand => ({
  id,
  type: `install_${kind}`,
  [`${kind}_slug`]: slug,
  [`${kind}_version`]: '1.0.0',
  download_url: `${server.url}/download?kind=${kind}&slug=${slug}`,
  scope: 'workspace',
  workspace_path: workspace,
});

/** A project prompt (`handle_type: prompt`), which the agent compiles into the tool's instruction file. */
const prompt = (id: number, action: 'install' | 'uninstall', slug: string, workspace: string): MockCommand => ({
  id,
  type: `${action}_rule`,
  rule_type: 'prompt',
  rule_slug: slug,
  rule_version: '1.0.0',
  ...action === 'install' ? { download_url: `${server.url}/download?kind=rule&slug=${slug}` } : {},
  scope: 'workspace',
  workspace_path: workspace,
});

const block = (project: string): string[] | null => {
  const file = path.join(project, '.git', 'info', 'exclude');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const match = /# \[teamai:local-agent:start\]\n([\s\S]*?)# \[teamai:local-agent:end\]\n/.exec(content);
  return match ? match[1].split('\n').filter(Boolean) : null;
};

describe.skipIf(process.platform === 'win32')('the HTTP local agent keeps what it installs in a project out of git (#915)', () => {
  it('lists a skill and a rule where the flag is on and not where it is off, keeps a member\'s file, and a project uninstall drops only that project\'s lines', async () => {
    const m = machine('http');
    const app = await m.project('app');
    const side = await m.project('side');
    m.setFlag(app, true);
    const status = (cwd: string): string[] => m.git(['status', '--porcelain', '-uall'], cwd).out.split('\n').filter(Boolean);
    const ignored = (cwd: string, rel: string): boolean => m.git(['check-ignore', '-q', rel], cwd).code === 0;
    fs.mkdirSync(path.join(app, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(app, '.claude', 'rules', 'mine.md'), '# Mine\n');
    const membersRule = path.join(app, '.claude', 'rules', 'members-rule.md');
    fs.writeFileSync(membersRule, '# My own rule of that name\n');

    await m.sessionStart(app, [
      install(1, 'skill', 'renamed-slug', app),
      install(2, 'rule', 'http-rule', app),
      install(3, 'rule', 'members-rule', app),
      install(4, 'skill', 'side-skill', side),
      install(5, 'rule', 'side-rule', side),
    ]);

    expect(server.acks.map(({ id, body }) => [id, (body as { status: string }).status])).toEqual([
      [1, 'success'], [2, 'success'], [3, 'failed'], [4, 'success'], [5, 'success'],
    ]);
    expect((server.acks[2].body as { error: string }).error).toBe(`Kept ${membersRule}: it is not teamai's (not in the local agent's records). `
      + 'Rename or delete it; the local agent installs members-rule on its next sync.');
    expect(fs.readFileSync(membersRule, 'utf8')).toBe('# My own rule of that name\n');
    // Flag on: git ignores both installs, and still sees the member's files.
    expect(ignored(app, '.claude/skills/renamed-skill/SKILL.md')).toBe(true);
    expect(ignored(app, '.claude/rules/http-rule.md')).toBe(true);
    expect(block(app)).toEqual(['/.claude/rules/http-rule.md', '/.claude/skills/renamed-skill/SKILL.md']);
    expect(status(app)).toEqual(['?? .claude/rules/members-rule.md', '?? .claude/rules/mine.md']);
    expect(m.git(['ls-files', '--others', '--exclude-standard', '.claude/rules'], app).out.split('\n').filter(Boolean).sort())
      .toEqual(['.claude/rules/members-rule.md', '.claude/rules/mine.md']);
    // Flag off: no block, and git sees both installs.
    expect(block(side)).toBeNull();
    expect(status(side)).toEqual(expect.arrayContaining(['?? .claude/rules/side-rule.md', '?? .claude/skills/side-skill/SKILL.md']));

    // Turned on in the second project: its next install lists its copies there.
    // A file the member adds inside an installed skill stays theirs: visible and addable.
    const myNotes = path.join(app, '.claude', 'skills', 'renamed-skill', 'my-notes.md');
    fs.writeFileSync(myNotes, '# My notes\n');
    m.setFlag(side, true);
    await m.sessionStart(side, [install(6, 'rule', 'side-rule-2', side)]);
    expect(block(side)).toEqual(['/.claude/rules/side-rule-2.md', '/.claude/rules/side-rule.md', '/.claude/skills/side-skill/SKILL.md']);
    expect(block(app)).toEqual(['/.claude/rules/http-rule.md', '/.claude/skills/renamed-skill/SKILL.md']);
    expect(status(app)).toContain('?? .claude/skills/renamed-skill/my-notes.md');
    expect(m.git(['add', '--dry-run', '-A'], app).out).toContain("add '.claude/skills/renamed-skill/my-notes.md'");
    fs.rmSync(myNotes);

    const out = await m.cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    expect(fs.readFileSync(path.join(app, '.git', 'info', 'exclude'), 'utf8')).not.toContain('# [teamai:');
    // A project uninstall leaves the local agent serving the second project: its lines stay, and so does its own delivered block.
    expect(block(side)).toEqual(['/.claude/rules/side-rule-2.md', '/.claude/rules/side-rule.md', '/.claude/skills/side-skill/SKILL.md']);
    expect(fs.readFileSync(path.join(side, '.git', 'info', 'exclude'), 'utf8')).toContain('# [teamai:delivered:start]');
    expect(status(app).filter((line) => /renamed-skill|http-rule/.test(line))).toEqual([]);
    expect(fs.readFileSync(membersRule, 'utf8')).toBe('# My own rule of that name\n');
  }, 180_000);

  it('a project uninstall drops only that project\'s lines: another repository keeps its block, and a shared exclude file a linked worktree\'s', async () => {
    const m = machine('uninstall-one');
    // The member's own setting, for every workspace teamai has no project config for.
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    const userConfig = path.join(m.home, '.teamai', 'config.yaml');
    fs.appendFileSync(userConfig, 'gitExcludeEnabled: true\n');
    const app = await m.project('app');
    const side = await m.project('side');
    m.setFlag(app, true);
    m.setFlag(side, true);
    const added = m.git(['worktree', 'add', '-q', path.join(path.dirname(app), 'app-wt'), '-b', 'wt'], app);
    expect(added.code, added.out).toBe(0);
    await detached.waitForExit();
    const wt = fs.realpathSync.native(path.join(path.dirname(app), 'app-wt'));

    await m.sessionStart(app, [
      install(31, 'rule', 'app-rule', app),
      install(32, 'rule', 'side-rule', side),
      install(33, 'rule', 'wt-rule', wt),
    ]);
    expect(server.acks.filter(({ id }) => id >= 31 && id <= 33).map(({ body }) => (body as { status: string }).status))
      .toEqual(['success', 'success', 'success']);
    expect(block(app)).toEqual(['/.claude/rules/app-rule.md', '/.claude/rules/wt-rule.md']);
    expect(block(side)).toEqual(['/.claude/rules/side-rule.md']);

    const out = await m.cli(['uninstall', '--force'], app);

    expect(out.code, out.output).toBe(0);
    expect(block(side), out.output).toEqual(['/.claude/rules/side-rule.md']);
    expect(block(app), out.output).toEqual(['/.claude/rules/wt-rule.md']);
    expect(m.git(['status', '--porcelain', '-uall'], wt).out).not.toContain('wt-rule');
    expect(m.git(['status', '--porcelain', '-uall'], side).out).not.toContain('side-rule');
  }, 180_000);

  it('lists the instruction file a project prompt goes to, and drops it once the prompt is uninstalled', async () => {
    const m = machine('prompt');
    // A workspace with no project config of its own: the member's user setting decides, and no project pull rewrites the file.
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    fs.appendFileSync(path.join(m.home, '.teamai', 'config.yaml'), 'gitExcludeEnabled: true\n');
    const app = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'prompt-app-')));
    fs.mkdirSync(path.join(app, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(app, '.claude', 'rules', 'mine.md'), '# Mine\n');
    m.git(['init', '-q', '-b', 'main'], app);
    const status = (): string[] => m.git(['status', '--porcelain', '-uall', '.claude'], app).out.split('\n').filter(Boolean);
    const context = path.join(app, '.claude', 'rules', 'teamai-context.md');

    await m.sessionStart(app, [prompt(41, 'install', 'team-prompt', app)]);
    expect(server.acks.filter(({ id }) => id === 41).map(({ body }) => (body as { status: string }).status)).toEqual(['success']);
    expect(fs.readFileSync(context, 'utf8')).toContain('team-prompt');
    expect(block(app)).toEqual(['/.claude/rules/teamai-context.md', '/.teamai/.gitignore']);
    expect(status()).toEqual(['?? .claude/rules/mine.md']);

    await m.sessionStart(app, [prompt(42, 'uninstall', 'team-prompt', app)]);
    expect(server.acks.filter(({ id }) => id === 42).map(({ body }) => (body as { status: string }).status)).toEqual(['success']);
    expect(fs.existsSync(context)).toBe(false);
    expect(block(app)).toEqual(['/.teamai/.gitignore']);
    // The path is the member's again: a file there is visible.
    fs.writeFileSync(context, '# My context\n');
    expect(status()).toEqual(['?? .claude/rules/mine.md', '?? .claude/rules/teamai-context.md']);
  }, 180_000);

  it('keeps its cache in a workspace with no project config out of git, and drops the line with the cache', async () => {
    const m = machine('cache');
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    fs.appendFileSync(path.join(m.home, '.teamai', 'config.yaml'), 'gitExcludeEnabled: true\n');
    const app = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'cache-app-')));
    fs.writeFileSync(path.join(app, 'mine.md'), '# Mine\n');
    m.git(['init', '-q', '-b', 'main'], app);
    const status = (): string[] => m.git(['status', '--porcelain', '-uall'], app).out.split('\n').filter(Boolean);

    // The agent caches what it installs under the workspace's `.teamai/`, which a `.gitignore` of its own hides but for itself.
    await m.sessionStart(app, [install(51, 'skill', 'cache-skill', app), install(52, 'rule', 'cache-rule', app)]);
    expect(server.acks.filter(({ id }) => id === 51 || id === 52).map(({ body }) => (body as { status: string }).status))
      .toEqual(['success', 'success']);
    expect(fs.existsSync(path.join(app, '.teamai', '.gitignore'))).toBe(true);
    expect(block(app)).toEqual(['/.claude/rules/cache-rule.md', '/.claude/skills/cache-skill/SKILL.md', '/.teamai/.gitignore']);
    expect(status()).toEqual(['?? mine.md']);

    // A `.gitignore` the member already had there stays theirs, and visible, once the agent appends its line.
    const own = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'cache-own-')));
    fs.mkdirSync(path.join(own, '.teamai'));
    fs.writeFileSync(path.join(own, '.teamai', '.gitignore'), '*.log\n');
    m.git(['init', '-q', '-b', 'main'], own);
    await m.sessionStart(own, [install(54, 'rule', 'own-rule', own)]);
    expect(fs.readFileSync(path.join(own, '.teamai', '.gitignore'), 'utf8')).toBe('*.log\nlocal-agent/\n');
    expect(block(own)).toEqual(['/.claude/rules/own-rule.md']);
    expect(m.git(['status', '--porcelain', '-uall'], own).out.split('\n').filter(Boolean)).toEqual(['?? .teamai/.gitignore']);

    // Turned off: the line goes with the block, and git sees the file again.
    const userConfig = path.join(m.home, '.teamai', 'config.yaml');
    const setFlag = (on: boolean): void => fs.writeFileSync(userConfig, fs.readFileSync(userConfig, 'utf8').replace(/gitExcludeEnabled: \w+/, `gitExcludeEnabled: ${on}`));
    setFlag(false);
    await m.sessionStart(app, []);
    expect(block(app)).toBeNull();
    expect(status()).toContain('?? .teamai/.gitignore');

    // A member who committed the agent's `.gitignore` (an older release left it visible) keeps it.
    const committed = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'cache-committed-')));
    m.git(['init', '-q', '-b', 'main'], committed);
    await m.sessionStart(committed, [install(55, 'rule', 'committed-rule', committed)]);
    m.git(['add', '.teamai/.gitignore'], committed);
    expect(m.git(['commit', '-q', '-m', 'agent cache ignore'], committed).code).toBe(0);

    // Removing the agent removes its cache from the workspace, and the line with it.
    setFlag(true);
    await m.sessionStart(app, []);
    expect(block(app)).toContain('/.teamai/.gitignore');
    const removed = await m.cli(['source', 'remove-http'], app);
    expect(removed.code, removed.output).toBe(0);
    expect(fs.existsSync(path.join(app, '.teamai'))).toBe(false);
    expect(block(app)).toBeNull();
    expect(status()).toEqual(['?? mine.md']);
    expect(m.git(['status', '--porcelain', '-uall'], committed).out).toBe('');
    expect(fs.existsSync(path.join(committed, '.teamai', '.gitignore'))).toBe(true);
  }, 180_000);

  it('keeps workspace MCP cache files out of git without hiding a member file', async () => {
    const m = machine('mcp-cache');
    const user = await m.cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'user', '--agent', 'claude', '--force'], m.home);
    expect(user.code, user.output).toBe(0);
    fs.appendFileSync(path.join(m.home, '.teamai', 'config.yaml'), 'gitExcludeEnabled: true\n');
    const app = fs.realpathSync.native(fs.mkdtempSync(path.join(sandbox, 'mcp-cache-app-')));
    m.git(['init', '-q', '-b', 'main'], app);
    fs.mkdirSync(path.join(app, '.teamai'));
    fs.writeFileSync(path.join(app, '.teamai', 'mine.md'), '# Mine\n');
    await m.sessionStart(app, [{ id: 61, type: 'install_mcp', scope: 'workspace', workspace_path: app,
      slug: 'cache-api', version: '1.0.0', mcp_config: { transport: 'stdio', command: 'cache-api-server' } }]);
    expect(server.acks.filter(({ id }) => id === 61).map(({ body }) => (body as { status: string }).status)).toEqual(['success']);
    expect(m.git(['status', '--porcelain', '-uall'], app).out).toBe('?? .teamai/mine.md\n');
    expect(m.git(['add', '--dry-run', '-A'], app).out).toBe("add '.teamai/mine.md'\n");
    const config = path.join(m.home, '.teamai', 'config.yaml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('gitExcludeEnabled: true', 'gitExcludeEnabled: false'));

    await m.sessionStart(app, []);
    expect(block(app)).toBeNull();
    expect(m.git(['status', '--porcelain', '-uall'], app).out).toContain('?? .teamai/managed-local-mcp.json');
  }, 180_000);

  it('follows the flag at the next session start with no install from the backend', async () => {
    const m = machine('flip');
    const app = await m.project('app');
    const status = (): string[] => m.git(['status', '--porcelain', '-uall'], app).out.split('\n').filter(Boolean);
    const installed = ['?? .claude/rules/flip-rule.md', '?? .claude/skills/flip-skill/SKILL.md'];

    await m.sessionStart(app, [install(11, 'skill', 'flip-skill', app), install(12, 'rule', 'flip-rule', app)]);
    expect(server.acks.filter(({ id }) => id === 11 || id === 12).map(({ body }) => (body as { status: string }).status))
      .toEqual(['success', 'success']);
    expect(block(app)).toBeNull();
    expect(status()).toEqual(expect.arrayContaining(installed));

    // Turned on: a session start alone lists both copies.
    m.setFlag(app, true);
    await m.sessionStart(app, []);
    expect(block(app)).toEqual(['/.claude/rules/flip-rule.md', '/.claude/skills/flip-skill/SKILL.md']);
    expect(status().filter((line) => /flip-/.test(line))).toEqual([]);

    // Turned off: a session start alone drops the block, and git sees both again.
    m.setFlag(app, false);
    await m.sessionStart(app, []);
    expect(block(app)).toBeNull();
    expect(status()).toEqual(expect.arrayContaining(installed));
  }, 180_000);

  it('keeps a session start\'s failure to write the block for the next pull, once, and for doctor until a sync succeeds', async () => {
    const m = machine('fail');
    const app = await m.project('app');
    const exclude = path.join(app, '.git', 'info', 'exclude');
    await m.sessionStart(app, [install(21, 'rule', 'fail-rule', app)]);
    m.setFlag(app, true);
    fs.chmodSync(exclude, 0o444);
    const failure = /A local agent sync \(.+\) could not keep teamai's git exclude blocks up to date: Could not update the local agent's git exclude block in .*exclude/;
    const doctorCheck = 'Last local agent sync could not keep its git exclude block up to date';

    try {
      await m.sessionStart(app, []);
      expect(block(app)).toBeNull();

      const pull = await m.cli(['pull'], app);
      expect(pull.output).toMatch(failure);
      expect((await m.cli(['pull'], app)).output).not.toMatch(failure);
      expect((await m.cli(['doctor'], app)).output).toContain(doctorCheck);
    } finally {
      fs.chmodSync(exclude, 0o644);
    }

    await m.sessionStart(app, []);
    expect(block(app)).toEqual(['/.claude/rules/fail-rule.md']);
    expect((await m.cli(['doctor'], app)).output).not.toContain(doctorCheck);
  }, 180_000);
});
