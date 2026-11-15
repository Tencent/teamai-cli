import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { describeEntryFailure } from '../namespaced-entries.js';
import { LayeredEntries } from '../resources/layered-entries.js';
import { deliverMcpFolders, TEAM_MCP_ENTRIES, teamMcpDef } from '../resources/mcp.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig } from '../types.js';
import { folderVersion } from './helpers/folder-version.js';

// A team MCP server written as mcp/<name>/MCP.yaml beside the files it runs (#1787).

let sandbox: string;
let repo: string;
let dataHome: string;

const JIRA_LITE = [
  'description: Read-only Jira lookups for the team',
  'transport: stdio',
  'command: uv',
  'args: ["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]',
  'requires: [uv]',
  '',
].join('\n');

function workspace(over: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'acme/team' }, username: 'tester', scope: 'project', projectRoot: path.join(sandbox, 'app'), additionalRoles: [], dataHome, ...over,
  };
}

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repo, ...file.split('/')), content);
}

/** `dir` with forward slashes, as a rendered path names it. */
const rendered = (dir: string): string => dir.split(path.sep).join('/');

/** The servers `localConfig` receives, as the tools get them, or why MCP stops for the run. */
async function servers(localConfig: LocalConfig): Promise<ReturnType<typeof teamMcpDef>[] | string> {
  const resolution = await LayeredEntries.resolve(TEAM_MCP_ENTRIES, localConfig);

  return resolution.kind === 'resolved' ? resolution.entries.map((entry) => teamMcpDef(localConfig, entry)) : describeEntryFailure(resolution.failure);
}

/** What the run says about the servers it delivers, besides failing. */
async function notices(localConfig: LocalConfig): Promise<string[]> {
  return (await LayeredEntries.resolve(TEAM_MCP_ENTRIES, localConfig)).notices.map((notice) => notice.message);
}

beforeEach(async () => {
  sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-folders-'));
  repo = path.join(sandbox, 'team');
  dataHome = path.join(sandbox, 'home', '.teamai', 'projects', 'app');
  resetWarnOnce();
});

afterEach(async () => {
  await fse.remove(sandbox);
});

describe('an MCP server folder', () => {
  it('is one server named after its directory, whose arguments name the folder in the worktree\'s .teamai/delivered/', async () => {
    await write({ 'mcp/jira-lite/MCP.yaml': JIRA_LITE, 'mcp/jira-lite/server.py': 'print("jira")\n', 'mcp/jira-lite/queries.sql': 'select 1;\n' });

    expect(await servers(workspace())).toEqual([{
      name: 'jira-lite',
      description: 'Read-only Jira lookups for the team',
      transport: 'stdio',
      command: 'uv',
      args: ['run', '--script', `${rendered(path.join(sandbox, 'app', '.teamai', 'delivered', 'mcp', `jira-lite.${folderVersion(path.join(repo, 'mcp', 'jira-lite'))}`))}/server.py`],
      requires: ['uv'],
    }]);
  });

  it('names the folder in command, args and env, and leaves headers as written', async () => {
    await write({
      'mcp/runner/MCP.yaml': [
        'transport: stdio',
        'command: ${TEAMAI_MCP_DIR}/bin/run',
        'args: ["--queries", "${TEAMAI_MCP_DIR}/queries.sql"]',
        'env: { DATA: "${TEAMAI_MCP_DIR}/data" }',
        'headers: { X-Dir: "${TEAMAI_MCP_DIR}" }',
        '',
      ].join('\n'),
    });
    const dest = rendered(path.join(sandbox, 'app', '.teamai', 'delivered', 'mcp', `runner.${folderVersion(path.join(repo, 'mcp', 'runner'))}`));

    expect(await servers(workspace())).toEqual([expect.objectContaining({
      command: `${dest}/bin/run`, args: ['--queries', `${dest}/queries.sql`], env: { DATA: `${dest}/data` }, headers: { 'X-Dir': '${TEAMAI_MCP_DIR}' },
    })]);
  });
});

describe('what stops team MCP for the run, keeping what is installed', () => {
  const kept = 'mcp was not applied this run, so your installed team MCP servers are unchanged.';

  it('a folder whose transport is http: a URL server carries no files', async () => {
    await write({ 'mcp/jira/MCP.yaml': 'transport: http\nurl: https://jira.example.com/mcp\n' });

    expect(await servers(workspace())).toBe(
      'mcp/jira/MCP.yaml: transport http is refused in a folder, which holds the files of a server teamai starts (stdio). '
      + `A URL server carries no files: declare it in mcp.yaml. ${kept} Fix the file in the team repo and push.`,
    );
  });

  it('${TEAMAI_MCP_DIR} in mcp.yaml, where no folder gives it a path', async () => {
    await write({ 'mcp/mcp.yaml': 'servers:\n  - name: jira-lite\n    transport: stdio\n    command: uv\n    args: ["run", "${TEAMAI_MCP_DIR}/server.py"]\n' });

    expect(await servers(workspace())).toBe(
      'mcp/mcp.yaml: server "jira-lite" uses ${TEAMAI_MCP_DIR}, which only an MCP server folder has. '
      + `Move it to mcp/jira-lite/MCP.yaml, beside the files it runs. ${kept} Fix the file in the team repo and push.`,
    );
  });

  it('an mcp.yaml server and a folder of the same name', async () => {
    await write({
      'mcp/mcp.yaml': 'servers:\n  - name: jira-lite\n    transport: http\n    url: https://jira.example.com/mcp\n',
      'mcp/jira-lite/MCP.yaml': JIRA_LITE,
    });

    expect(await servers(workspace())).toBe(
      `server "jira-lite" is defined in both mcp/jira-lite/ and mcp/mcp.yaml, in the same place. ${kept} Keep one of them in the team repo and push.`,
    );
  });

  it('a folder whose name the MCP name rule refuses', async () => {
    await write({ 'mcp/jira.lite/MCP.yaml': JIRA_LITE });

    expect(await servers(workspace())).toBe(
      `mcp/jira.lite/ is not a valid name: an MCP server name uses only letters, digits, - and _. Rename the folder. ${kept} Fix the file in the team repo and push.`,
    );
  });

  it('an mcp.yaml server whose name the MCP name rule refuses, in the words a folder name gets', async () => {
    await write({ 'mcp/mcp.yaml': 'servers:\n  - name: jira.lite\n    transport: http\n    url: https://jira.example.com/mcp\n' });

    expect(await servers(workspace())).toEqual(expect.stringContaining('an MCP server name uses only letters, digits, - and _'));
  });

  it('an MCP.yaml that does not parse', async () => {
    await write({ 'mcp/jira-lite/MCP.yaml': 'transport: stdio\n' });

    expect(await servers(workspace())).toBe(`mcp/jira-lite/MCP.yaml does not parse: stdio transport requires \`command\`. ${kept} Fix the file in the team repo and push.`);
  });
});

describe('a folder MCP leaves out, with a notice', () => {
  it('names a key MCP.yaml does not take, such as name, and delivers the rest', async () => {
    await write({ 'mcp/jira-lite/MCP.yaml': `name: jira\n${JIRA_LITE}`, 'mcp/mcp.yaml': 'servers:\n  - name: docs\n    transport: http\n    url: https://docs.example.com/mcp\n' });

    expect([(await servers(workspace())), await notices(workspace())]).toEqual([
      [expect.objectContaining({ name: 'docs' })],
      ['mcp/jira-lite/: server "jira-lite" has unknown key `name:`, so this entry is not delivered. Correct the key or remove it.'],
    ]);
  });

  it('skips a teamai- folder, since teamai ships no MCP server it could replace', async () => {
    await write({ 'mcp/teamai-recall/MCP.yaml': JIRA_LITE });

    expect([await servers(workspace()), await notices(workspace())]).toEqual([
      [],
      ['mcp/teamai-recall/ is skipped: a teamai- name only replaces a teamai default, and teamai has no MCP server named teamai-recall. Rename the folder.'],
    ]);
  });
});

describe('a folder server under a path holding a space and non-ASCII letters', () => {
  it('starts from its forward-slash path, passed as an argument directly and in a quoted shell command line', async () => {
    await write({ 'mcp/jira-lite/MCP.yaml': 'transport: stdio\ncommand: node\nargs: ["${TEAMAI_MCP_DIR}/server.mjs"]\n', 'mcp/jira-lite/server.mjs': 'console.log("jira-lite ran");\n' });
    const localConfig = workspace({ projectRoot: path.join(sandbox, 'Zoë Li', 'app'), dataHome: path.join(sandbox, 'Zoë Li', '.teamai', 'projects', 'app') });
    const resolution = await LayeredEntries.resolve(TEAM_MCP_ENTRIES, localConfig);
    const entries = resolution.kind === 'resolved' ? resolution.entries : [];
    await deliverMcpFolders(localConfig, entries, new Set());
    const [server] = entries.map((entry) => teamMcpDef(localConfig, entry));
    const command = server?.command ?? '';
    const args = server?.args ?? [];

    expect([
      args.some((arg) => arg.includes('\\')),
      execFileSync(command, args, { encoding: 'utf8' }).trim(),
      execSync([command, ...args.map((arg) => `"${arg}"`)].join(' '), { encoding: 'utf8' }).trim(),
    ]).toEqual([false, 'jira-lite ran', 'jira-lite ran']);
  });
});

describe('TEAMAI_MCP_DIR', () => {
  it('is reserved, so no team env value can shadow it', async () => {
    const { reservedTeamEnvWarning } = await import('../env-reserved.js');

    expect(reservedTeamEnvWarning(['TEAMAI_MCP_DIR', 'JIRA_URL'])).toBe('TEAMAI_MCP_DIR is reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.');
  });

  it('is named with why it is reserved, apart from the shell names', async () => {
    const { reservedTeamEnvWarning } = await import('../env-reserved.js');

    expect(reservedTeamEnvWarning(['BASH_ENV', 'TEAMAI_MCP_DIR', 'TEAMAI_HOOK_DIR'])).toBe(
      'BASH_ENV is reserved for TeamAI shell routing; those team env values are ignored. '
        + 'TEAMAI_MCP_DIR, TEAMAI_HOOK_DIR are reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.',
    );
  });
});
