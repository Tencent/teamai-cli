/**
 * E2E (#915): OpenCode V1 and V2 in a project with `sharing.gitExclude` on.
 *
 * - V1 reads the project's opencode.json files: teamai's `instructions` in
 *   `.opencode/opencode.json` and its MCP servers in the root `opencode.json`
 *   stay there, and are listed in the git exclude block while only teamai
 *   writes them.
 * - V2 ignores `instructions`, and teamai's plugin in HOME adds the team
 *   context and rules. Once that plugin is current, the team MCP servers go to
 *   `.opencode/teamai-mcp.json`, which the plugin reads, and teamai takes its
 *   V1 entries out of the opencode.json files git does not track, keeping
 *   the member's entries there. A file git tracks is left, and doctor names it.
 *   Without a current plugin, the V1 entries stay.
 *
 * `opencode` on PATH is a stub printing the version a case sets. Each case gets
 * its own HOME, team remote (a local bare repo reached through a synthetic
 * HTTPS URL) and business repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadV2Plugin } from '../helpers/opencode-plugin.js';
import { buildPluginSource } from '../../opencode-hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

const V1 = '1.18.35';
const V2 = 'opencode v2.0.24';
const TOKEN = 'lab-token-0123456789';
const TEAM = {
  'rules/team-style.md': '# Team style\n\nRULE-SENTINEL: use tabs.\n',
  'culture.md': '# Culture\n\nCULTURE-SENTINEL: be kind.\n',
  'mcp/mcp.yaml': [
    'servers:',
    '  - name: plain-api', '    transport: http', '    url: https://plain.example.com/mcp',
    '  - name: secret-api', '    transport: http', '    url: https://api.example.com/mcp',
    '    headers:', '      Authorization: "Bearer ${LAB_TOKEN}"', '',
  ].join('\n'),
  'env/env.yaml': `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`,
};

interface Run { code: number | null; output: string }

let sandbox: string;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): any => JSON.parse(read(file));
const writeJson = (file: string, data: unknown): void => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

interface Machine {
  dir: string;
  home: string;
  run(args: string[]): Run;
  ok(args: string[]): Run;
  git(args: string[]): string;
  /** What `opencode --version` prints from now on. */
  opencode(version: string): void;
  /** `git status --porcelain -uall` of the business repo, one entry per line. */
  status(): string[];
  /** The lines of teamai's `owner` block in the clone's exclude file. */
  blockLines(owner: string): string[];
  /** Set the member's `gitExcludeEnabled` in the partition config. */
  override(value: boolean): void;
  doctor(): Map<string, { ok: boolean; fix?: string }>;
}

function machine(base: string, opts: { version: string; committed?: Record<string, string> }): Machine {
  // One directory per case, so a retry or a parallel run never meets another case's files.
  const caseDir = fs.mkdtempSync(path.join(sandbox, `${base}-`));
  const name = path.basename(caseDir);
  const home = path.join(caseDir, 'home');
  // OpenCode is installed in HOME, so the pull installs teamai's plugin there.
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  const bin = path.join(caseDir, 'bin');
  const versionFile = path.join(caseDir, 'opencode-version');
  writeFile(path.join(bin, 'opencode'), `#!/bin/sh\ncat '${versionFile}'\n`);
  fs.chmodSync(path.join(bin, 'opencode'), 0o755);
  writeFile(path.join(bin, 'opencode.cmd'), `@type "${versionFile}"\r\n`);
  const opencode = (version: string): void => writeFile(versionFile, `${version}\n`);
  opencode(opts.version);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
  };
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
    'sharing:', '  gitExclude:', '    enabled: true', '  mcp:', '    autoApply: true', '  coAuthor:', '    enabled: false', '',
  ].join('\n'));
  for (const [rel, content] of Object.entries(TEAM)) writeFile(path.join(seed, rel), content);
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
  const realDir = fs.realpathSync.native(dir);

  const teamai = (args: string[]): Run => run(process.execPath, [CLI, ...args], realDir);
  const ok = (args: string[]): Run => {
    const r = teamai(args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };
  const excludeFile = path.join(realDir, '.git', 'info', 'exclude');
  ok(['init', url, '--provider', 'git', '--agent', 'opencode', '--scope', 'project', '--force']);
  return {
    dir: realDir,
    home,
    run: teamai,
    ok,
    git: (args) => gitOk(args, realDir),
    opencode,
    status: () => gitOk(['status', '--porcelain', '-uall'], realDir).split('\n').filter(Boolean),
    blockLines: (owner) => {
      const lines = fs.existsSync(excludeFile) ? read(excludeFile).split('\n') : [];
      const start = lines.findIndex((line) => line.startsWith(`# [teamai:${owner}:start]`));
      const end = lines.indexOf(`# [teamai:${owner}:end]`);
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    },
    override: (value) => {
      const projects = path.join(home, '.teamai', 'projects');
      const [config] = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml')).filter((f) => fs.existsSync(f));
      const lines = read(config).split('\n').filter((line) => line && !line.startsWith('gitExcludeEnabled:'));
      fs.writeFileSync(config, `${[...lines, `gitExcludeEnabled: ${value}`].join('\n')}\n`);
    },
    doctor: () => {
      const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: realDir, encoding: 'utf8', env });
      const report = JSON.parse(r.stdout) as { checks: Array<{ name: string; ok: boolean; fix?: string }> };
      return new Map(report.checks.map((check) => [check.name, check]));
    },
  };
}

/** The OpenCode files of a project, as the member sees them. */
function opencodeFiles(m: Machine) {
  const at = (rel: string): string => path.join(m.dir, rel);
  const json = (rel: string): any => (fs.existsSync(at(rel)) ? readJson(at(rel)) : null);
  return {
    /** The root opencode.json, which V1 reads its MCP servers from. */
    root: json('opencode.json'),
    /** `.opencode/opencode.json`, which V1 reads `instructions` from. */
    config: json('.opencode/opencode.json'),
    /** `.opencode/teamai-mcp.json`, which teamai's plugin reads on V2. */
    mcp: json('.opencode/teamai-mcp.json'),
  };
}

const plugin = (m: Machine): string => path.join(m.home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts');

/** What teamai's installed plugin gives a V2 session in `directory`: its MCP servers and system prompt texts. */
async function v2Session(m: Machine, directory: string): Promise<{ servers: Record<string, any>; prompt: string }> {
  const host = await loadV2Plugin(read(plugin(m)), {}, directory);
  const event = { sessionID: 'ses_v2', system: [] as Array<{ type: string; text: string }> };
  await host.callbacks['session.context'](event);
  const servers = host.mcpServers();
  await host.cleanup?.();
  return { servers, prompt: event.system.map((part) => part.text).join('\n') };
}

/** The V1 entries teamai writes, as a project on V1 holds them. */
function expectV1Entries(m: Machine): void {
  const { root, config, mcp } = opencodeFiles(m);
  expect(Object.keys(root?.mcp ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
  expect(config?.instructions).toEqual(expect.arrayContaining(['.opencode/teamai-context.md', '.opencode/rules/**/*.md']));
  expect(mcp).toBeNull();
}

/** On V2 with a current plugin: no teamai entry in either opencode.json, the servers in teamai's file, and git sees none of it. */
function expectV2Delivery(m: Machine): void {
  const { root, config, mcp } = opencodeFiles(m);
  expect(root).toBeNull();
  expect(config).toBeNull();
  expect(Object.keys(mcp?.mcp ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
  expect(m.blockLines('delivered')).toContain('/.opencode/teamai-mcp.json');
  expect(m.status().filter((line) => line.includes('opencode'))).toEqual([]);
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-oc-versions-e2e-')));
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('OpenCode V2 with a current plugin', () => {
  it('gets the team MCP servers through the plugin from a file kept out of git, and nothing is written to either opencode.json', async () => {
    const m = machine('v2', { version: V2 });
    expectV2Delivery(m);
    // It holds a resolved value: listed by the MCP owner too, before the value was written.
    expect(read(path.join(m.dir, '.opencode', 'teamai-mcp.json'))).toContain(TOKEN);
    expect(m.blockLines('mcp-exclude')).toContain('/.opencode/teamai-mcp.json');

    const session = await v2Session(m, path.join(m.dir, 'src'));
    expect(session.servers).toEqual({
      'plain-api': { type: 'remote', url: 'https://plain.example.com/mcp' },
      'secret-api': { type: 'remote', url: 'https://api.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    expect(session.prompt).toContain('CULTURE-SENTINEL');
    expect(session.prompt).toContain('RULE-SENTINEL');

    // The fast path changes nothing.
    m.ok(['pull']);
    expectV2Delivery(m);
    const doctor = m.doctor();
    expect(doctor.get('MCP servers delivered to opencode')?.ok).toBe(true);
    expect(doctor.get('Team rules are active in opencode')?.ok).toBe(true);

    // The project's uninstall takes teamai's file with it, and every line that listed it.
    m.ok(['uninstall', '--force']);
    expect(opencodeFiles(m)).toEqual({ root: null, config: null, mcp: null });
    expect(m.blockLines('mcp-exclude')).toEqual([]);
    expect(m.blockLines('delivered')).toEqual([]);
    expect(m.status()).toEqual([]);
  });

  it('withholds a resolved value from teamai-mcp.json while git would commit it, and keeps the V1 servers', () => {
    const m = machine('v2-reincluded', { version: V1, committed: { '.gitignore': '!/.opencode/teamai-mcp.json\n' } });
    m.opencode(V2);
    const pulled = m.ok(['pull']);
    expect(pulled.output).toContain(`Did not write opencode's MCP servers to ${path.join(m.dir, '.opencode', 'teamai-mcp.json')}`);
    const { root, mcp } = opencodeFiles(m);
    expect(mcp).toBeNull();
    expect(Object.keys(root?.mcp ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
  });
});

describe('moving from OpenCode V1 to V2', () => {
  it('rewrites a plugin from an older build and takes the V1 entries out in the same pull; back on V1 they return', () => {
    const m = machine('v1-to-v2', { version: V1 });
    expectV1Entries(m);
    // V1: both files are teamai's alone, and listed.
    expect(m.blockLines('delivered')).toEqual(expect.arrayContaining(['/opencode.json', '/.opencode/opencode.json']));
    expect(m.status().filter((line) => line.includes('opencode'))).toEqual([]);

    // The plugin an older teamai build installed.
    fs.writeFileSync(plugin(m), `${read(plugin(m))}// an older build\n`);
    m.opencode(V2);
    m.ok(['pull']);
    expect(read(plugin(m))).toBe(buildPluginSource(path.join(m.home, '.config', 'opencode')));
    expectV2Delivery(m);
    expect(m.blockLines('delivered')).not.toContain('/opencode.json');

    m.opencode(V1);
    m.ok(['pull']);
    expectV1Entries(m);
    expect(m.blockLines('delivered')).toEqual(expect.arrayContaining(['/opencode.json', '/.opencode/opencode.json']));
    expect(m.blockLines('delivered')).not.toContain('/.opencode/teamai-mcp.json');
    expect(m.status().filter((line) => line.includes('opencode'))).toEqual([]);
  });

  it('also takes out V1 servers teamai has no record of, as it adopts them', () => {
    const m = machine('v1-to-v2-unrecorded', { version: V1 });
    for (const file of filesNamed(path.join(m.home, '.teamai'), 'managed-mcp.json')) fs.rmSync(file);
    m.opencode(V2);
    m.ok(['pull']);
    expectV2Delivery(m);
  });

  it('leaves a file git tracks as it is, and doctor names it', () => {
    const m = machine('v1-to-v2-tracked', { version: V1 });
    // The business repo commits both opencode.json files as teamai wrote them.
    m.git(['add', '-f', 'opencode.json', '.opencode/opencode.json']);
    m.git(['commit', '-q', '-m', 'opencode config']);
    const rootFile = path.join(m.dir, 'opencode.json');
    const config = path.join(m.dir, '.opencode', 'opencode.json');
    const committed = [read(rootFile), read(config)];

    m.opencode(V2);
    m.ok(['pull']);
    expect([read(rootFile), read(config)]).toEqual(committed);
    expect(m.status().filter((line) => line.includes('opencode'))).toEqual([]);
    expect(Object.keys(opencodeFiles(m).mcp?.mcp ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    const left = m.doctor().get('No OpenCode V1 entries are left in shared config files');
    expect(left?.ok).toBe(false);
    expect(left?.fix).toContain(rootFile);
    expect(left?.fix).toContain(config);
  });

  it('takes teamai\'s entries out of a file git does not track that also holds the member\'s, and keeps the member\'s', () => {
    const m = machine('v1-to-v2-mixed', { version: V1 });
    const rootFile = path.join(m.dir, 'opencode.json');
    const mine = { type: 'remote', url: 'https://mine.example.com/mcp' };
    const root = readJson(rootFile);
    root.mcp['my-server'] = mine;
    writeJson(rootFile, root);
    const config = path.join(m.dir, '.opencode', 'opencode.json');
    const own = readJson(config);
    own.instructions.push('docs/my-notes.md');
    writeJson(config, own);
    m.ok(['pull']);

    m.opencode(V2);
    m.ok(['pull']);
    expect(readJson(rootFile).mcp).toEqual({ 'my-server': mine });
    expect(read(rootFile)).not.toContain(TOKEN);
    expect(readJson(config).instructions).toEqual(['docs/my-notes.md']);
    expect(Object.keys(opencodeFiles(m).mcp?.mcp ?? {}).sort()).toEqual(['plain-api', 'secret-api']);
    // The member's file now, so git sees it.
    expect(m.status()).toContain('?? .opencode/opencode.json');
    expect(m.doctor().get('No OpenCode V1 entries are left in shared config files')?.ok).not.toBe(false);
  });
});

describe('OpenCode V2 without a current plugin', () => {
  it('keeps the V1 entries when the plugin cannot be written, and doctor says why', () => {
    // A directory where the plugin goes: the write fails.
    const m = machine('v2-no-plugin', { version: V1 });
    fs.rmSync(plugin(m));
    fs.mkdirSync(plugin(m));
    m.opencode(V2);
    m.run(['pull']);
    expectV1Entries(m);
    const check = m.doctor().get('Team rules are active in opencode');
    expect(check?.ok).toBe(false);
    expect(check?.fix).toContain(plugin(m));
    expect(check?.fix).toContain('keeps the entries OpenCode V1 reads');

    // `teamai hooks remove` takes the plugin out: doctor names it, and the next pull puts it back and moves the entries.
    fs.rmdirSync(plugin(m));
    m.ok(['hooks', 'remove']);
    expect(m.doctor().get('Team rules are active in opencode')?.fix).toContain(plugin(m));
    m.ok(['pull']);
    expectV2Delivery(m);
  });
});

describe('sharing.gitExclude off', () => {
  it('writes the V1 entries on V2 too; turning it on moves them out, and off moves them back', () => {
    const m = machine('v2-flag', { version: V2 });
    m.override(false);
    m.ok(['pull']);
    expectV1Entries(m);
    expect(m.blockLines('delivered')).toEqual([]);

    m.override(true);
    m.ok(['pull']);
    expectV2Delivery(m);

    m.override(false);
    m.ok(['pull']);
    expectV1Entries(m);
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
