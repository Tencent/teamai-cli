/**
 * E2E (#993 bug 5): a repository without `.git/info/`.
 *
 * teamai keeps a project MCP config holding a resolved value out of git by
 * listing it in `.git/info/exclude` before writing it (#886). Repositories
 * created with an empty template (`git init --template=`) have no `info/`.
 * teamai creates it and proceeds; "not writable" is reported only when the
 * file system denies the write, and the message names the exclude file.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const TOKEN = 'lab-token-value-5e1f';
const isRoot = process.getuid?.() === 0;

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
/** The background hook-dispatch a session start leaves running, and anything else the CLI detaches. */

function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    SHELL: '/bin/bash',
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

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A team whose one MCP server sends `Authorization: Bearer ${LAB_TOKEN}`, the variable set in env.yaml. */
function team(name: string): string {
  // Fresh paths on every call, so the runner's retry rebuilds the fixture instead of failing on the first try's.
  const root = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const url = `https://git.example.com/team/${path.basename(root)}.git`;
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'team.git');
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', 'sharing:', '  mcp:', '    autoApply: true', '',
  ].join('\n'));
  writeFile(path.join(seed, 'mcp', 'mcp.yaml'), [
    'servers:', '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
    '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"', '',
  ].join('\n'));
  writeFile(path.join(seed, 'env', 'env.yaml'), `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return url;
}

/** A business repo created with an empty template, so `.git/` has no `info/`. */
function business(name: string): string {
  const dir = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main', '--template='], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  expect(fs.existsSync(path.join(dir, '.git', 'info'))).toBe(false);
  return fs.realpathSync.native(dir);
}

/** A linked worktree of a fresh empty-template repo; the exclude file lives in the main repo's `.git/info/`. */
function linkedWorktree(name: string): { worktree: string; infoDir: string } {
  const main = business(`${name}-main`);
  const worktree = path.join(fs.mkdtempSync(path.join(sandbox, `${name}-`)), 'wt');
  gitOk(['worktree', 'add', '-q', '-b', 'wt', worktree], main);
  const infoDir = path.join(main, '.git', 'info');
  expect(fs.existsSync(infoDir)).toBe(false);
  return { worktree: fs.realpathSync.native(worktree), infoDir };
}

function init(url: string, dir: string): Run {
  const started = teamai(['init', url, '--provider', 'git', '--agent', 'claude', '--scope', 'project', '--force'], dir);
  if (started.code !== 0) throw new Error(`teamai init failed: ${started.output}`);
  const pulled = teamai(['pull'], dir);
  if (pulled.code !== 0) throw new Error(`teamai pull failed: ${pulled.output}`);
  return { ...pulled, output: `${started.output}${pulled.output}` };
}

const mcpServer = (dir: string): unknown =>
  fs.existsSync(path.join(dir, '.mcp.json')) ? JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers?.['secret-api'] : undefined;

const teamBlock = (infoDir: string): string => fs.readFileSync(path.join(infoDir, 'exclude'), 'utf8');

interface CheckResult { name: string; ok: boolean; fix?: string }
function doctorCheck(dir: string, name: string): CheckResult {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: dir, encoding: 'utf8', env: env() });
  const checks = (JSON.parse(r.stdout) as { checks: CheckResult[] }).checks;
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in: ${checks.map((c) => c.name).join(', ')}`);
  return found;
}

/** Init succeeds with no warning, the server holds the resolved value, the exclude block lists it, and git ignores it. */
function expectDelivered(dir: string, infoDir: string, initRun: Run): void {
  expect(initRun.output).not.toContain('not writable');
  expect(initRun.output).not.toMatch(/Did not write claude's MCP servers/);
  expect(mcpServer(dir)).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(teamBlock(infoDir)).toMatch(/\[teamai:mcp-exclude:start][^\n]*\n\/\.mcp\.json\n# \[teamai:mcp-exclude:end]/);
  expect(gitOk(['status', '--porcelain', '--untracked-files=all', '--', '.mcp.json'], dir)).toBe('');
  expect(doctorCheck(dir, 'MCP servers delivered to claude').ok).toBe(true);
}

/** Pull withholds the server and names the read-only exclude file; doctor fails the delivery check with the same reason. */
function expectWithheld(dir: string, excludeFile: string, pulled: Run): void {
  expect(mcpServer(dir)).toBeUndefined();
  expect(pulled.output).toContain(`${excludeFile} is not writable`);
  expect(pulled.output).toContain(`add \`/.mcp.json\` to it yourself`);
  const check = doctorCheck(dir, 'MCP servers delivered to claude');
  expect(check.ok).toBe(false);
  expect(check.fix).toContain(`withheld: secret-api, as git would commit the file: ${excludeFile} is not writable`);
}

/** Init with the exclude file read-only, then a pull, and the exclude file's mode restored. */
function withReadOnlyExclude(infoDir: string, body: () => void): void {
  writeFile(path.join(infoDir, 'exclude'), '# mine\n');
  fs.chmodSync(path.join(infoDir, 'exclude'), 0o444);
  try {
    body();
  } finally {
    fs.chmodSync(path.join(infoDir, 'exclude'), 0o644);
  }
  expect(teamBlock(infoDir)).toBe('# mine\n');
}

describe('a repository without .git/info/ (#993 bug 5)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-info-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterAll(async () => {
    // Init and pull may detach children too: none may write into the sandbox while it goes.
    await waitForDetachedChildren();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('creates .git/info/, lists the MCP config in exclude, and writes the server with no warning', () => {
    const url = team('no-info');
    const dir = business('no-info-biz');

    const initRun = init(url, dir);

    expectDelivered(dir, path.join(dir, '.git', 'info'), initRun);
  });

  it.skipIf(isRoot)('still reports a read-only exclude file as not writable, naming the file', () => {
    const url = team('ro-exclude');
    const dir = business('ro-exclude-biz');
    const infoDir = path.join(dir, '.git', 'info');

    withReadOnlyExclude(infoDir, () => {
      init(url, dir);
      expectWithheld(dir, path.join(infoDir, 'exclude'), teamai(['pull'], dir));
    });
  });

  it('withholds the server when .git/info is a regular file, naming the exclude file as not writable without waiting on a lock', () => {
    const url = team('info-file');
    const dir = business('info-file-biz');
    const info = path.join(dir, '.git', 'info');
    writeFile(info, 'not a directory\n');

    const initRun = init(url, dir);
    const pulled = teamai(['pull'], dir);

    expect(mcpServer(dir)).toBeUndefined();
    for (const output of [initRun.output, pulled.output]) {
      expect(output).toContain(`${path.join(info, 'exclude')} is not writable, as ${info} is not a directory`);
      expect(output).toContain(`Move ${info} aside, then run \`teamai pull\` again.`);
      expect(output).not.toContain('another teamai command held');
    }
    expect(fs.readFileSync(info, 'utf8')).toBe('not a directory\n');
    const check = doctorCheck(dir, 'MCP servers delivered to claude');
    expect(check.ok).toBe(false);
    expect(check.fix).toContain(
      `withheld: secret-api, as git would commit the file: ${path.join(info, 'exclude')} is not writable, as ${info} is not a directory. `
      + `Move ${info} aside, then run \`teamai pull\` again.`,
    );
  });

  it('creates the main repository\'s .git/info/ from a linked worktree', () => {
    const url = team('wt-no-info');
    const { worktree, infoDir } = linkedWorktree('wt-no-info');

    const initRun = init(url, worktree);

    expectDelivered(worktree, infoDir, initRun);
  });

  it.skipIf(isRoot)('reports a read-only exclude file from a linked worktree, naming the main repository\'s file', () => {
    const url = team('wt-ro-exclude');
    const { worktree, infoDir } = linkedWorktree('wt-ro-exclude');

    withReadOnlyExclude(infoDir, () => {
      init(url, worktree);
      expectWithheld(worktree, path.join(infoDir, 'exclude'), teamai(['pull'], worktree));
    });
  });

  describe('a local-agent MCP install carrying a credential', () => {
    /** Run a Claude SessionStart hook whose local-agent sync hands back one workspace `install_mcp` for `dir`; the ack it sent. */
    async function installThroughLocalAgent(dir: string): Promise<{ status: string; error?: string }> {
      const acks: Array<{ status: string; error?: string }> = [];
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        request.on('end', () => {
          response.setHeader('Content-Type', 'application/json');
          if (request.url?.endsWith('/commands/ack')) acks.push(JSON.parse(body));
          response.end(JSON.stringify(request.url?.endsWith('/local-agent/sync') ? {
            ok: true,
            cmds: [{
              id: 1, type: 'install_mcp', scope: 'workspace', workspace_path: dir, slug: 'clawpro', version: '1.0.0',
              mcp_config: { transport: 'http', url: 'https://clawpro.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
            }],
          } : { ok: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      try {
        writeFile(path.join(home, '.teamai', 'local-agent', 'config.json'), JSON.stringify({
          endpoint, token: 'fixture-token', localAgentId: 'fixture', createdAt: '2026-01-01T00:00:00.000Z', workspaceBindings: {},
        }));
        // Async: the server above answers on this process's event loop.
        const child = spawn(process.execPath, [CLI, 'hook-dispatch', 'session-start', '--tool', 'claude'], { cwd: dir, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stdin.end(JSON.stringify({ cwd: dir, session_id: 'git-info', hook_event_name: 'SessionStart', source: 'startup' }));
        const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
        // The hook leaves its background pass (`hook-dispatch --bg-only`) running in the
        // sandbox HOME; it must end before this fixture removes the local agent's state.
        await waitForDetachedChildren();
        expect(code, output).toBe(0);
        expect(acks, output).toHaveLength(1);
        return acks[0];
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        fs.rmSync(path.join(home, '.teamai', 'local-agent'), { recursive: true, force: true });
      }
    }

    it('creates .git/info/ and lists the config before writing the credential', async () => {
      const dir = business('agent-no-info');

      const ack = await installThroughLocalAgent(dir);

      expect(ack.status, ack.error).toBe('success');
      expect(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toContain(TOKEN);
      expect(teamBlock(path.join(dir, '.git', 'info'))).toMatch(/^\/\.mcp\.json$/m);
      expect(gitOk(['status', '--porcelain', '--untracked-files=all', '--', '.mcp.json'], dir)).toBe('');
    });

    it.skipIf(isRoot)('withholds it from a repository whose exclude file is read-only, naming the file', async () => {
      const dir = business('agent-ro-exclude');
      const infoDir = path.join(dir, '.git', 'info');
      let ack: { status: string; error?: string } = { status: '' };

      writeFile(path.join(infoDir, 'exclude'), '# mine\n');
      fs.chmodSync(path.join(infoDir, 'exclude'), 0o444);
      try {
        ack = await installThroughLocalAgent(dir);
      } finally {
        fs.chmodSync(path.join(infoDir, 'exclude'), 0o644);
      }

      expect(ack.status).toBe('failed');
      expect(ack.error).toContain(`${path.join(infoDir, 'exclude')} is not writable`);
      expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);
    });
  });
});
