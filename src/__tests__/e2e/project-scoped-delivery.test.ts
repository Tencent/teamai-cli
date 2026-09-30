import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── project-scoped hooks / MCP / env e2e (issue #668, #707) ────────────────
//
// The unit suites drive each filter directly. This is the end-to-end leg,
// through the ACTUAL compiled CLI, for the three resource types whose delivery
// costs something on every session. Since #707 a project scopes them with
// `<type>/<ns>/` files declared in `resources:` rather than per-entry keys:
//   1. a directory bound to `checkout` receives checkout's MCP server, hook and
//      env variable, and NOT billing's;
//   2. a server in checkout's file that also carries the deprecated `roles:`
//      reaches only a member matching both;
//   3. `projects set` to another project REMOVES what the first one delivered —
//      the guarantee that makes the filter safe to change your mind about.
//
// Both MCP render paths are covered: Claude's JSON in project scope, and — in a
// second user-scope leg — Codex's TOML, since Codex has no project-scope MCP
// location. A filter that drops a server before rendering has to drop it from
// both.

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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('project-scoped hooks, MCP servers and env variables via the real CLI (issue #668)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let remote: string;

  const envShPath = (): string => path.join(projectRoot, '.teamai', 'env.sh');
  const readEnvSh = (): string => fs.readFileSync(envShPath(), 'utf8');
  // In project scope Claude's MCP lands in <projectRoot>/.mcp.json (toolPaths
  // `mcpProject`), not the user-scope ~/.claude.json.
  const readClaudeMcp = (): string => fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8');
  const claudeSettingsPath = (): string => path.join(home, '.claude', 'settings.json');

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scoped-delivery-e2e-'));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    // The MCP reconcile only targets a tool it considers installed, probed via
    // its skills dir — so the sandbox has to look like a Claude checkout.
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'env'), { recursive: true });

    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: scoped-delivery-e2e',
      `repo: ${remote}`,
      'provider: git',
      'reviewers: []',
      'sharing:',
      '  hooks:',
      '    autoApply: true',
      '  mcp:',
      '    autoApply: true',
      '',
      // No toolPaths override on purpose: the built-in defaults are what carry
      // claude's `mcpProject` (<root>/.mcp.json). An override that lists only
      // `skills` drops it, and MCP then has no project-scope target at all.
    ].join('\n'));

    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: frontend',
      '    description: Frontend',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '  - id: devops',
      '    description: DevOps',
      '    resources:',
      '      knowledge: []',
      '      skills: []',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: checkout',
      '    name: Checkout',
      '    resources:',
      '      skills: []',
      '      env: [checkout]',
      '      hooks: [checkout]',
      '      mcp: [checkout]',
      '  - id: billing',
      '    name: Billing',
      '    resources:',
      '      skills: []',
      '      env: [billing]',
      '      hooks: [billing]',
      '      mcp: [billing]',
      '',
    ].join('\n'));

    const writeSeed = (relativePath: string, lines: string[]): void => {
      fs.mkdirSync(path.dirname(path.join(seed, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(seed, relativePath), lines.join('\n'));
    };
    writeSeed('mcp/mcp.yaml', [
      'servers:',
      '  - name: shared-api',
      '    transport: http',
      '    url: https://shared.example.com/mcp',
      '',
    ]);
    writeSeed('mcp/checkout/mcp.yaml', [
      'servers:',
      '  - name: checkout-api',
      '    transport: http',
      '    url: https://checkout.example.com/mcp',
      '  - name: fe-checkout-api',
      '    transport: http',
      '    url: https://fe-checkout.example.com/mcp',
      '    roles: [frontend]',
      '',
    ]);
    writeSeed('mcp/billing/mcp.yaml', [
      'servers:',
      '  - name: billing-api',
      '    transport: http',
      '    url: https://billing.example.com/mcp',
      '',
    ]);

    writeSeed('hooks/hooks.yaml', [
      'hooks:',
      '  - id: shared-guard',
      '    description: everyone',
      '    event: Stop',
      '    command: echo shared',
      '',
    ]);
    writeSeed('hooks/checkout/hooks.yaml', [
      'hooks:',
      '  - id: checkout-guard',
      '    description: checkout only',
      '    event: Stop',
      '    command: echo checkout',
      '',
    ]);
    writeSeed('hooks/billing/hooks.yaml', [
      'hooks:',
      '  - id: billing-guard',
      '    description: billing only',
      '    event: Stop',
      '    command: echo billing',
      '',
    ]);

    // DEVOPS_ONLY carries `roles:`, which env no longer reads: it reaches nobody.
    writeSeed('env/env.yaml', [
      'variables:',
      '  - key: DEVOPS_ONLY',
      '    value: devops-secret',
      '    roles: [devops]',
      '  - key: SHARED_URL',
      '    value: https://shared.example.com',
      '',
    ]);
    writeSeed('env/checkout/env.yaml', [
      'variables:',
      '  - key: CHECKOUT_URL',
      '    value: https://checkout.example.com',
      '',
    ]);
    writeSeed('env/billing/env.yaml', [
      'variables:',
      '  - key: BILLING_URL',
      '    value: https://billing.example.com',
      '',
    ]);

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teamRepo], projectRoot);

    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: scoped-user',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      'primaryRole: frontend',
      'additionalRoles: []',
      'enabledAgents: [claude, codex]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers only the bound project\'s entries, applies a deprecated roles: on top, and removes them on rebind', async () => {
    // ── Bind to checkout ───────────────────────────────────────────────────
    const setCheckout = await runCLI(['projects', 'set', 'checkout'], projectRoot, home);
    expect(setCheckout.code, setCheckout.output).toBe(0);

    const pullCheckout = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pullCheckout.code, pullCheckout.output).toBe(0);

    // env: checkout's and the shared variable land in env.sh; billing's does
    // not, and neither does the devops-only one (this member is frontend).
    const envCheckout = readEnvSh();
    expect(envCheckout).toContain('CHECKOUT_URL');
    expect(envCheckout).toContain('SHARED_URL');
    expect(envCheckout).not.toContain('BILLING_URL');
    expect(envCheckout).not.toContain('DEVOPS_ONLY');

    // mcp: checkout's, the role-scoped one in checkout's file (frontend AND
    // checkout both match) and the shared one are installed for Claude;
    // billing's is not.
    const mcpCheckout = readClaudeMcp();
    expect(mcpCheckout).toContain('checkout-api');
    expect(mcpCheckout).toContain('fe-checkout-api');
    expect(mcpCheckout).toContain('shared-api');
    expect(mcpCheckout).not.toContain('billing-api');

    // hooks: the same split, in the settings file the reconcile writes.
    const claudeSettings = fs.readFileSync(claudeSettingsPath(), 'utf8');
    expect(claudeSettings).toContain('echo checkout');
    expect(claudeSettings).toContain('echo shared');
    expect(claudeSettings).not.toContain('echo billing');

    // ── Upgrade path: repo unchanged, CLI newer ────────────────────────────
    // A CLI that honoured `roles:` on env left DEVOPS_ONLY in env.sh, and the
    // recorded revision still matches HEAD. A plain pull takes
    // the "Already synced" fast path and must still rewrite env.sh from the
    // filtered set, or the withheld secret stays exported until --force.
    fs.appendFileSync(envShPath(), "export DEVOPS_ONLY='devops-secret'\n");
    const pullUnchanged = await runCLI(['pull'], projectRoot, home);
    expect(pullUnchanged.code, pullUnchanged.output).toBe(0);
    expect(pullUnchanged.output).toContain('Already synced');
    const envUnchanged = readEnvSh();
    expect(envUnchanged).toContain('CHECKOUT_URL');
    expect(envUnchanged).not.toContain('DEVOPS_ONLY');

    // ── Rebind to billing: what checkout delivered must be REMOVED ─────────
    const setBilling = await runCLI(['projects', 'set', 'billing'], projectRoot, home);
    expect(setBilling.code, setBilling.output).toBe(0);

    // Between the rebind and the pull, env.sh still exports checkout's
    // variable. doctor must say so rather than pass on "nothing owed": the
    // previous project's secrets are live in every new shell until the pull.
    const doctorBeforePull = await runCLI(['doctor'], projectRoot, home);
    expect(doctorBeforePull.code, doctorBeforePull.output).toBe(1);
    expect(doctorBeforePull.output).toContain('still exports CHECKOUT_URL');
    expect(doctorBeforePull.output).not.toContain('still exports SHARED_URL');

    const pullBilling = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pullBilling.code, pullBilling.output).toBe(0);

    const envBilling = readEnvSh();
    expect(envBilling).toContain('BILLING_URL');
    expect(envBilling).toContain('SHARED_URL');
    expect(envBilling).not.toContain('CHECKOUT_URL');

    const mcpBilling = readClaudeMcp();
    expect(mcpBilling).toContain('billing-api');
    expect(mcpBilling).toContain('shared-api');
    expect(mcpBilling).not.toContain('checkout-api');
    // The role-scoped server in checkout's file: the role still matches, the
    // namespace is no longer active, so it goes. An OR would have kept it.
    expect(mcpBilling).not.toContain('fe-checkout-api');

    const settingsBilling = fs.readFileSync(claudeSettingsPath(), 'utf8');
    expect(settingsBilling).toContain('echo billing');
    expect(settingsBilling).not.toContain('echo checkout');
  }, 120_000);

  it('reports where each entry comes from in mcp list, hooks list and env list', async () => {
    const mcpList = await runCLI(['mcp', 'list'], projectRoot, home);
    expect(mcpList.code, mcpList.output).toBe(0);
    expect(mcpList.output).toContain('from:     mcp/billing/mcp.yaml (billing)');
    expect(mcpList.output).toContain('from:     mcp/mcp.yaml (root)');
    expect(mcpList.output).not.toContain('checkout-api');

    const hooksList = await runCLI(['hooks', 'list'], projectRoot, home);
    expect(hooksList.code, hooksList.output).toBe(0);
    expect(hooksList.output).toContain('echo billing  (tools: all)  from billing');
    expect(hooksList.output).not.toContain('echo checkout');

    const envList = await runCLI(['env', 'list'], projectRoot, home);
    expect(envList.code, envList.output).toBe(0);
    expect(envList.output).toMatch(/BILLING_URL=\S+ {2}env\.yaml {2}\(billing\)/);
    // The delivery notice for the withheld per-entry `roles:` key names
    // DEVOPS_ONLY in its warning; the variable itself must stay out of the
    // delivered list, where it would print as `DEVOPS_ONLY=<masked>`.
    expect(envList.output).not.toMatch(/DEVOPS_ONLY=/);
  }, 60_000);

  it('warns about per-entry projects:, naming the namespace file to move the entry to', async () => {
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
    fs.writeFileSync(path.join(teamRepo, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: legacy-api',
      '    transport: http',
      '    url: https://legacy.example.com/mcp',
      '    projects: [billing]',
      '',
    ].join('\n'));

    const pull = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('mcp/mcp.yaml: server "legacy-api" is scoped with per-entry `projects:`');
    expect(pull.output).toContain('Move it to mcp/billing/mcp.yaml and drop the key.');
    expect(readClaudeMcp()).not.toContain('legacy-api');
  }, 60_000);

  // A typo of a scoping key (#822) must not widen who gets the server.
  it('installs no server that carries an unknown key, and warns naming the file, server and key', async () => {
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
    fs.writeFileSync(path.join(teamRepo, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: typo-api',
      '    transport: http',
      '    url: https://typo.example.com/mcp',
      '    role: [frontend]',
      '  - name: shared-api',
      '    transport: http',
      '    url: https://shared.example.com/mcp',
      '',
    ].join('\n'));

    const pull = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toMatch(/mcp\/mcp\.yaml: server "typo-api".*\brole\b/);
    expect(readClaudeMcp()).not.toContain('typo-api');
    expect(readClaudeMcp()).toContain('shared-api');
  }, 60_000);
});

// Codex has no project-scope MCP location (no `mcpProject` in toolPaths), so its
// TOML renderer is only reachable from user scope. It is the second of the two
// MCP render paths: a filter that drops a server before rendering has to drop it
// from the TOML file as much as from Claude's JSON.
describe('project-scoped MCP reaches the Codex TOML renderer too (issue #668)', () => {
  let sandbox: string;
  let home: string;
  let workdir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scoped-codex-e2e-'));
    home = path.join(sandbox, 'home');
    workdir = path.join(sandbox, 'work');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team.git');
    const teamRepo = path.join(home, '.teamai', 'team-repo');

    fs.mkdirSync(workdir, { recursive: true });
    // Codex must look installed for the reconcile to target it.
    fs.mkdirSync(path.join(home, '.codex', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });

    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: scoped-codex-e2e',
      `repo: ${remote}`,
      'provider: git',
      'reviewers: []',
      'sharing:',
      '  mcp:',
      '    autoApply: true',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: checkout',
      '    name: Checkout',
      '    resources:',
      '      skills: []',
      '      env: [checkout]',
      '      hooks: [checkout]',
      '      mcp: [checkout]',
      '  - id: billing',
      '    name: Billing',
      '    resources:',
      '      skills: []',
      '      env: [billing]',
      '      hooks: [billing]',
      '      mcp: [billing]',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(seed, 'mcp', 'checkout'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'mcp', 'billing'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'mcp', 'checkout', 'mcp.yaml'), [
      'servers:',
      '  - name: checkout-api',
      '    transport: stdio',
      '    command: echo',
      '    args: [checkout]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'mcp', 'billing', 'mcp.yaml'), [
      'servers:',
      '  - name: billing-api',
      '    transport: stdio',
      '    command: echo',
      '    args: [billing]',
      '',
    ].join('\n'));

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teamRepo], home);

    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: codex-user',
      'updatePolicy: auto',
      'scope: user',
      'additionalRoles: []',
      'projects: [checkout]',
      'enabledAgents: [codex]',
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('renders only the bound project\'s server into ~/.codex/config.toml', async () => {
    const pull = await runCLI(['pull', '--force'], workdir, home);
    expect(pull.code, pull.output).toBe(0);

    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('checkout-api');
    expect(toml).not.toContain('billing-api');
  }, 120_000);
});
