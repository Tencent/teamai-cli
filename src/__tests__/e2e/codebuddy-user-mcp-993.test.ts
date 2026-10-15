/**
 * E2E (#993 bug 10): CodeBuddy reads exactly one user MCP file, the first that
 * exists of ~/.codebuddy/.mcp.json, ~/.codebuddy/mcp.json and ~/.codebuddy.json,
 * and does not merge them. teamai writes its servers to that file, creates
 * ~/.codebuddy/.mcp.json only when none exists, moves its own entries out of a
 * file CodeBuddy no longer reads, and doctor warns while they sit there.
 *
 * Each case gets its own HOME and team remote: a local bare repo reached
 * through a synthetic HTTPS URL (`url.<path>.insteadOf` in that HOME).
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

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebuddy-user-mcp-993-')));
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));

const TEAM_SERVER = { type: 'http', url: 'https://team.example.com/mcp' };
const MEMBER_SERVER = { type: 'stdio', command: 'my-user-server', args: [] };

/** A member's machine: its own HOME, and a team whose MCP server goes to CodeBuddy. */
function machine(name: string, extraServers: Array<{ name: string; url: string }> = [], tools = ['codebuddy']) {
  // A fresh directory per call: the runner retries a failed case once.
  const dir = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const env = (): NodeJS.ProcessEnv => {
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
    delete base.TEAMAI_HOME;
    return base;
  };
  const run = (command: string, args: string[], cwd = work): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): void => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  };
  const teamai = (...args: string[]): Run => run(process.execPath, [CLI, ...args]);
  const teamaiOk = (...args: string[]): Run => {
    const r = teamai(...args);
    if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
    return r;
  };

  const url = `https://git.example.com/team/${path.basename(dir)}.git`;
  const seed = path.join(dir, 'seed');
  const remote = path.join(dir, 'team.git');
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${path.basename(dir)}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
    'sharing:', '  mcp:', '    autoApply: true', '',
  ].join('\n'));
  const writeTeamMcp = (servers: Array<{ name: string; url: string }>): void => {
    writeFile(path.join(seed, 'mcp', 'mcp.yaml'), servers.length === 0 ? 'servers: []\n' : ['servers:', ...servers.flatMap((s) => [
      `  - name: ${s.name}`, '    transport: http', `    url: ${s.url}`, `    tools: [${tools.join(', ')}]`,
    ]), ''].join('\n'));
  };
  writeTeamMcp([{ name: 'tm-user', url: TEAM_SERVER.url }, ...extraServers]);
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

  const file = {
    dotMcp: path.join(home, '.codebuddy', '.mcp.json'),
    mcp: path.join(home, '.codebuddy', 'mcp.json'),
    legacy: path.join(home, '.codebuddy.json'),
  };
  const servers = (f: string): Record<string, unknown> | undefined =>
    fs.existsSync(f) ? readJson(f).mcpServers : undefined;
  const init = (): Run => {
    const started = teamaiOk('init', url, '--provider', 'git', '--agent', 'codebuddy', '--scope', 'user', '--force');
    const pulled = teamaiOk('pull');
    return { ...pulled, output: `${started.output}${pulled.output}` };
  };
  /** What an earlier teamai recorded: no file in its CodeBuddy records. */
  const forgetRecordedFile = (): void => {
    const manifest = path.join(home, '.teamai', 'managed-mcp.json');
    const data = readJson(manifest);
    for (const records of Object.values(data) as Array<Array<Record<string, unknown>>>) {
      for (const record of records) delete record.file;
    }
    fs.writeFileSync(manifest, JSON.stringify(data, null, 2));
  };
  /** The team publishes a new set of MCP servers. */
  const publishTeamMcp = (servers: Array<{ name: string; url: string }>): void => {
    writeTeamMcp(servers);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'mcp'], seed);
    gitOk(['push', '-q', remote, 'main'], seed);
  };
  const loseManifest = (): void => fs.rmSync(path.join(home, '.teamai', 'managed-mcp.json'));
  return { home, url, file, servers, init, teamai, teamaiOk, forgetRecordedFile, publishTeamMcp, loseManifest };
}

describe('CodeBuddy user MCP goes to the file CodeBuddy reads (#993 bug 10)', () => {
  it('leaves another tool\'s server in a CodeBuddy lookup file that links to that tool\'s file', () => {
    const m = machine('linked-lookup', [], ['claude', 'codebuddy']);
    const claudeFile = path.join(m.home, '.claude.json');
    writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    fs.symlinkSync(claudeFile, m.file.mcp);
    writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }));
    fs.mkdirSync(path.join(m.home, '.claude'), { recursive: true });
    m.teamaiOk('init', m.url, '--provider', 'git', '--agent', 'claude,codebuddy', '--scope', 'user', '--force');
    m.teamaiOk('pull');
    expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
    expect(m.servers(claudeFile)).toEqual({ 'tm-user': TEAM_SERVER });

    m.teamaiOk('pull', '--force');
    // Claude's server, read by CodeBuddy's later lookup file through the link, is Claude's.
    expect(m.servers(claudeFile)).toEqual({ 'tm-user': TEAM_SERVER });
    expect(fs.lstatSync(m.file.mcp).isSymbolicLink()).toBe(true);
  });

  it('leaves the server of a tool no longer detected in a CodeBuddy lookup file that links to its file', () => {
    const m = machine('linked-lookup-gone', [], ['claude', 'codebuddy']);
    const claudeFile = path.join(m.home, '.claude.json');
    writeFile(claudeFile, JSON.stringify({ mcpServers: {} }));
    fs.symlinkSync(claudeFile, m.file.mcp);
    writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }));
    fs.mkdirSync(path.join(m.home, '.claude'), { recursive: true });
    m.teamaiOk('init', m.url, '--provider', 'git', '--agent', 'claude,codebuddy', '--scope', 'user', '--force');
    m.teamaiOk('pull');
    expect(m.servers(claudeFile)).toEqual({ 'tm-user': TEAM_SERVER });

    // Claude is no longer installed here; its file and its record stay.
    fs.rmSync(path.join(m.home, '.claude'), { recursive: true, force: true });
    m.teamaiOk('pull', '--force');
    expect(m.servers(claudeFile)).toEqual({ 'tm-user': TEAM_SERVER });
  });

  it('creates ~/.codebuddy/.mcp.json when no CodeBuddy user MCP file exists, and keeps a server the member adds there', () => {
    const m = machine('fresh');
    m.init();
    expect(m.servers(m.file.dotMcp)).toEqual({ 'tm-user': TEAM_SERVER });
    expect(fs.existsSync(m.file.mcp)).toBe(false);
    expect(fs.existsSync(m.file.legacy)).toBe(false);

    // What `codebuddy mcp add -s user my-user ...` does: it writes the file CodeBuddy reads.
    const data = readJson(m.file.dotMcp);
    data.mcpServers['my-user'] = MEMBER_SERVER;
    fs.writeFileSync(m.file.dotMcp, JSON.stringify(data, null, 2));
    m.teamaiOk('pull', '--force');
    expect(m.servers(m.file.dotMcp)).toEqual({ 'tm-user': TEAM_SERVER, 'my-user': MEMBER_SERVER });
    expect(fs.existsSync(m.file.mcp)).toBe(false);
  }, 120_000);

  it('writes to ~/.codebuddy/.mcp.json beside the member\'s servers, and uninstall removes only teamai\'s', () => {
    const m = machine('dot-mcp');
    writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }, null, 2));
    m.init();
    expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
    expect(fs.existsSync(m.file.mcp)).toBe(false);

    const doctor = m.teamai('doctor');
    expect(doctor.output).not.toContain("which codebuddy does not read");

    m.teamaiOk('uninstall', '--force');
    expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER });
  }, 120_000);

  it('writes to an existing ~/.codebuddy/mcp.json without creating ~/.codebuddy/.mcp.json', () => {
    const m = machine('mcp');
    writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }, null, 2));
    m.init();
    expect(m.servers(m.file.mcp)).toEqual({ 'my-user': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
    expect(fs.existsSync(m.file.dotMcp)).toBe(false);
  }, 120_000);

  it('writes to the legacy ~/.codebuddy.json rather than hide its servers behind a new file, and mcp remove takes teamai\'s back out', () => {
    const m = machine('legacy');
    const legacy = { projects: { '/work/app': { mcpServers: { local: MEMBER_SERVER } } }, mcpServers: { 'usr-srv': MEMBER_SERVER } };
    writeFile(m.file.legacy, JSON.stringify(legacy, null, 2));
    m.init();
    expect(fs.existsSync(m.file.dotMcp)).toBe(false);
    expect(fs.existsSync(m.file.mcp)).toBe(false);
    expect(readJson(m.file.legacy)).toEqual({ ...legacy, mcpServers: { 'usr-srv': MEMBER_SERVER, 'tm-user': TEAM_SERVER } });

    const list = m.teamaiOk('mcp', 'list');
    expect(list.output).toMatch(/codebuddy\s+~\/\.codebuddy\.json/);
    expect(list.output).toMatch(/installed: codebuddy/);

    m.teamaiOk('mcp', 'remove');
    expect(readJson(m.file.legacy)).toEqual(legacy);
  }, 120_000);

  for (const recorded of ['records the file', 'an earlier teamai recorded no file'] as const) {
    it(`moves only teamai's entries out of a file CodeBuddy no longer reads, and doctor warns until then (${recorded})`, () => {
      const m = machine(recorded === 'records the file' ? 'shadowed' : 'shadowed-legacy-record');
      writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'mine-old': MEMBER_SERVER } }, null, 2));
      m.init();
      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
      if (recorded === 'an earlier teamai recorded no file') m.forgetRecordedFile();

      // The member then runs `codebuddy mcp add -s user`, which creates the file CodeBuddy reads first.
      writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }, null, 2));

      const before = m.teamai('doctor');
      expect(before.output).toContain(`teamai's MCP servers for codebuddy (tm-user) are in ${m.file.mcp}, which codebuddy does not read`);
      expect(before.output).toContain(m.file.dotMcp);
      const list = m.teamaiOk('mcp', 'list');
      expect(list.output).toMatch(/codebuddy\s+~\/\.codebuddy\/\.mcp\.json/);
      expect(list.output).toContain('teamai\'s tm-user is still in ~/.codebuddy/mcp.json, which codebuddy does not read: run `teamai pull`');

      m.teamaiOk('pull', '--force');
      expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER });

      const after = m.teamai('doctor');
      expect(after.output).not.toContain('which codebuddy does not read');

      m.teamaiOk('uninstall', '--force');
      expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER });
      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER });
    }, 180_000);
  }

  it('uninstall removes teamai\'s servers from the file it recorded, before a pull moved them', () => {
    const m = machine('shadowed-uninstall');
    writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'mine-old': MEMBER_SERVER } }, null, 2));
    m.init();
    m.forgetRecordedFile();
    writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: { 'my-user': MEMBER_SERVER } }, null, 2));

    m.teamaiOk('uninstall', '--force');
    expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER });
    expect(m.servers(m.file.dotMcp)).toEqual({ 'my-user': MEMBER_SERVER });
  }, 120_000);

  // An earlier teamai always created ~/.codebuddy/mcp.json, which hides the member's ~/.codebuddy.json.
  const LEGACY = { projects: { '/work/app': { mcpServers: { local: MEMBER_SERVER } } }, mcpServers: { 'usr-srv': MEMBER_SERVER } };
  for (const owned of ['recorded by an earlier teamai', 'unrecorded, equal to the team\'s render'] as const) {
    it(`moves teamai's servers out of a ~/.codebuddy/mcp.json holding nothing else into ~/.codebuddy.json, and deletes it (${owned})`, () => {
      const m = machine(owned.startsWith('recorded') ? 'upgrade-recorded' : 'upgrade-adopted');
      let first: Run;
      if (owned.startsWith('recorded')) {
        writeFile(m.file.mcp, '{}');
        m.init();
        expect(m.servers(m.file.mcp)).toEqual({ 'tm-user': TEAM_SERVER });
        m.forgetRecordedFile();
        writeFile(m.file.legacy, JSON.stringify(LEGACY, null, 2));
        first = m.teamaiOk('pull', '--force');
      } else {
        writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'tm-user': TEAM_SERVER } }, null, 2));
        writeFile(m.file.legacy, JSON.stringify(LEGACY, null, 2));
        first = m.init();
      }
      expect(fs.existsSync(m.file.mcp)).toBe(false);
      expect(fs.existsSync(m.file.dotMcp)).toBe(false);
      expect(readJson(m.file.legacy)).toEqual({ ...LEGACY, mcpServers: { 'usr-srv': MEMBER_SERVER, 'tm-user': TEAM_SERVER } });
      expect(first.output).toContain(`Moved teamai's MCP servers for codebuddy (tm-user) from ${m.file.mcp}`);

      const again = m.teamaiOk('pull', '--force');
      expect(again.output).not.toContain('Moved teamai\'s MCP servers');
      expect(readJson(m.file.legacy)).toEqual({ ...LEGACY, mcpServers: { 'usr-srv': MEMBER_SERVER, 'tm-user': TEAM_SERVER } });
    }, 180_000);
  }

  for (const other of [
    { what: 'a member\'s server', content: { mcpServers: { 'mine-old': MEMBER_SERVER } } },
    { what: 'another key', content: { mcpServers: {}, theme: 'dark' } },
  ]) {
    it(`leaves a ~/.codebuddy/mcp.json that also holds ${other.what} where it is`, () => {
      const m = machine('upgrade-kept');
      writeFile(m.file.mcp, JSON.stringify(other.content, null, 2));
      m.init();
      writeFile(m.file.legacy, JSON.stringify(LEGACY, null, 2));
      const pull = m.teamaiOk('pull', '--force');
      expect(pull.output).not.toContain('Moved teamai\'s MCP servers');
      expect(readJson(m.file.mcp)).toEqual({ ...other.content, mcpServers: { ...other.content.mcpServers, 'tm-user': TEAM_SERVER } });
      expect(readJson(m.file.legacy)).toEqual(LEGACY);
    }, 120_000);
  }

  it('keeps a ~/.codebuddy/mcp.json that is a symlink holding only teamai\'s servers, and writes through it', () => {
    const m = machine('upgrade-linked');
    const target = path.join(m.home, '..', 'dotfiles', 'codebuddy-mcp.json');
    writeFile(target, JSON.stringify({ mcpServers: { 'tm-user': TEAM_SERVER } }, null, 2));
    fs.symlinkSync(target, m.file.mcp);
    writeFile(m.file.legacy, JSON.stringify(LEGACY, null, 2));

    const first = m.init();

    expect(first.output).not.toContain('Moved teamai\'s MCP servers');
    expect(fs.lstatSync(m.file.mcp).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(m.file.mcp)).toBe(target);
    expect(m.servers(target)).toEqual({ 'tm-user': TEAM_SERVER });
    expect(readJson(m.file.legacy)).toEqual(LEGACY);
  }, 120_000);

  // With its record lost, a server an earlier teamai left in a file CodeBuddy no longer reads would come back
  // once the member deletes the file CodeBuddy reads now.
  const KEEP = { name: 'tm-keep', url: 'https://keep.example.com/mcp' };
  for (const run of [
    { how: 'pull', team: 'deleted its only server', extra: [], after: [] },
    { how: 'pull', team: 'kept another server', extra: [KEEP], after: [KEEP] },
    { how: 'uninstall', team: 'deleted its only server', extra: [], after: [] },
  ] as const) {
    it(`${run.how} takes teamai's servers out of a file CodeBuddy no longer reads after the record is lost and the team ${run.team}`, () => {
      const m = machine(`lost-record-${run.how}`, [...run.extra]);
      writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'mine-old': MEMBER_SERVER } }, null, 2));
      m.init();
      expect(Object.keys(m.servers(m.file.mcp) ?? {}).sort()).toEqual(['mine-old', 'tm-user', ...run.extra.map((s) => s.name)].sort());
      m.loseManifest();
      writeFile(m.file.dotMcp, JSON.stringify({ mcpServers: {} }, null, 2));
      m.publishTeamMcp([...run.after]);

      if (run.how === 'pull') m.teamaiOk('pull', '--force');
      else m.teamaiOk('uninstall', '--force');

      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER });
      const kept = run.how === 'pull' ? Object.fromEntries(run.after.map((s) => [s.name, { type: 'http', url: s.url }])) : {};
      expect(m.servers(m.file.dotMcp)).toEqual(kept);
    }, 180_000);
  }

  for (const recorded of ['records the file', 'an earlier teamai recorded no file'] as const) {
    it(`keeps teamai's server when ~/.codebuddy/.mcp.json is a symlink to ~/.codebuddy/mcp.json (${recorded})`, () => {
      const m = machine(recorded === 'records the file' ? 'alias' : 'alias-legacy-record');
      writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'mine-old': MEMBER_SERVER } }, null, 2));
      m.init();
      if (recorded === 'an earlier teamai recorded no file') m.forgetRecordedFile();
      fs.symlinkSync('mcp.json', m.file.dotMcp);

      const pull = m.teamaiOk('pull', '--force');

      expect(fs.lstatSync(m.file.dotMcp).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(m.file.dotMcp)).toBe('mcp.json');
      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
      expect(pull.output).not.toContain('Took teamai\'s MCP servers');
      expect(m.teamai('doctor').output).not.toContain('which codebuddy does not read');

      m.teamaiOk('pull', '--force');
      expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER, 'tm-user': TEAM_SERVER });
    }, 180_000);
  }

  it('neither moves nor deletes a ~/.codebuddy/mcp.json holding only teamai\'s servers when ~/.codebuddy.json is a symlink to it', () => {
    const m = machine('alias-legacy');
    writeFile(m.file.mcp, '{}');
    m.init();
    fs.symlinkSync(path.join('.codebuddy', 'mcp.json'), m.file.legacy);

    const pull = m.teamaiOk('pull', '--force');

    expect(pull.output).not.toContain('Moved teamai\'s MCP servers');
    expect(fs.lstatSync(m.file.mcp).isFile()).toBe(true);
    expect(fs.lstatSync(m.file.legacy).isSymbolicLink()).toBe(true);
    expect(m.servers(m.file.mcp)).toEqual({ 'tm-user': TEAM_SERVER });
  }, 120_000);
});
