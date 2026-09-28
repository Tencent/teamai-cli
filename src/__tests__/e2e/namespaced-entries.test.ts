import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── env, hooks and MCP by namespace, through the real CLI (#707) ───────────
//
// A `checkout` project overrides the shared API_BASE, an MCP server and a hook
// with env/checkout/, mcp/checkout/ and hooks/checkout/ files. The member
// activates the project, then leaves it:
//   1. pull delivers root + checkout, the checkout entries replacing the root
//      ones of the same name;
//   2. deactivating restores the root entries and removes checkout-only ones;
//   3. two active namespaces with the same server name, or a broken active
//      file, leave what is installed alone and name the files.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, SHELL: '/bin/bash', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function write(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('env, hooks and MCP by namespace via the real CLI (#707)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let seed: string;

  const envSh = (): string => fs.readFileSync(path.join(projectRoot, '.teamai', 'env.sh'), 'utf8');
  const mcpServers = (): Record<string, { url?: string }> => (
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')).mcpServers ?? {}
  );
  const hookCommands = (): string => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');

  /** Commit a change in the seed checkout and publish it to the team remote. */
  function publish(message: string, change: () => void): void {
    change();
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', message], seed);
    git(['push', '-q', 'origin', 'main'], seed);
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-namespaced-entries-e2e-'));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    write(seed, 'teamai.yaml', [
      'team: namespaced-entries-e2e',
      `repo: ${remote}`,
      'provider: git',
      'reviewers: []',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    settings: .claude/settings.json',
      '    mcp: .claude.json',
      '    mcpProject: .mcp.json',
      '',
    ].join('\n'));
    write(seed, 'manifest/projects.yaml', [
      'version: 1',
      'projects:',
      '  - id: checkout',
      '    resources: { env: [checkout], hooks: [checkout], mcp: [checkout] }',
      '  - id: billing',
      '    resources: { env: [billing], mcp: [billing] }',
      '',
    ].join('\n'));
    write(seed, 'env/env.yaml', [
      'variables:',
      '  - key: API_BASE',
      '    value: https://api.example.com',
      '  - key: SHARED',
      '    value: everyone',
      '',
    ].join('\n'));
    write(seed, 'env/checkout/env.yaml', [
      'variables:',
      '  - key: API_BASE',
      '    value: https://checkout.example.com',
      '  - key: CHECKOUT_ONLY',
      '    value: "yes"',
      '',
    ].join('\n'));
    // The root server reads API_BASE, so it follows the resolved env set.
    write(seed, 'mcp/mcp.yaml', [
      'servers:',
      '  - name: db',
      '    transport: http',
      '    url: ${API_BASE}/db',
      '  - name: shared',
      '    transport: http',
      '    url: https://shared.example.com/mcp',
      '',
    ].join('\n'));
    write(seed, 'mcp/checkout/mcp.yaml', [
      'servers:',
      '  - name: db',
      '    transport: http',
      '    url: https://checkout-db.example.com/mcp',
      '  - name: orders',
      '    transport: http',
      '    url: https://orders.example.com/mcp',
      '',
    ].join('\n'));
    write(seed, 'hooks/hooks.yaml', [
      'hooks:',
      '  - id: lint',
      '    description: shared lint',
      '    event: Stop',
      '    command: echo root-lint',
      '',
    ].join('\n'));
    write(seed, 'hooks/checkout/hooks.yaml', [
      'hooks:',
      '  - id: lint',
      '    description: checkout lint',
      '    event: Stop',
      '    command: echo checkout-lint',
      '',
    ].join('\n'));

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['remote', 'add', 'origin', remote], seed);
    git(['clone', '-q', remote, teamRepo], projectRoot);

    write(projectRoot, '.teamai/config.yaml', [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: ns-user',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the checkout overrides while checkout is active', async () => {
    const set = await runCLI(['projects', 'set', 'checkout'], projectRoot, home);
    expect(set.code, set.output).toBe(0);
    const pull = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);

    expect(envSh()).toContain("export API_BASE='https://checkout.example.com'");
    expect(envSh()).toContain("export CHECKOUT_ONLY='yes'");
    expect(envSh()).toContain("export SHARED='everyone'");

    const servers = mcpServers();
    expect(Object.keys(servers).sort()).toEqual(['db', 'orders', 'shared']);
    expect(servers.db?.url).toBe('https://checkout-db.example.com/mcp');

    expect(hookCommands()).toContain('echo checkout-lint');
    expect(hookCommands()).not.toContain('echo root-lint');

    const envList = await runCLI(['env', 'list'], projectRoot, home);
    expect(envList.output).toContain('API_BASE=ht****  env.yaml  (checkout, overrides root)');
    expect(envList.output).toContain('SHARED=ev****  env.yaml  (root)');
    const mcpList = await runCLI(['mcp', 'list'], projectRoot, home);
    expect(mcpList.output).toContain('from:     mcp/checkout/mcp.yaml (checkout, overrides root)');
    const hooksList = await runCLI(['hooks', 'list'], projectRoot, home);
    expect(hooksList.output).toContain('[lint] Stop  →  echo checkout-lint  (tools: all)  from checkout, overrides root');

    const status = await runCLI(['status'], projectRoot, home);
    expect(status.output).toContain('env: 3 (1 root, 2 checkout)');
    expect(status.output).toContain('mcp: 3 (1 root, 2 checkout)');
    expect(status.output).toContain('hooks: 1 (1 checkout)');
    const listRepo = await runCLI(['list', 'mcp', '--source', 'repo'], projectRoot, home);
    expect(listRepo.output).toContain('db  [http]  https://checkout-db.example.com/mcp  (checkout, overrides root)');

    const doctor = await runCLI(['doctor'], projectRoot, home);
    expect(doctor.output).toContain('env: "API_BASE" from env/checkout/env.yaml replaces env/env.yaml');
    expect(doctor.output).toContain('mcp: "db" from mcp/checkout/mcp.yaml replaces mcp/mcp.yaml');
  }, 120_000);

  it('restores the root entries and removes checkout-only ones once checkout deactivates', async () => {
    const set = await runCLI(['projects', 'set', 'billing'], projectRoot, home);
    expect(set.code, set.output).toBe(0);
    const pull = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);

    expect(envSh()).toContain("export API_BASE='https://api.example.com'");
    expect(envSh()).not.toContain('CHECKOUT_ONLY');

    const servers = mcpServers();
    expect(Object.keys(servers).sort()).toEqual(['db', 'shared']);
    // The root server's ${API_BASE} now resolves from the root env file.
    expect(servers.db?.url).toBe('https://api.example.com/db');

    expect(hookCommands()).toContain('echo root-lint');
    expect(hookCommands()).not.toContain('echo checkout-lint');
  }, 120_000);

  it('keeps what is installed when two active namespaces define one server, naming both files', async () => {
    publish('billing defines orders too', () => write(seed, 'mcp/billing/mcp.yaml', [
      'servers:',
      '  - name: orders',
      '    transport: http',
      '    url: https://billing-orders.example.com/mcp',
      '',
    ].join('\n')));
    const before = mcpServers();

    const set = await runCLI(['projects', 'set', 'checkout,billing'], projectRoot, home);
    expect(set.code, set.output).toBe(0);
    const pull = await runCLI(['pull', '--force'], projectRoot, home);

    expect(pull.output).toContain('server "orders" is defined in both mcp/checkout/mcp.yaml and mcp/billing/mcp.yaml');
    expect(mcpServers()).toEqual(before);
    // env is its own type: it still applies.
    expect(envSh()).toContain('CHECKOUT_ONLY');
  }, 120_000);

  it('keeps the exported variables when an active env file does not parse, and applies the other types', async () => {
    const before = envSh();
    publish('break the checkout env file, change the checkout hook', () => {
      write(seed, 'env/checkout/env.yaml', 'variables: [unclosed\n');
      write(seed, 'hooks/checkout/hooks.yaml', [
        'hooks:',
        '  - id: lint',
        '    description: checkout lint',
        '    event: Stop',
        '    command: echo checkout-lint-v2',
        '',
      ].join('\n'));
    });

    const pull = await runCLI(['pull', '--force'], projectRoot, home);

    expect(pull.output).toContain('env/checkout/env.yaml is not valid YAML');
    expect(pull.output).toContain('your exported env variables are unchanged');
    expect(envSh()).toBe(before);
    // Only env stopped: the hooks reconcile, which runs after it, still applied
    // the change from the same commit.
    expect(hookCommands()).toContain('echo checkout-lint-v2');
  }, 120_000);
});
