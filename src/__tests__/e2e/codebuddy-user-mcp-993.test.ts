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
function machine(name: string) {
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
  writeFile(path.join(seed, 'mcp', 'mcp.yaml'), [
    'servers:', '  - name: tm-user', '    transport: http', `    url: ${TEAM_SERVER.url}`, '    tools: [codebuddy]', '',
  ].join('\n'));
  gitOk(['init', '-q', '-b', 'main'], seed);
  gitOk(['add', '-A'], seed);
  gitOk(['commit', '-q', '-m', 'seed'], seed);
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);

  const file = {
    dotMcp: path.join(home, '.codebuddy', '.mcp.json'),
    mcp: path.join(home, '.codebuddy', 'mcp.json'),
  };
  const servers = (f: string): Record<string, unknown> | undefined =>
    fs.existsSync(f) ? readJson(f).mcpServers : undefined;
  const init = (): Run => {
    const started = teamaiOk('init', url, '--provider', 'git', '--agent', 'codebuddy', '--scope', 'user', '--force');
    const pulled = teamaiOk('pull');
    return { ...pulled, output: `${started.output}${pulled.output}` };
  };
  return { file, servers, init, teamai, teamaiOk };
}

describe('CodeBuddy user MCP goes to the file CodeBuddy reads (#993 bug 10)', () => {
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

  // The other file states (a record noting no file, links, a lost record, ~/.codebuddy.json) are in mcp-locate-targets.test.ts.
  it('moves only teamai\'s entries out of a file CodeBuddy no longer reads, and doctor warns until then', () => {
    const m = machine('shadowed');
    writeFile(m.file.mcp, JSON.stringify({ mcpServers: { 'mine-old': MEMBER_SERVER } }, null, 2));
    m.init();
    expect(m.servers(m.file.mcp)).toEqual({ 'mine-old': MEMBER_SERVER, 'tm-user': TEAM_SERVER });

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
});
