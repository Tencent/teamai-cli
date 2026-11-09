import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

// A team MCP server folder is delivered to the workspace's data home, and each
// tool's MCP configuration starts the server from there (#1787).

let sandbox: string;
let home: string;

const SERVER = 'transport: stdio\ncommand: node\nargs: ["${TEAMAI_MCP_DIR}/server.mjs"]\n';

function teamConfig(mcp: Record<string, unknown> = {}): TeamaiConfig {
  return {
    team: 't',
    sharing: { mcp },
    toolPaths: { claude: { skills: '.claude/skills', settings: '.claude/settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' } },
  } as unknown as TeamaiConfig;
}

/** A workspace bound to the team repo `team`, for the project `app`. */
function workspace(team: string, app: string): LocalConfig {
  return {
    repo: { localPath: path.join(sandbox, team), remote: `acme/${team}` },
    username: 'tester',
    scope: 'project',
    projectRoot: path.join(sandbox, app),
    dataHome: path.join(home, '.teamai', 'projects', app),
    additionalRoles: [],
  };
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(sandbox, root, ...file.split('/')), content);
}

/** The server `name` in the project's `.mcp.json`. */
async function claudeServer(app: string, name: string): Promise<unknown> {
  const config: { mcpServers?: Record<string, unknown> } = await fse.readJson(path.join(sandbox, app, '.mcp.json'));

  return config.mcpServers?.[name];
}

/** `dir` with forward slashes, as a rendered path names it. */
const rendered = (dir: string): string => dir.split(path.sep).join('/');

beforeEach(async () => {
  sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-delivery-'));
  home = path.join(sandbox, 'home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  await fse.ensureDir(path.join(home, '.claude', 'skills'));
  await fse.ensureDir(path.join(sandbox, 'app', '.claude', 'skills'));
  resetWarnOnce();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(sandbox);
});

describe('an MCP server folder in a workspace bound to a team repo', () => {
  it('is delivered to the workspace\'s data home, and Claude Code starts its server from there', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });

    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    const dest = path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite');

    expect([await fse.readFile(path.join(dest, 'server.mjs'), 'utf8'), await claudeServer('app', 'jira-lite')]).toEqual([
      'console.log("jira")\n',
      { type: 'stdio', command: 'node', args: [`${rendered(dest)}/server.mjs`] },
    ]);
  });

  it('starts each workspace\'s own server when two workspaces are bound to different teams', async () => {
    await fse.ensureDir(path.join(sandbox, 'billing', '.claude', 'skills'));
    await write('team-a', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("team a")\n' });
    await write('team-b', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("team b")\n' });

    await reconcileMcpForConfig(teamConfig(), workspace('team-a', 'app'));
    await reconcileMcpForConfig(teamConfig(), workspace('team-b', 'billing'));

    const start = async (app: string): Promise<string> => {
      const server = await claudeServer(app, 'jira-lite') as { command: string; args: string[] };

      return execFileSync(server.command, server.args, { encoding: 'utf8' }).trim();
    };

    expect([await start('app'), await start('billing')]).toEqual(['team a', 'team b']);
  });

  it('keeps one entry naming the same path when the folder changes, and that path holds the new version', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("v1")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));
    const before = await claudeServer('app', 'jira-lite');

    await write('team', { 'mcp/jira-lite/server.mjs': 'console.log("v2")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    const dest = path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite');

    expect([await claudeServer('app', 'jira-lite'), await fse.readFile(path.join(dest, 'server.mjs'), 'utf8')]).toEqual([before, 'console.log("v2")\n']);
  });

  it('is removed, with its entry, once the team repo drops it', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    await fse.remove(path.join(sandbox, 'team', 'mcp', 'jira-lite'));
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    expect([await fse.pathExists(path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite')), await claudeServer('app', 'jira-lite')]).toEqual([false, undefined]);
  });

  it('keeps the folder of a server the team drops while a tool the member excluded still has it installed', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));
    const installed = await claudeServer('app', 'jira-lite');

    await fse.remove(path.join(sandbox, 'team', 'mcp', 'jira-lite'));
    await reconcileMcpForConfig(teamConfig(), { ...workspace('team', 'app'), disabledAgents: ['claude', 'tclaude'] });

    expect([await fse.pathExists(path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite', 'server.mjs')), await claudeServer('app', 'jira-lite')]).toEqual([true, installed]);
  });

  it('keeps the installed server and its folder when the team repo makes the folder invalid', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));
    const installed = await claudeServer('app', 'jira-lite');

    await write('team', { 'mcp/jira-lite/MCP.yaml': 'transport: sse\nurl: https://jira.example.com/sse\n', 'mcp/jira-lite/server.mjs': 'console.log("v2")\n' });
    const { unresolved } = await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    const dest = path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite');

    expect([unresolved, await claudeServer('app', 'jira-lite'), await fse.readFile(path.join(dest, 'server.mjs'), 'utf8')]).toEqual([true, installed, 'console.log("jira")\n']);
  });

  it('keeps the installed server and the folder it runs from when the team\'s secrets declaration cannot be read', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("v1")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));
    const installed = await claudeServer('app', 'jira-lite');

    await fse.remove(path.join(sandbox, 'team', 'mcp', 'jira-lite', 'server.mjs'));
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER.replace('server.mjs', 'next.mjs'), 'mcp/jira-lite/next.mjs': 'console.log("v2")\n', 'env/secrets.yaml': 'secrets: [\n' });
    const { unresolved } = await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    const dest = path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite');

    expect([unresolved, await claudeServer('app', 'jira-lite'), await fse.readFile(path.join(dest, 'server.mjs'), 'utf8')]).toEqual([true, installed, 'console.log("v1")\n']);
  });

  it('keeps the folder a kept server runs from when its new version needs a secret this machine has not set', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("v1")\n' });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));
    const installed = await claudeServer('app', 'jira-lite');

    await fse.remove(path.join(sandbox, 'team', 'mcp', 'jira-lite', 'server.mjs'));
    await write('team', {
      'mcp/jira-lite/MCP.yaml': `${SERVER.replace('server.mjs', 'next.mjs')}env: { JIRA_TOKEN: "\${JIRA_TOKEN}" }\n`,
      'mcp/jira-lite/next.mjs': 'console.log("v2")\n',
      'env/secrets.yaml': 'secrets:\n  - key: JIRA_TOKEN\n',
    });
    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'));

    const dest = path.join(home, '.teamai', 'projects', 'app', 'mcp', 'jira-lite');

    expect([await claudeServer('app', 'jira-lite'), (await fse.readdir(dest)).sort(), await fse.readFile(path.join(dest, 'server.mjs'), 'utf8')])
      .toEqual([installed, ['MCP.yaml', 'server.mjs'], 'console.log("v1")\n']);
  });

  it('writes nothing on a dry run', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });

    await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'), { dryRun: true });

    expect([await fse.pathExists(path.join(home, '.teamai', 'projects', 'app', 'mcp')), await fse.pathExists(path.join(sandbox, 'app', '.mcp.json'))]).toEqual([false, false]);
  });
});

describe('an MCP server folder in the user scope', () => {
  it('is delivered to ~/.teamai/mcp/<name>/, and Claude Code\'s user configuration starts it from there', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });
    const user: LocalConfig = { repo: { localPath: path.join(sandbox, 'team'), remote: 'acme/team' }, username: 'tester', scope: 'user', additionalRoles: [] };

    await reconcileMcpForConfig(teamConfig(), user);

    const dest = path.join(home, '.teamai', 'mcp', 'jira-lite');
    const config: { mcpServers?: Record<string, unknown> } = await fse.readJson(path.join(home, '.claude.json'));

    expect([await fse.readFile(path.join(dest, 'server.mjs'), 'utf8'), config.mcpServers?.['jira-lite']])
      .toEqual(['console.log("jira")\n', { type: 'stdio', command: 'node', args: [`${rendered(dest)}/server.mjs`] }]);
  });
});

describe('what a folder server needs on the member\'s machine', () => {
  const UV_SERVER = 'transport: stdio\ncommand: uv\nargs: ["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]\nrequires: [uv]\n';

  it('is skipped, with the reason, when a runner it requires is not on PATH', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': UV_SERVER, 'mcp/jira-lite/server.py': 'print("jira")\n' });

    const { changes } = await reconcileMcpForConfig(teamConfig(), workspace('team', 'app'), { lookPath: { pathEnv: path.join(sandbox, 'empty-bin') } });

    expect(changes.filter((change) => change.server === 'jira-lite')).toEqual([
      expect.objectContaining({ tool: 'claude', action: 'skipped', reason: 'required executable "uv" not found on PATH' }),
    ]);
  });

  it('is skipped when sharing.mcp.allowedCommands leaves its runner out, and delivered once it lists it', async () => {
    await write('team', { 'mcp/jira-lite/MCP.yaml': SERVER, 'mcp/jira-lite/server.mjs': 'console.log("jira")\n' });

    const refused = await reconcileMcpForConfig(teamConfig({ allowedCommands: ['npx'] }), workspace('team', 'app'));
    const allowed = await reconcileMcpForConfig(teamConfig({ allowedCommands: ['npx', 'node'] }), workspace('team', 'app'));

    expect([refused.changes, allowed.changes].map((changes) => changes.filter((change) => change.server === 'jira-lite').map(({ action, reason }) => [action, reason])))
      .toEqual([[['skipped', 'command "node" is not in sharing.mcp.allowedCommands']], [['added', undefined]]]);
  });
});

describe('an MCP server folder in a single-repo worktree', () => {
  let project: string;
  let team: string;
  let self: LocalConfig;

  beforeEach(async () => {
    project = path.join(sandbox, 'shop');
    team = path.join(project, '.teamai');
    execFileSync('git', ['init', '-q', project]);
    await fse.ensureDir(path.join(project, '.claude', 'skills'));
    await fse.outputFile(path.join(team, 'mcp', 'jira-lite', 'MCP.yaml'), SERVER);
    await fse.outputFile(path.join(team, 'mcp', 'jira-lite', 'server.mjs'), 'console.log("jira")\n');

    self = {
      repo: { kind: 'self', localPath: team, remote: 'acme/shop', businessRepoRoot: project },
      username: 'tester', additionalRoles: [], scope: 'project', projectRoot: project, dataHome: path.join(home, '.teamai', 'projects', 'shop'),
    };
  });

  it('is delivered in the worktree\'s .teamai/delivered/, and .mcp.json names its absolute path, since Claude Code expands no project variable there', async () => {
    await reconcileMcpForConfig(teamConfig(), self);

    const dest = path.join(team, 'delivered', 'mcp', 'jira-lite');
    const config: { mcpServers?: Record<string, unknown> } = await fse.readJson(path.join(project, '.mcp.json'));

    expect([await fse.readFile(path.join(dest, 'server.mjs'), 'utf8'), config.mcpServers?.['jira-lite']])
      .toEqual(['console.log("jira")\n', { type: 'stdio', command: 'node', args: [`${rendered(dest)}/server.mjs`] }]);
  });

  it('is kept out of git by its own exclude block, with sharing.gitExclude off too', async () => {
    await reconcileMcpForConfig({ ...teamConfig(), sharing: { mcp: {}, gitExclude: false } } as unknown as TeamaiConfig, self);

    const untracked = execFileSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });

    expect(untracked.includes('.teamai/delivered/')).toBe(false);
  });
});
