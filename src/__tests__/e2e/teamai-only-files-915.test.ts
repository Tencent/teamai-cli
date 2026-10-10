/**
 * E2E (#915): a shared config file that holds nothing but teamai's entries (a
 * teamai-only file) stays out of git while `sharing.gitExclude` is on: an MCP
 * config without a resolved value, `.codex/hooks.json`, and OpenCode's
 * `.opencode/opencode.json`. The first pull that finds an entry teamai does not
 * own in it takes its git exclude line out, so git sees the member's entry, and
 * says so; a background pull keeps that notice for the next interactive pull.
 * A file with any other top-level key, or one git tracks, is never listed.
 *
 * Each case gets its own HOME, team remote (a local bare repo reached through
 * a synthetic HTTPS URL) and business repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';

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
let fakeCodexDir: string;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): any => JSON.parse(read(file));
const writeJson = (file: string, data: unknown): void => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

const mcpYaml = (...urls: Array<[string, string]>): string =>
  `servers:\n${urls.map(([name, url]) => `  - name: ${name}\n    transport: http\n    url: ${url}\n`).join('')}`;
const hooksYaml = (command: string): string =>
  `hooks:\n  - id: team-stop\n    description: Team stop\n    event: Stop\n    command: ${command}\n`;
const MEMBER_SERVER = { type: 'http', url: 'https://mine.example.com/mcp' };

/** One member's machine: a HOME, a team remote, and a business repo with teamai set up. */
interface Machine {
  dir: string;
  home: string;
  /** The environment every command of this machine runs with; a test may change it. */
  env: NodeJS.ProcessEnv;
  run(args: string[]): Run;
  ok(args: string[]): Run;
  git(args: string[]): string;
  /** `git status --porcelain -uall` of the business repo, one entry per line. */
  status(): string[];
  /** The lines of teamai's `delivered` block in the clone's exclude file. */
  deliveredLines(): string[];
  /** Commit `files` to the team remote, as a teammate would; a null content deletes the file. */
  teamCommit(files: Record<string, string | null>): void;
}

interface MachineOptions {
  files: Record<string, string>;
  agents: string;
  /** Untracked files in the business repo before init. */
  business?: Record<string, string>;
  /** Files the business repo commits before teamai is set up. */
  committed?: Record<string, string>;
  /** Directories in HOME that make a tool look installed. */
  homeDirs?: string[];
}

function machine(base: string, opts: MachineOptions): Machine {
  // One directory per case, so a retry or a parallel run never meets another case's files.
  const caseDir = fs.mkdtempSync(path.join(sandbox, `${base}-`));
  const name = path.basename(caseDir);
  const home = path.join(caseDir, 'home');
  for (const dir of ['.claude', '.codex', ...opts.homeDirs ?? []]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(home, '.codex'),
    PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
  };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (command: string, args: string[], cwd: string): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(caseDir, 'seed');
  const remote = path.join(caseDir, 'team.git');
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
    'sharing:', '  gitExclude:', '    enabled: true', '  mcp:', '    autoApply: true',
    '  hooks:', '    autoApply: true', '    requireTeamScripts: false', '  coAuthor:', '    enabled: false', '',
  ].join('\n'));
  for (const [rel, content] of Object.entries(opts.files)) writeFile(path.join(seed, rel), content);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

  const dir = path.join(caseDir, 'biz');
  writeFile(path.join(dir, 'README.md'), '# app\n');
  for (const [rel, content] of Object.entries(opts.committed ?? {})) writeFile(path.join(dir, rel), content);
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(opts.business ?? {})) writeFile(path.join(dir, rel), content);
  const realDir = fs.realpathSync.native(dir);

  const teamai = (args: string[]): Run => run(process.execPath, [CLI, ...args], realDir);
  const ok = (args: string[]): Run => {
    const r = teamai(args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  const excludeFile = path.join(realDir, '.git', 'info', 'exclude');
  ok(['init', url, '--provider', 'git', '--agent', opts.agents, '--scope', 'project', '--force']);
  return {
    dir: realDir,
    home,
    env,
    run: teamai,
    ok,
    git: (args) => gitOk(args, realDir),
    status: () => gitOk(['status', '--porcelain', '-uall'], realDir).split('\n').filter(Boolean),
    deliveredLines: () => {
      const lines = fs.existsSync(excludeFile) ? read(excludeFile).split('\n') : [];
      const start = lines.indexOf('# [teamai:delivered:start]');
      const end = lines.indexOf('# [teamai:delivered:end]');
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    },
    teamCommit: (files) => {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) fs.rmSync(path.join(seed, rel), { force: true });
        else writeFile(path.join(seed, rel), content);
      }
      gitOk(['add', '-A'], seed);
      gitOk(['commit', '-q', '-m', 'team change'], seed);
      gitOk(['push', '-q', remote, 'main'], seed);
    },
  };
}

/** The notice a pull gives when a listed teamai-only file takes in an entry teamai does not own. */
const nowVisible = (rel: string): string => `${rel} now holds entries teamai does not own, so git can see it.`;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-only-e2e-')));
  fakeCodexDir = installFakeCodex();
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
});

describe('a teamai-only MCP config', () => {
  it('stays out of git until the member adds a server, then git sees it and pull says so', () => {
    const m = machine('cursor-mcp', { agents: 'cursor', files: { 'mcp/mcp.yaml': mcpYaml(['plain-api', 'https://api.example.com/mcp']) } });
    const file = path.join(m.dir, '.cursor', 'mcp.json');
    expect(readJson(file).mcpServers['plain-api']).toBeDefined();
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');

    const data = readJson(file);
    data.mcpServers['my-own'] = MEMBER_SERVER;
    writeJson(file, data);
    const pulled = m.ok(['pull']);
    expect(pulled.output).toContain(nowVisible('.cursor/mcp.json'));
    expect(m.deliveredLines()).not.toContain('/.cursor/mcp.json');
    expect(m.status()).toContain('?? .cursor/mcp.json');
    expect(readJson(file).mcpServers['my-own']).toEqual(MEMBER_SERVER);

    // Said once: the next pull has nothing new to say.
    expect(m.ok(['pull']).output).not.toContain('now holds entries teamai does not own');
  });
});

/** Add the member's own server beside teamai's `teamServer` in a project MCP config, in its format. */
function addMemberServer(file: string, teamServer = 'plain-api'): void {
  if (file.endsWith('.toml')) {
    fs.appendFileSync(file, '\n[mcp_servers.my-own]\nurl = "https://mine.example.com/mcp"\n');
    return;
  }
  const data = readJson(file);
  const key = Object.keys(data).find((k) => typeof data[k] === 'object' && data[k] !== null && teamServer in data[k]);
  if (!key) throw new Error(`no teamai server in ${file}: ${read(file)}`);
  data[key]['my-own'] = MEMBER_SERVER;
  writeJson(file, data);
}

describe.each([
  ['copilot', '.github/mcp.json', []],
  ['codex', '.codex/config.toml', []],
  ['kiro', '.kiro/settings/mcp.json', ['.kiro']],
  ['omp', '.omp/mcp.json', ['.omp']],
  ['pi', '.pi/mcp.json', ['.pi']],
  ['workbuddy', '.workbuddy/mcp.json', ['.workbuddy']],
  ['opencode', 'opencode.json', ['.config/opencode']],
])('%s: the teamai-only %s', (agent, rel, homeDirs) => {
  it('is listed, and leaves the block with a notice once the member adds a server', () => {
    const m = machine(`mcp-${agent}`, { agents: agent, homeDirs, files: { 'mcp/mcp.yaml': mcpYaml(['plain-api', 'https://api.example.com/mcp']) } });
    const file = path.join(m.dir, rel);
    expect(read(file)).toContain('plain-api');
    expect(m.deliveredLines()).toContain(`/${rel}`);
    expect(m.status()).not.toContain(`?? ${rel}`);

    addMemberServer(file);
    expect(m.ok(['pull']).output).toContain(nowVisible(rel));
    expect(m.deliveredLines()).not.toContain(`/${rel}`);
    expect(m.status()).toContain(`?? ${rel}`);
  });
});

describe('a teamai-only .codex/hooks.json', () => {
  it('is listed while it holds only the team hooks, and leaves the block once it holds the member\'s', () => {
    const m = machine('codex-hooks', { agents: 'codex', files: { 'hooks/hooks.yaml': hooksYaml('echo team-stop') } });
    const file = path.join(m.dir, '.codex', 'hooks.json');
    expect(read(file)).toContain('echo team-stop');
    expect(m.deliveredLines()).toContain('/.codex/hooks.json');
    expect(m.status()).not.toContain('?? .codex/hooks.json');

    const data = readJson(file);
    data.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo my-own' }] });
    writeJson(file, data);
    expect(m.ok(['pull']).output).toContain(nowVisible('.codex/hooks.json'));
    expect(m.deliveredLines()).not.toContain('/.codex/hooks.json');
    expect(m.status()).toContain('?? .codex/hooks.json');
    expect(read(file)).toContain('echo my-own');
  });
});

/** Every file named `name` under `dir`, recursively. */
function filesNamed(dir: string, name: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesNamed(full, name) : entry.name === name ? [full] : [];
  });
}

/** Lose teamai's `name` records for every checkout, as a member who deleted them, or a CLI before them, would. */
function loseRecords(home: string, name: string): void {
  const manifests = filesNamed(path.join(home, '.teamai'), name);
  expect(manifests.length).toBeGreaterThan(0);
  for (const file of manifests) fs.rmSync(file);
}
const loseMcpRecords = (home: string): void => loseRecords(home, 'managed-mcp.json');

const PLAIN = mcpYaml(['plain-api', 'https://api.example.com/mcp']);

describe('what is never teamai-only', () => {
  it.each([
    ['$schema', { $schema: 'https://example.com/mcp.schema.json', mcpServers: {} }],
    ['another top-level key', { inputs: [], mcpServers: {} }],
  ])('an MCP config with %s beside the servers', (_label, content) => {
    const m = machine('mcp-other-key', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN }, business: { '.cursor/mcp.json': JSON.stringify(content) } });
    expect(read(path.join(m.dir, '.cursor', 'mcp.json'))).toContain('plain-api');
    expect(m.deliveredLines()).not.toContain('/.cursor/mcp.json');
    expect(m.status()).toContain('?? .cursor/mcp.json');
    expect(m.ok(['pull']).output).not.toContain('now holds entries teamai does not own');
  });

  it('an MCP config the business repo tracks', () => {
    const m = machine('mcp-tracked', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN }, committed: { '.cursor/mcp.json': '{"mcpServers":{}}\n' } });
    expect(read(path.join(m.dir, '.cursor', 'mcp.json'))).toContain('plain-api');
    expect(m.deliveredLines()).not.toContain('/.cursor/mcp.json');
    expect(m.status()).toContain(' M .cursor/mcp.json');
  });

  it('a single-repo team\'s .codex/hooks.json, which holds the built-in hooks', () => {
    const caseDir = fs.mkdtempSync(path.join(sandbox, 'self-codex-'));
    const home = path.join(caseDir, 'home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', CODEX_HOME: path.join(home, '.codex'), PATH: `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ''}`, FORCE_COLOR: '0',
    };
    delete env.CLAUDE_CONFIG_DIR;
    const run = (command: string, args: string[], cwd: string): string => {
      const r = spawnSync(command, args, { cwd, encoding: 'utf8', env, input: '' });
      if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
      return r.stdout;
    };
    const dir = path.join(caseDir, 'biz');
    writeFile(path.join(dir, 'README.md'), '# app\n');
    writeFile(path.join(dir, '.teamai', 'hooks', 'hooks.yaml'), hooksYaml('echo team-stop'));
    run('git', ['init', '-q', '-b', 'main'], dir);
    run('git', ['add', '-A'], dir);
    run('git', ['commit', '-q', '-m', 'app'], dir);
    // `init .` only parses the origin: an https URL on a closed local port.
    run('git', ['remote', 'add', 'origin', `https://127.0.0.1:9/team/${path.basename(caseDir)}.git`], dir);
    const realDir = fs.realpathSync.native(dir);
    // init commits the file; untracked, it still holds the built-ins the team commits for every clone.
    run(process.execPath, [CLI, 'init', '.', '--provider', 'git', '--agent', 'codex'], realDir);
    run('git', ['rm', '-q', '--cached', '.codex/hooks.json'], realDir);
    run('git', ['commit', '-q', '-m', 'untrack codex hooks'], realDir);
    run(process.execPath, [CLI, 'pull'], realDir);

    const hooks = read(path.join(realDir, '.codex', 'hooks.json'));
    // The team hooks run from the dispatcher in ~/.codex/hooks.json.
    expect(hooks).not.toContain('echo team-stop');
    expect(hooks).toContain('hook-dispatch session-start');
    expect(read(path.join(realDir, '.git', 'info', 'exclude'))).not.toContain('/.codex/hooks.json');
    expect(run('git', ['status', '--porcelain', '-uall'], realDir)).toContain('?? .codex/hooks.json');
  });
});

describe('an MCP config holding a value teamai resolved', () => {
  it('stays out of git once the member adds a server, and pull does not say git can see it', () => {
    const m = machine('mcp-resolved', {
      agents: 'cursor',
      files: {
        'mcp/mcp.yaml': 'servers:\n  - name: secret-api\n    transport: http\n    url: https://api.example.com/mcp\n'
          + '    headers:\n      Authorization: "Bearer ${LAB_TOKEN}"\n',
        'env/env.yaml': 'variables:\n  - key: LAB_TOKEN\n    value: "lab-token-0123456789"\n',
      },
    });
    const file = path.join(m.dir, '.cursor', 'mcp.json');
    expect(read(file)).toContain('lab-token-0123456789');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');

    addMemberServer(file, 'secret-api');
    expect(m.ok(['pull']).output).not.toContain('now holds entries teamai does not own');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');
    expect(readJson(file).mcpServers['my-own']).toEqual(MEMBER_SERVER);
  });
});

describe('a listed teamai-only MCP config that later gets a resolved value', () => {
  const SECRET = {
    'mcp/mcp.yaml': `${PLAIN}  - name: secret-api\n    transport: http\n    url: https://secret.example.com/mcp\n`
      + '    headers:\n      Authorization: "Bearer ${LAB_TOKEN}"\n',
    'env/env.yaml': 'variables:\n  - key: LAB_TOKEN\n    value: "lab-token-delivered-915"\n',
  };
  const mcpExcludeLines = (m: Machine): string[] => {
    const lines = read(path.join(m.dir, '.git', 'info', 'exclude')).split('\n');
    const start = lines.findIndex((line) => line.startsWith('# [teamai:mcp-exclude:start]'));
    const end = lines.indexOf('# [teamai:mcp-exclude:end]');
    return start < 0 || end < start ? [] : lines.slice(start + 1, end);
  };
  const turnOff = (m: Machine): void => {
    const projects = path.join(m.home, '.teamai', 'projects');
    for (const dir of fs.readdirSync(projects)) {
      const config = path.join(projects, dir, 'config.yaml');
      if (fs.existsSync(config)) fs.appendFileSync(config, 'gitExcludeEnabled: false\n');
    }
  };

  it.each([
    ['the member adds a server', (m: Machine) => addMemberServer(path.join(m.dir, '.cursor', 'mcp.json'))],
    ['the option goes off', turnOff],
  ])('keeps it out of git in its own block once %s', (_label, leave) => {
    const m = machine('mcp-later-secret', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN } });
    const file = path.join(m.dir, '.cursor', 'mcp.json');
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');

    m.teamCommit(SECRET);
    const resolved = m.ok(['pull']);
    expect(read(file)).toContain('lab-token-delivered-915');
    expect(mcpExcludeLines(m), resolved.output).toEqual(['/.cursor/mcp.json']);

    leave(m);
    const pulled = m.ok(['pull']);
    expect(m.deliveredLines(), pulled.output).not.toContain('/.cursor/mcp.json');
    expect(read(file)).toContain('lab-token-delivered-915');
    expect(m.git(['check-ignore', '-q', '.cursor/mcp.json'])).toBe('');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');
  });
});

describe('ownership without a record', () => {
  it('lists a file written before the upgrade, whose servers teamai has no record of, by its content', () => {
    const m = machine('mcp-before-upgrade', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN } });
    // As a CLI before #915 left it: no records, no list, no block.
    loseMcpRecords(m.home);
    fs.writeFileSync(path.join(m.dir, '.git', 'info', 'exclude'), '');
    expect(m.status()).toContain('?? .cursor/mcp.json');

    m.ok(['pull']);
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');
  });

  it('lists a .codex/hooks.json written before the upgrade, whose team hooks teamai has no record of, by its content', () => {
    const m = machine('codex-hooks-before-upgrade', { agents: 'codex', files: { 'hooks/hooks.yaml': hooksYaml('echo team-stop') } });
    loseRecords(m.home, 'managed-main-checkout-hooks.json');
    fs.writeFileSync(path.join(m.dir, '.git', 'info', 'exclude'), '');
    expect(m.status()).toContain('?? .codex/hooks.json');

    m.ok(['pull']);
    expect(read(path.join(m.dir, '.codex', 'hooks.json'))).toContain('echo team-stop');
    expect(m.deliveredLines()).toContain('/.codex/hooks.json');
    expect(m.status()).not.toContain('?? .codex/hooks.json');
  });

  it('takes a file holding a member server no team version matches out of the delivered block, and cleans and lists one holding a removed team server\'s copy', () => {
    const m = machine('mcp-unrecorded', {
      agents: 'cursor',
      files: { 'mcp/mcp.yaml': mcpYaml(['plain-api', 'https://api.example.com/mcp'], ['old-api', 'https://old.example.com/mcp']) },
    });
    const file = path.join(m.dir, '.cursor', 'mcp.json');
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');

    // The team drops old-api, and teamai's records of the copies are lost: old-api's copy is unrecorded.
    m.teamCommit({ 'mcp/mcp.yaml': PLAIN });
    loseMcpRecords(m.home);
    m.ok(['pull']);
    expect(Object.keys(readJson(file).mcpServers)).toEqual(['plain-api']);
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');
    expect(m.status()).not.toContain('?? .cursor/mcp.json');

    // An unrecorded server of the member's, matching no team version. With no record, the MCP sync cannot
    // tell it holds no value teamai resolved, so the file gets its own mcp-exclude line: the delivered
    // block's line never counted for that. It leaves the delivered block, and git still does not see it.
    loseMcpRecords(m.home);
    addMemberServer(file);
    expect(m.ok(['pull']).output).not.toContain('now holds entries teamai does not own');
    expect(readJson(file).mcpServers['my-own']).toEqual(MEMBER_SERVER);
    expect(m.deliveredLines()).not.toContain('/.cursor/mcp.json');
    expect(read(path.join(m.dir, '.git', 'info', 'exclude'))).toMatch(/# \[teamai:mcp-exclude:start\][^\n]*\n\/\.cursor\/mcp\.json\n/);
    expect(m.status()).not.toContain('?? .cursor/mcp.json');
  });
});

/**
 * Put a `git` first on `m`'s PATH that fails, as a broken repository would,
 * every `ls-files` or `check-ignore` naming a path that ends in `suffix`, and
 * runs the real git for anything else.
 */
function failGitFor(m: Machine, suffix: string): void {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: m.env }).stdout.trim();
  const bin = fs.mkdtempSync(path.join(path.dirname(m.dir), 'failing-git-'));
  writeFile(path.join(bin, 'git'), [
    '#!/bin/sh',
    'query=no; named=no',
    'for arg in "$@"; do',
    '  case "$arg" in ls-files|check-ignore) query=yes ;; esac',
    `  case "$arg" in *${suffix}) named=yes ;; esac`,
    'done',
    'if [ "$query" = yes ] && [ "$named" = yes ]; then echo "fatal: index file corrupt" >&2; exit 128; fi',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  m.env.PATH = `${bin}${path.delimiter}${m.env.PATH ?? ''}`;
}

describe('a listed teamai-only file git cannot answer for', () => {
  it('keeps its line, and pull and doctor say git could not tell', () => {
    const m = machine('mcp-git-unknown', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN } });
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');

    failGitFor(m, 'mcp.json');
    const pulled = m.run(['pull']);
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');
    expect(pulled.output).toContain('git could not say whether it tracks .cursor/mcp.json');

    const doctor = m.run(['doctor']);
    expect(doctor.output).toContain('git could not say what');
    expect(m.deliveredLines()).toContain('/.cursor/mcp.json');
  });
});

describe('a background pull', () => {
  it('keeps the notice for the next interactive pull, which says it once', () => {
    const m = machine('mcp-silent', { agents: 'cursor', files: { 'mcp/mcp.yaml': PLAIN } });
    addMemberServer(path.join(m.dir, '.cursor', 'mcp.json'));
    expect(m.ok(['pull', '--silent']).output).not.toContain('now holds entries teamai does not own');
    expect(m.status()).toContain('?? .cursor/mcp.json');

    expect(m.ok(['pull']).output).toContain(nowVisible('.cursor/mcp.json'));
    expect(m.ok(['pull']).output).not.toContain('now holds entries teamai does not own');
  });
});

describe('a teamai-only .opencode/opencode.json (OpenCode V1)', () => {
  it('is listed while its instructions are only teamai\'s, and leaves the block once the member adds one', () => {
    const m = machine('opencode-instructions', {
      agents: 'opencode',
      homeDirs: ['.config/opencode'],
      files: { 'rules/team-style.md': '# Team style\n\nUse tabs.\n' },
    });
    const file = path.join(m.dir, '.opencode', 'opencode.json');
    expect(readJson(file).instructions.length).toBeGreaterThan(0);
    expect(m.deliveredLines()).toContain('/.opencode/opencode.json');
    expect(m.status()).not.toContain('?? .opencode/opencode.json');

    const data = readJson(file);
    data.instructions.push('docs/my-notes.md');
    writeJson(file, data);
    expect(m.ok(['pull']).output).toContain(nowVisible('.opencode/opencode.json'));
    expect(m.deliveredLines()).not.toContain('/.opencode/opencode.json');
    expect(m.status()).toContain('?? .opencode/opencode.json');
  });
});
