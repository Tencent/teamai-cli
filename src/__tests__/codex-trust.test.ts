import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  resolveAnchors: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('cross-spawn', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('cross-spawn') }>();
  return { ...actual, default: vi.fn(actual.default) };
});

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import fc from 'fast-check';
import { applyAgentHook, codexTrustPolicy, readCodexHookTrustForScope, reconcileHooks, reconcileTeamHooksForConfig, removeAgentHook, reportCodexTrust, trustCodexForScope, type CodexTrustPolicy } from '../hooks.js';
import { readCodexHookTrust, removeOwnedCodexProjectTrust, trustCodexHooks, trustCodexProject } from '../codex-trust.js';
import { reconcileCodexDispatchers, setCodexDispatcherHooks } from '../codex-team-hooks.js';
import crossSpawn from 'cross-spawn';
import { resolveAnchors, listWorktrees } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { CODEX_TOOL_ID } from '../types.js';
import type { HookDef, LocalConfig, TeamaiConfig } from '../types.js';
import { installFakeCodex, readFakeCodexState, writeFakeCodexOptions } from './helpers/fake-codex.js';

let home: string;
let repo: string;
let fakeBin: string;

const teamConfig = {
  toolPaths: {
    codex: { settings: '.codex/hooks.json' },
    'codex-internal': { settings: '.codex-internal/hooks.json' },
  },
} as unknown as TeamaiConfig;

function userConfig(extra: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: repo, remote: 'x' },
    username: 'u',
    scope: 'user',
    additionalRoles: [],
    ...extra,
  } as unknown as LocalConfig;
}

async function writeYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'hooks'));
  await fse.writeFile(path.join(repo, 'hooks', 'hooks.yaml'), content);
}

const LINT_HOOK = `
hooks:
  - id: lint
    description: run lint before a tool
    event: PreToolUse
    command: npm run lint
`;

/** What init / `hooks inject` / pull do: write the hooks, then trust them. */
async function writeAndTrust(config: LocalConfig, opts: { dryRun?: boolean; removeAll?: boolean } = {}) {
  const reconciled = await reconcileTeamHooksForConfig(teamConfig, config, opts);
  const codexTrust = opts.dryRun || opts.removeAll ? undefined : await trustCodexForScope(teamConfig, config);
  return { ...reconciled, codexTrust };
}

function codexHome(): string {
  return path.join(home, '.codex');
}

function trustedKeys(dir = codexHome()): string[] {
  return Object.keys(readFakeCodexState(dir).hooksState);
}

function calls(method: string, dir = codexHome()): number {
  return readFakeCodexState(dir).calls.filter((c) => c.method === method).length;
}

/** Every handler in a Codex hooks.json, with the trust key Codex gives it. */
async function codexEntries(file: string): Promise<Array<{ key: string; command: string }>> {
  const json = await fse.readJson(file) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  const real = await fse.realpath(file);
  const snake = (e: string): string => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return Object.entries(json.hooks).flatMap(([event, groups]) => groups.flatMap((g, gi) =>
    g.hooks.map((h, hi) => ({ key: `${real}:${snake(event)}:${gi}:${hi}`, command: h.command }))));
}

beforeEach(async () => {
  vi.mocked(resolveAnchors).mockReset().mockResolvedValue(null);
  vi.mocked(listWorktrees).mockReset().mockResolvedValue([]);
  home = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-trust-home-')));
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-trust-repo-'));
  fakeBin = installFakeCodex();
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('PATH', `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`);
  await fse.ensureDir(codexHome());
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.success).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fse.remove(home);
  await fse.remove(repo);
  await fse.remove(fakeBin);
});

describe('recorded Codex project trust', () => {
  it('records only a newly created grant and removes it while unchanged', async () => {
    const project = path.join(home, 'project');
    await fse.ensureDir(project);
    const recorded = vi.fn();
    await trustCodexHooks({ codexHome: codexHome(), cwd: project, project, hooks: [], onProjectTrusted: recorded });
    expect(recorded).toHaveBeenCalledWith(project);
    recorded.mockClear();
    await trustCodexHooks({ codexHome: codexHome(), cwd: project, project, hooks: [], onProjectTrusted: recorded });
    expect(recorded).not.toHaveBeenCalled();
    expect(await removeOwnedCodexProjectTrust({ codexHome: codexHome(), project })).toEqual({ kind: 'removed' });
    expect(readFakeCodexState(codexHome()).projects[project]).toBeUndefined();
  });

  it('keeps a recorded grant the member changed to untrusted', async () => {
    const project = path.join(home, 'project');
    await fse.outputJson(path.join(codexHome(), 'fake-state.json'), { projects: { [project]: { trust_level: 'untrusted' } }, hooksState: {}, calls: [] });
    expect(await removeOwnedCodexProjectTrust({ codexHome: codexHome(), project })).toEqual({ kind: 'kept' });
    expect(readFakeCodexState(codexHome()).projects[project].trust_level).toBe('untrusted');
  });
});

describe('Codex hook ownership', () => {
  it('recovers a unique managed definition after member groups move it', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());
    const file = path.join(codexHome(), 'hooks.json');
    const json = await fse.readJson(file);
    const member = { hooks: [{ type: 'command', command: 'echo member' }] };
    json.hooks.PreToolUse.unshift(member);
    await fse.writeJson(file, json);

    await writeAndTrust(userConfig());

    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      member, { hooks: [{ type: 'command', command: 'npm run lint' }] },
    ]);
    await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));
    await writeAndTrust(userConfig());
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      member, { hooks: [{ type: 'command', command: 'npm run lint:fix' }] },
    ]);
    await writeAndTrust(userConfig(), { removeAll: true });
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([member]);
  });

  it('preserves member hooks on the first project reconcile and through team updates/removal', async () => {
    await writeYaml(LINT_HOOK);
    const project = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-owner-project-')));
    const config = userConfig({ scope: 'project', projectRoot: project });
    const file = path.join(project, '.codex', 'hooks.json');
    // Each shares the team's command but is not its render: an exact render is teamai's (#993).
    const memberGroups = [
      { hooks: [{ type: 'command', command: 'npm run lint', timeout: 5 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', timeout: 17 }] },
    ];
    try {
      await fse.outputJson(file, { hooks: { PreToolUse: memberGroups, Stop: [memberGroups[0]] } });
      const memberKeys = new Set((await codexEntries(file)).map((e) => e.key));

      await writeAndTrust(config);

      expect((await fse.readJson(file)).hooks.PreToolUse.slice(0, 2)).toEqual(memberGroups);
      expect((await fse.readJson(file)).hooks.Stop).toEqual([memberGroups[0]]);
      expect(trustedKeys().some((key) => memberKeys.has(key))).toBe(false);
      await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));
      await writeAndTrust(config);
      expect((await fse.readJson(file)).hooks.PreToolUse.slice(0, 2)).toEqual(memberGroups);
      await writeAndTrust(config, { removeAll: true });
      expect((await fse.readJson(file)).hooks.PreToolUse).toEqual(memberGroups);
      expect((await fse.readJson(file)).hooks.Stop).toEqual([memberGroups[0]]);
    } finally {
      await fse.remove(project);
    }
  });

  it.each(['Stop', 'PreToolUse'])('preserves and never trusts member hooks sharing a team command under %s', async (event) => {
    await writeYaml(LINT_HOOK);
    const file = path.join(codexHome(), 'hooks.json');
    // Each shares the team's command but is not its render: an exact render is teamai's (#993).
    const memberGroups = [
      { hooks: [{ type: 'command', command: 'npm run lint', timeout: 5 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', timeout: 17, additionalContextLimit: 0 }] },
    ];
    await fse.writeJson(file, { hooks: { [event]: memberGroups } });
    const memberKeys = new Set((await codexEntries(file)).map((e) => e.key));

    await writeAndTrust(userConfig());

    const teamKeys = (await codexEntries(file)).filter((e) => !memberKeys.has(e.key)).map((e) => e.key);
    expect(trustedKeys().sort()).toEqual(teamKeys.sort());
    expect((await fse.readJson(file)).hooks[event].slice(0, 2)).toEqual(memberGroups);
    await writeAndTrust(userConfig());
    expect((await fse.readJson(file)).hooks[event].slice(0, 2)).toEqual(memberGroups);
    expect(trustedKeys().some((key) => memberKeys.has(key))).toBe(false);
    await writeAndTrust(userConfig(), { removeAll: true });
    expect((await fse.readJson(file)).hooks[event]).toEqual(memberGroups);
  });

  it.each([
    { timeout: 30 },
    { additionalContextLimit: 0 },
    { timeout: 30, additionalContextLimit: 0 },
  ])('migrates legacy Codex ownership with unrecorded options %j', async (options) => {
    const file = path.join(codexHome(), 'hooks.json');
    const legacy = { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', ...options }] };
    const member = { matcher: 'Write', hooks: [{ type: 'command', command: 'npm run lint', timeout: 17 }] };
    await fse.writeJson(file, { hooks: { PreToolUse: [member, legacy], Stop: [legacy] } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-hooks.json'), {
      codex: [{ id: 'lint', event: 'PreToolUse', matcher: 'Bash', command: 'npm run lint' }],
    });
    const desiredOptions = options.timeout === undefined ? {} : { timeout: options.timeout };
    const yaml = LINT_HOOK + '    matcher: Bash\n'
      + (options.timeout === undefined ? '' : `    timeout: ${options.timeout}\n`);
    await writeYaml(yaml);

    await writeAndTrust(userConfig());

    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      member, { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', ...desiredOptions }] },
    ]);
    expect((await fse.readJson(file)).hooks.Stop[0]).toEqual(legacy);
    expect(trustedKeys()).toContain(`${file}:pre_tool_use:1:0`);
    expect(trustedKeys()).not.toContain(`${file}:pre_tool_use:0:0`);
    expect(trustedKeys()).not.toContain(`${file}:stop:0:0`);
    await writeYaml(yaml.replace('npm run lint', 'npm run lint:fix'));
    await writeAndTrust(userConfig());
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      member, { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint:fix', ...desiredOptions }] },
    ]);
    await writeAndTrust(userConfig(), { removeAll: true });
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([member]);
    expect((await fse.readJson(file)).hooks.Stop).toEqual([legacy]);
  });

  it('trusts and removes a unique legacy hook before its first upgraded reconcile', async () => {
    const file = path.join(codexHome(), 'hooks.json');
    const member = { matcher: 'Write', hooks: [{ type: 'command', command: 'npm run lint' }] };
    const legacy = { hooks: [{ type: 'command', command: 'npm run lint', timeout: 30, additionalContextLimit: 0 }] };
    await fse.writeJson(file, { hooks: { PreToolUse: [member, legacy] } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-hooks.json'), {
      codex: [{ id: 'lint', event: 'PreToolUse', command: 'npm run lint' }],
    });

    expect(await trustCodexForScope(teamConfig, userConfig())).toEqual({ kind: 'trusted', hooks: 1 });
    expect(trustedKeys()).toEqual([`${file}:pre_tool_use:1:0`]);
    await writeAndTrust(userConfig(), { removeAll: true });

    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([member]);
  });

  it('preserves legacy option collisions and multi-handler member groups', async () => {
    await writeYaml(LINT_HOOK + '    matcher: Bash\n');
    const file = path.join(codexHome(), 'hooks.json');
    const groups = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', timeout: 30 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint', additionalContextLimit: 0 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint' }, { type: 'command', command: 'echo member' }] },
    ];
    await fse.writeJson(file, { hooks: { PreToolUse: groups } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-hooks.json'), {
      codex: [{ id: 'lint', event: 'PreToolUse', matcher: 'Bash', command: 'npm run lint' }],
    });
    const memberKeys = new Set((await codexEntries(file)).map((e) => e.key));

    expect(await trustCodexForScope(teamConfig, userConfig())).toBeUndefined();
    await writeAndTrust(userConfig());

    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      ...groups, { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint' }] },
    ]);
    expect(trustedKeys().some((key) => memberKeys.has(key))).toBe(false);
    await writeAndTrust(userConfig(), { removeAll: true });
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual(groups);
  });

  it('keeps ambiguous legacy entries instead of claiming every identical command', async () => {
    await writeYaml(LINT_HOOK);
    const file = path.join(codexHome(), 'hooks.json');
    const member = { hooks: [{ type: 'command', command: 'npm run lint', timeout: 5 }] };
    await fse.writeJson(file, { hooks: { PreToolUse: [member, member] } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-hooks.json'), {
      codex: [{ id: 'lint', event: 'PreToolUse', command: 'npm run lint' }],
    });

    await writeAndTrust(userConfig());

    expect((await fse.readJson(file)).hooks.PreToolUse.slice(0, 2)).toEqual([member, member]);
    expect(trustedKeys()).not.toContain(`${file}:pre_tool_use:0:0`);
    expect(trustedKeys()).not.toContain(`${file}:pre_tool_use:1:0`);
  });

  it('takes unrecorded copies of the team render as its own, leaving one entry (#993)', async () => {
    await writeYaml(LINT_HOOK);
    const file = path.join(codexHome(), 'hooks.json');
    const render = { hooks: [{ type: 'command', command: 'npm run lint' }] };
    await fse.writeJson(file, { hooks: { PreToolUse: [render, render] } });

    await writeAndTrust(userConfig());

    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([render]);
    expect(trustedKeys()).toContain(`${file}:pre_tool_use:0:0`);
    await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));
    await writeAndTrust(userConfig());
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'npm run lint:fix' }] }]);
  });

});

describe('Codex hook trust — user scope', () => {
  it('trusts every hook teamai wrote and leaves the member\'s own hook alone', async () => {
    await writeYaml(LINT_HOOK);
    await fse.writeJson(path.join(codexHome(), 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });

    const reconciled = await writeAndTrust(userConfig());

    const entries = await codexEntries(path.join(codexHome(), 'hooks.json'));
    const teamai = entries.filter((e) => e.command !== 'echo mine');
    expect(teamai.some((e) => e.command === 'npm run lint')).toBe(true);
    expect(trustedKeys().sort()).toEqual(teamai.map((e) => e.key).sort());
    expect(reconciled.codexTrust).toEqual({ kind: 'trusted', hooks: teamai.length });
  });

  it('does not trust a member command containing a teamai marker', async () => {
    await writeAndTrust(userConfig());
    const file = path.join(codexHome(), 'hooks.json');
    const json = await fse.readJson(file);
    json.hooks.Stop.push({ hooks: [{ type: 'command', command: 'teamai pull --silent && my-script' }] });
    await fse.writeJson(file, json);

    await trustCodexForScope(teamConfig, userConfig());

    const member = (await codexEntries(file)).find((e) => e.command === 'teamai pull --silent && my-script')!;
    expect(trustedKeys()).not.toContain(member.key);
  });

  it('fails actionably when Codex does not list a requested hook', async () => {
    const file = path.join(codexHome(), 'hooks.json');
    const result = await trustCodexHooks({ codexHome: codexHome(), cwd: home, hooks: [{ file, command: 'missing', key: `${file}:stop:0:0` }] });
    expect(result).toEqual({ kind: 'failed', reason: expect.stringMatching(/hooks\/list.*missing.*not loaded.*teamai pull/) });
  });

  it('writes nothing to Codex when every teamai hook is already trusted', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());

    const again = await writeAndTrust(userConfig());

    expect(calls('config/batchWrite')).toBe(1);
    expect(again.codexTrust).toEqual({ kind: 'trusted', hooks: 0 });
  });

  it('re-trusts a teamai hook whose command changed', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());
    await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));

    const again = await writeAndTrust(userConfig());

    expect(again.codexTrust).toEqual({ kind: 'trusted', hooks: 1 });
  });

  it('runs the app-server against the Codex home teamai writes to (toolRoots.codex)', async () => {
    const relocated = path.join(home, '.codex-work');
    await fse.ensureDir(relocated);

    const reconciled = await writeAndTrust(userConfig({ toolRoots: { codex: '~/.codex-work' } }));

    expect(reconciled.codexTrust?.kind).toBe('trusted');
    expect(trustedKeys(relocated).length).toBeGreaterThan(0);
    expect(calls('hooks/list')).toBe(0);
  });

  it('reports Codex as unavailable when it is not on PATH', async () => {
    const empty = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-trust-empty-'));
    vi.stubEnv('PATH', empty);
    try {
      const reconciled = await writeAndTrust(userConfig());
      expect(reconciled.codexTrust).toEqual({ kind: 'unavailable', reason: 'codex is not on PATH and no Codex desktop app is installed' });
    } finally {
      await fse.remove(empty);
    }
  });

  it('reports the failing call when the app-server answers with an error', async () => {
    writeFakeCodexOptions(codexHome(), { failMethod: 'hooks/list' });

    const reconciled = await writeAndTrust(userConfig());

    expect(reconciled.codexTrust).toEqual({ kind: 'failed', reason: 'hooks/list: fake failure' });
  });

  it('closes the app-server when initialization fails', async () => {
    writeFakeCodexOptions(codexHome(), { failMethod: 'initialize' });
    const result = await writeAndTrust(userConfig());
    expect(result.codexTrust).toEqual({ kind: 'failed', reason: 'initialize: fake failure' });
    const pid = readFakeCodexState(codexHome()).pid!;
    const running = () => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    try {
      await expect.poll(running, { timeout: 1000 }).toBe(false);
    } finally {
      if (running()) process.kill(pid);
    }
  });

  it('reports a failure when the app-server exits before answering', async () => {
    writeFakeCodexOptions(codexHome(), { exit: true });

    const reconciled = await writeAndTrust(userConfig());

    expect(reconciled.codexTrust?.kind).toBe('failed');
  });

  it('does not touch Codex when the member turned it off', async () => {
    const reconciled = await writeAndTrust(userConfig({ codexTrustEnabled: false }));

    expect(reconciled.codexTrust).toEqual({ kind: 'disabled' });
    expect(readFakeCodexState(codexHome()).calls).toEqual([]);
  });

  it('does not run for the internal Codex variants, which have no trust gate', async () => {
    await fse.remove(codexHome());
    await fse.ensureDir(path.join(home, '.codex-internal'));

    const reconciled = await writeAndTrust(userConfig());

    expect(reconciled.codexTrust).toBeUndefined();
    expect(await fse.pathExists(path.join(home, '.codex-internal', 'fake-state.json'))).toBe(false);
  });

  it('has nothing to trust after a dry run or a removal', async () => {
    await writeAndTrust(userConfig(), { dryRun: true });
    await writeAndTrust(userConfig(), { removeAll: true });
    expect(await trustCodexForScope(teamConfig, userConfig())).toBeUndefined();

    expect(readFakeCodexState(codexHome()).calls).toEqual([]);
  });

  it('still trusts the built-in hooks when the team hooks do not resolve', async () => {
    await writeYaml('hooks: [unclosed');

    const reconciled = await writeAndTrust(userConfig());

    expect(reconciled.ok).toBe(false);
    expect(reconciled.codexTrust?.kind).toBe('trusted');
    expect(trustedKeys().length).toBeGreaterThan(0);
  });
});

describe('reportCodexTrust', () => {
  it('names how many hooks it trusted', () => {
    reportCodexTrust({ kind: 'trusted', hooks: 3 }, 'all');
    expect(log.success).toHaveBeenCalledWith('Trusted 3 teamai hook(s) in Codex');
  });

  it('falls back to the trust reminder when Codex is missing, and stays quiet during a pull', () => {
    reportCodexTrust({ kind: 'unavailable', reason: 'codex is not on PATH' }, 'problems');
    expect(log.warn).not.toHaveBeenCalled();
    reportCodexTrust({ kind: 'unavailable', reason: 'codex is not on PATH' }, 'all');
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatch(/open \/hooks/);
  });

  it('gives the cause of a failure, also during a pull', () => {
    reportCodexTrust({ kind: 'failed', reason: 'hooks/list: boom' }, 'problems');
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatch(/^Could not trust the teamai hooks in Codex \(hooks\/list: boom\)\./);
  });

  it.each([0, 3])('reports untrusted project configuration without assuming a hook path (%i hooks)', (hooks) => {
    reportCodexTrust({ kind: 'project-untrusted', hooks, project: '/p' }, 'problems');
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toBe(
      "Codex marks /p as untrusted, so it does not load teamai's project hooks or MCP configuration. "
      + 'teamai leaves that choice to you: trust the project in Codex to load its configuration.',
    );
  });

  it('says a project the member marked untrusted was left so', () => {
    reportCodexTrust({ kind: 'project-untrusted', hooks: 0, project: '/p' }, 'problems');
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatch(/Codex marks \/p as untrusted/);
  });
});

describe('Codex trust — skipping a pass that has nothing new', () => {
  it('does not start Codex again while nothing it depends on changed', async () => {
    await writeAndTrust(userConfig());
    await writeAndTrust(userConfig());

    expect(calls('initialize')).toBe(1);
  });

  it('asks Codex again once its config changed (the member untrusted a hook)', async () => {
    await writeAndTrust(userConfig());
    await fse.appendFile(path.join(codexHome(), 'config.toml'), '\n# edited\n');

    await writeAndTrust(userConfig());

    expect(calls('initialize')).toBe(2);
  });

  it('asks Codex again when forced (init, hooks inject)', async () => {
    await writeAndTrust(userConfig());

    await trustCodexForScope(teamConfig, userConfig(), { force: true });

    expect(calls('initialize')).toBe(2);
  });

  it('asks Codex again after the codex binary changed (an upgrade can change its hashes)', async () => {
    await writeAndTrust(userConfig());
    await fse.appendFile(path.join(fakeBin, 'codex'), '# upgraded\n');

    await writeAndTrust(userConfig());

    expect(calls('initialize')).toBe(2);
  });

  it('does not cache a pass with a requested hook missing from hooks/list', async () => {
    await writeYaml(LINT_HOOK);
    writeFakeCodexOptions(codexHome(), { omitCommands: ['npm run lint'] });
    expect((await writeAndTrust(userConfig())).codexTrust?.kind).toBe('failed');
    expect((await writeAndTrust(userConfig())).codexTrust?.kind).toBe('failed');
    expect(calls('initialize')).toBe(2);
    writeFakeCodexOptions(codexHome(), {});
    expect((await writeAndTrust(userConfig())).codexTrust?.kind).toBe('trusted');
  });

  it('keeps asking while the last pass did not end trusted', async () => {
    writeFakeCodexOptions(codexHome(), { failMethod: 'hooks/list' });
    await writeAndTrust(userConfig());
    await writeAndTrust(userConfig());

    expect(calls('initialize')).toBe(2);
  });
});

describe('readCodexHookTrustForScope (doctor)', () => {
  it('names the teamai hooks Codex will not run, and writes nothing', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig({ codexTrustEnabled: false }));

    const report = await readCodexHookTrustForScope(teamConfig, userConfig());

    expect(report?.kind).toBe('listed');
    const notTrusted = report?.kind === 'listed' ? report.notTrusted : [];
    expect(notTrusted.map((h) => h.command)).toContain('npm run lint');
    expect(notTrusted.every((h) => h.status === 'untrusted')).toBe(true);
    expect(calls('config/batchWrite')).toBe(0);
  });

  it('reports nothing missing once teamai trusted its hooks', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());

    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toEqual({ kind: 'listed', notTrusted: [] });
  });

  it('is null when teamai wrote no Codex hook', async () => {
    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toBeNull();
  });
});

describe('Codex trust — project scopes', () => {
  let project: string;

  beforeEach(async () => {
    project = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-trust-proj-')));
  });
  afterEach(async () => {
    await fse.remove(project);
  });

  function projectConfig(extra: Partial<LocalConfig> = {}): LocalConfig {
    return userConfig({ scope: 'project', projectRoot: project, ...extra });
  }

  function selfConfig(root = project): LocalConfig {
    return userConfig({
      scope: 'project',
      projectRoot: root,
      repo: { localPath: path.join(root, '.teamai'), remote: 'x', kind: 'self', businessRepoRoot: root },
    } as Partial<LocalConfig>);
  }

  it('writes and trusts team hooks in the current workspace when the project anchor is bare', async () => {
    const bare = path.join(home, 'bare.git');
    await fse.ensureDir(bare);
    vi.mocked(resolveAnchors).mockResolvedValue({
      workspaceRoot: project, projectAnchor: bare, mainCheckout: null,
    });
    await writeYaml(LINT_HOOK);

    const result = await writeAndTrust(projectConfig());

    const file = path.join(project, '.codex', 'hooks.json');
    expect(await fse.pathExists(file)).toBe(true);
    expect((await fse.readJson(file)).hooks.PreToolUse[0].hooks[0].command).toBe('npm run lint');
    expect(await fse.pathExists(path.join(bare, '.codex'))).toBe(false);
    expect(result.codexTrust).toMatchObject({ kind: 'trusted', project });
    expect(readFakeCodexState(codexHome()).projects).toEqual({ [project]: { trust_level: 'trusted' } });
    expect(await readCodexHookTrustForScope(teamConfig, projectConfig())).toEqual({ kind: 'listed', notTrusted: [] });
  });

  it('uses the configured project file in trust and doctor when Codex does not load it', async () => {
    await writeYaml(LINT_HOOK);
    const configured = { ...teamConfig, toolPaths: {
      codex: { settings: '.custom-codex/hooks.json', userScope: { settings: '.codex/hooks.json' } },
    } } as TeamaiConfig;
    const cfg = projectConfig();
    await reconcileTeamHooksForConfig(configured, cfg);
    const file = path.join(project, '.custom-codex', 'hooks.json');

    expect(await fse.pathExists(file)).toBe(true);
    expect(await fse.pathExists(path.join(project, '.codex', 'hooks.json'))).toBe(false);
    expect(await trustCodexForScope(configured, cfg)).toEqual({
      kind: 'failed', reason: expect.stringContaining(file),
    });
    expect(await readCodexHookTrustForScope(configured, cfg)).toEqual({
      kind: 'listed', notTrusted: [
        ...(await codexEntries(path.join(codexHome(), 'hooks.json'))).map(({ command }) => ({
          file: path.join(codexHome(), 'hooks.json'), command, status: 'untrusted',
        })),
        { file, command: 'npm run lint', status: 'not loaded' },
      ],
    });
  });

  it('keeps separate hook ownership for bare worktrees sharing one data home', async () => {
    const other = path.join(home, 'other-worktree');
    const bare = path.join(home, 'bare.git');
    await fse.ensureDir(other);
    await fse.ensureDir(bare);
    vi.mocked(resolveAnchors).mockImplementation(async (cwd) => ({
      workspaceRoot: cwd!, projectAnchor: bare, mainCheckout: null,
    }));
    const dataHome = path.join(home, 'shared-data');
    const first = projectConfig({ dataHome });
    const second = projectConfig({ dataHome, projectRoot: other });
    await writeYaml(LINT_HOOK);
    await writeAndTrust(first);
    await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));
    await writeAndTrust(second);

    await writeAndTrust(first, { removeAll: true });

    expect((await fse.readJson(path.join(project, '.codex', 'hooks.json'))).hooks.PreToolUse).toEqual([]);
    expect((await fse.readJson(path.join(other, '.codex', 'hooks.json'))).hooks.PreToolUse[0].hooks[0].command).toBe('npm run lint:fix');
  });

  it('trustCodexProject resolves symlinks and preserves an explicit untrusted choice', async () => {
    const alias = path.join(home, 'project-link');
    await fse.ensureSymlink(project, alias, 'dir');
    expect(await trustCodexProject({ codexHome: codexHome(), project: alias })).toEqual({ kind: 'trusted', hooks: 0, project });
    await fse.outputJson(path.join(codexHome(), 'fake-state.json'), {
      projects: { [project]: { trust_level: 'untrusted' } }, hooksState: {}, calls: [],
    });
    expect(await trustCodexProject({ codexHome: codexHome(), project: alias })).toEqual({ kind: 'project-untrusted', hooks: 0, project });
    expect(calls('config/batchWrite')).toBe(0);
  });

  it('self mode trusts the repo, then every teamai hook in its .codex/hooks.json', async () => {
    await fse.ensureDir(path.join(project, '.codex'));
    await fse.outputFile(path.join(project, '.teamai', 'hooks', 'hooks.yaml'), LINT_HOOK);

    const result = await writeAndTrust(selfConfig());

    const state = readFakeCodexState(codexHome());
    expect(state.projects[project]).toEqual({ trust_level: 'trusted' });
    const methods = state.calls.map((c) => c.method);
    expect(methods.indexOf('config/batchWrite')).toBeLessThan(methods.indexOf('hooks/list'));
    const entries = await codexEntries(path.join(project, '.codex', 'hooks.json'));
    expect(entries.some((e) => e.command === 'npm run lint')).toBe(true);
    expect(trustedKeys().sort()).toEqual(entries.map((e) => e.key).sort());
    expect(result.codexTrust).toEqual({ kind: 'trusted', hooks: entries.length, project });
  });

  it('a self worktree trusts the main checkout\'s hooks, which Codex reads there', async () => {
    const worktree = `${project}-wt`;
    await fse.ensureDir(worktree);
    vi.mocked(resolveAnchors).mockImplementation(async (cwd) => ({ workspaceRoot: cwd ?? project, projectAnchor: project, mainCheckout: project }));
    vi.mocked(listWorktrees).mockResolvedValue([project, worktree]);
    try {
      for (const root of [project, worktree]) {
        await fse.ensureDir(path.join(root, '.codex'));
        await reconcileTeamHooksForConfig(teamConfig, selfConfig(root));
      }
      writeFakeCodexOptions(codexHome(), { projectLayers: { [worktree]: project } });

      await trustCodexForScope(teamConfig, selfConfig(worktree));

      const mainEntries = await codexEntries(path.join(project, '.codex', 'hooks.json'));
      expect(trustedKeys()).toEqual(expect.arrayContaining(mainEntries.map((e) => e.key)));
      expect(readFakeCodexState(codexHome()).projects[project]).toEqual({ trust_level: 'trusted' });
    } finally {
      await fse.remove(worktree);
    }
  });

  it('shares the trusted fingerprint when alternating project checkouts', async () => {
    const worktree = `${project}-wt`;
    await fse.ensureDir(worktree);
    vi.mocked(resolveAnchors).mockImplementation(async (cwd) => ({ workspaceRoot: cwd ?? project, projectAnchor: project, mainCheckout: project }));
    vi.mocked(listWorktrees).mockResolvedValue([project, worktree]);
    try {
      await writeYaml(LINT_HOOK);
      const dataHome = path.join(home, '.teamai', 'shared-project');
      await writeAndTrust(projectConfig({ projectRoot: worktree, dataHome }));
      await writeAndTrust(projectConfig({ dataHome }));
      await writeAndTrust(projectConfig({ projectRoot: worktree, dataHome }));
      expect(calls('initialize')).toBe(1);
    } finally {
      await fse.remove(worktree);
    }
  });

  it('trusts the main checkout and its team hooks in a project scope', async () => {
    await writeYaml(LINT_HOOK);

    const result = await writeAndTrust(projectConfig());

    expect(readFakeCodexState(codexHome()).projects[project]).toEqual({ trust_level: 'trusted' });
    const team = await codexEntries(path.join(project, '.codex', 'hooks.json'));
    const builtins = await codexEntries(path.join(codexHome(), 'hooks.json'));
    expect(team.map((e) => e.command)).toEqual(['npm run lint']);
    expect(trustedKeys().sort()).toEqual([...team, ...builtins].map((e) => e.key).sort());
    expect(result.codexTrust).toMatchObject({ kind: 'trusted', project });
  });

  it('leaves the project alone when nothing of teamai\'s is in its .codex/', async () => {
    const result = await writeAndTrust(projectConfig());

    expect(readFakeCodexState(codexHome()).projects).toEqual({});
    expect(result.codexTrust).toEqual({ kind: 'trusted', hooks: expect.any(Number) });
  });

  it('trusts the project for the Codex project MCP servers teamai wrote, with no team hook', async () => {
    const config = projectConfig();
    const record = path.join(project, '.teamai', 'workspaces');
    const { managedMcpManifestKey, managedMcpManifestPath, getDataHome } = await import('../types.js');
    await fse.outputJson(managedMcpManifestPath(getDataHome(config), project), {
      [managedMcpManifestKey('codex', true)]: [{ name: 'demo', hash: 'x' }],
    });
    expect(await fse.pathExists(record)).toBe(true);

    await writeAndTrust(config);

    expect(readFakeCodexState(codexHome()).projects[project]).toEqual({ trust_level: 'trusted' });
  });

  it('keeps a project the member marked untrusted, and says so', async () => {
    await writeYaml(LINT_HOOK);
    await fse.outputJson(path.join(codexHome(), 'fake-state.json'), {
      projects: { [project]: { trust_level: 'untrusted' } }, hooksState: {}, calls: [],
    });

    const result = await writeAndTrust(projectConfig());

    expect(readFakeCodexState(codexHome()).projects[project]).toEqual({ trust_level: 'untrusted' });
    expect(result.codexTrust).toMatchObject({ kind: 'project-untrusted', project });
  });
});

describe('Codex hook positions (#1250)', () => {
  type Group = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
  const member = (name: string): Group => ({ hooks: [{ type: 'command', command: `echo ${name}` }] });
  const hooksFile = (): string => path.join(codexHome(), 'hooks.json');
  const codexTrust = (): CodexTrustPolicy => codexTrustPolicy(userConfig());

  async function editHooks(file: string, edit: (hooks: Record<string, Group[]>) => void): Promise<void> {
    const json = await fse.readJson(file) as { hooks: Record<string, Group[]> };
    edit(json.hooks);
    await fse.writeJson(file, json);
  }

  async function approve(file: string, ...commands: string[]): Promise<void> {
    const hooks = (await codexEntries(file)).filter((e) => commands.includes(e.command)).map((e) => ({ file, ...e }));
    expect(hooks).toHaveLength(commands.length);
    expect(await trustCodexHooks({ codexHome: codexHome(), cwd: home, hooks })).toMatchObject({ kind: 'trusted' });
  }

  async function trustByCommand(file: string): Promise<Record<string, string>> {
    const entries = await codexEntries(file);
    const report = await readCodexHookTrust({ codexHome: codexHome(), cwd: home, hooks: entries.map((e) => ({ file, ...e })) });
    if (report.kind !== 'listed') throw new Error(report.reason);
    const notTrusted = new Map(report.notTrusted.map((h) => [h.command, h.status]));
    return Object.fromEntries(entries.map((e) => [e.command, notTrusted.get(e.command) ?? 'trusted']));
  }

  async function keyOf(file: string, command: string): Promise<string | undefined> {
    return (await codexEntries(file)).find((e) => e.command === command)?.key;
  }

  it('leaves interleaved member groups where they are, and does not start Codex, when nothing changed', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => {
      for (const [event, groups] of Object.entries(hooks)) {
        hooks[event] = [member(`${event}-first`), ...groups.flatMap((group, i) => [group, member(`${event}-${i}`)])];
      }
    });
    const members = (await codexEntries(file)).map((e) => e.command).filter((c) => c.startsWith('echo '));
    await approve(file, ...members);
    const before = await fse.readFile(file, 'utf8');
    const started = calls('initialize');

    await reconcileTeamHooksForConfig(teamConfig, userConfig());
    await reconcileTeamHooksForConfig(teamConfig, userConfig());

    expect(await fse.readFile(file, 'utf8')).toBe(before);
    expect(calls('initialize')).toBe(started);
    const after = await trustByCommand(file);
    expect(members.filter((command) => after[command] !== 'trusted')).toEqual([]);
  });

  it('updates a team hook in its own slot, leaving the member group after it at its key', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.PreToolUse.push(member('after-lint')); });
    await approve(file, 'echo after-lint');
    const key = await keyOf(file, 'echo after-lint');
    const started = calls('initialize');

    await writeYaml(LINT_HOOK.replace('npm run lint', 'npm run lint:fix'));
    await reconcileTeamHooksForConfig(teamConfig, userConfig());

    expect(calls('initialize')).toBe(started);
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'npm run lint:fix' }] }, member('after-lint'),
    ]);
    expect(await keyOf(file, 'echo after-lint')).toBe(key);
    expect((await trustByCommand(file))['echo after-lint']).toBe('trusted');
  });

  it('appends a new team hook after the member groups', async () => {
    await writeYaml(LINT_HOOK);
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.PreToolUse.push(member('after-lint')); });
    await approve(file, 'echo after-lint');
    const key = await keyOf(file, 'echo after-lint');
    const started = calls('initialize');

    await writeYaml(`${LINT_HOOK}  - id: test\n    description: run tests before a tool\n    event: PreToolUse\n    command: npm test\n`);
    await reconcileTeamHooksForConfig(teamConfig, userConfig());

    expect(calls('initialize')).toBe(started);
    expect((await fse.readJson(file)).hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'npm run lint' }] },
      member('after-lint'),
      { hooks: [{ type: 'command', command: 'npm test' }] },
    ]);
    expect(await keyOf(file, 'echo after-lint')).toBe(key);
    expect((await trustByCommand(file))['echo after-lint']).toBe('trusted');
  });

  it('carries the approval of a member group a removal moves, clears the keys teamai vacated, and trusts nothing new', async () => {
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.SessionStart.push(member('approved'), member('unapproved')); });
    await approve(file, 'echo approved');

    await writeAndTrust(userConfig(), { removeAll: true });

    expect((await fse.readJson(file)).hooks.SessionStart).toEqual([member('approved'), member('unapproved')]);
    const after = await trustByCommand(file);
    expect(after['echo approved']).toBe('trusted');
    expect(after['echo unapproved']).not.toBe('trusted');
    const live = new Set((await codexEntries(file)).map((e) => e.key));
    expect(trustedKeys().filter((key) => !live.has(key))).toEqual([]);
  });

  it('clears the approval a moved, unapproved member group lands on', async () => {
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.SessionStart.push(member('unapproved')); });

    await writeAndTrust(userConfig(), { removeAll: true });

    expect((await fse.readJson(file)).hooks.SessionStart).toEqual([member('unapproved')]);
    expect(await trustByCommand(file)).toEqual({ 'echo unapproved': 'untrusted' });
  });

  it('writes no trust and starts no Codex for a move when the active config turned trust off', async () => {
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.SessionStart.push(member('approved')); });
    await approve(file, 'echo approved');
    const started = calls('initialize');
    const writes = calls('config/batchWrite');

    await reconcileTeamHooksForConfig(teamConfig, userConfig({ codexTrustEnabled: false }), { removeAll: true });

    expect((await fse.readJson(file)).hooks.SessionStart).toEqual([member('approved')]);
    expect(calls('initialize')).toBe(started);
    expect(calls('config/batchWrite')).toBe(writes);
  });

  it('writes no trust and starts no Codex for a move when the caller states no trust policy', async () => {
    await writeAndTrust(userConfig());
    const file = hooksFile();
    await editHooks(file, (hooks) => { hooks.SessionStart.push(member('approved')); });
    await approve(file, 'echo approved');
    const started = calls('initialize');

    await reconcileHooks(file, CODEX_TOOL_ID, [], { removeAll: true });

    expect((await fse.readJson(file)).hooks.SessionStart).toEqual([member('approved')]);
    expect(calls('initialize')).toBe(started);
  });

  it('starts no Codex for a move in an internal Codex variant\'s file', async () => {
    const internal = path.join(home, '.codex-internal');
    await fse.ensureDir(internal);
    const file = path.join(internal, 'hooks.json');
    await reconcileTeamHooksForConfig(teamConfig, userConfig(), { filterAgents: ['codex-internal'] });
    await editHooks(file, (hooks) => { hooks.SessionStart.push(member('mine')); });

    await reconcileTeamHooksForConfig(teamConfig, userConfig(), { removeAll: true, filterAgents: ['codex-internal'] });

    expect((await fse.readJson(file)).hooks.SessionStart).toEqual([member('mine')]);
    expect(readFakeCodexState(codexHome()).calls).toEqual([]);
    expect(await fse.pathExists(path.join(internal, 'fake-state.json'))).toBe(false);
  });

  describe('team-hook dispatchers', () => {
    let project: string;
    const stop = (timeout: number) => [{ id: 'team-stop', event: 'Stop', command: 'echo team-stop', timeout }];
    const isDispatcher = (group: Group): boolean => group.hooks[0].command.includes('--team-hooks');

    beforeEach(async () => {
      project = path.join(home, 'project');
      await fse.ensureDir(project);
    });

    it('changes a dispatcher\'s timeout in place', async () => {
      const file = hooksFile();
      await setCodexDispatcherHooks(project, stop(30));
      await reconcileCodexDispatchers(file, codexTrust());
      await editHooks(file, (hooks) => { hooks.Stop.push(member('after-dispatcher')); });
      await approve(file, 'echo after-dispatcher');
      const key = await keyOf(file, 'echo after-dispatcher');
      const started = calls('initialize');

      await setCodexDispatcherHooks(project, stop(45));
      await reconcileCodexDispatchers(file, codexTrust());

      const groups: Group[] = (await fse.readJson(file)).hooks.Stop;
      expect(groups.map(isDispatcher)).toEqual([true, false]);
      expect(groups[0].hooks[0].timeout).toBe(45);
      expect(await keyOf(file, 'echo after-dispatcher')).toBe(key);
      expect(calls('initialize')).toBe(started);
    });

    it('appends a new dispatcher after the groups already there', async () => {
      await writeAndTrust(userConfig());
      const file = hooksFile();
      await editHooks(file, (hooks) => { hooks.Stop.push(member('after-builtin')); });
      await approve(file, 'echo after-builtin');
      const before: Group[] = (await fse.readJson(file)).hooks.Stop;
      const started = calls('initialize');

      await setCodexDispatcherHooks(project, stop(30));
      await reconcileCodexDispatchers(file, codexTrust());

      const groups: Group[] = (await fse.readJson(file)).hooks.Stop;
      expect(groups.slice(0, before.length)).toEqual(before);
      expect(groups.slice(before.length).map(isDispatcher)).toEqual([true]);
      expect(calls('initialize')).toBe(started);
      expect((await trustByCommand(file))['echo after-builtin']).toBe('trusted');
    });

    it('carries the approval of a member group a removed dispatcher moves', async () => {
      const file = hooksFile();
      await setCodexDispatcherHooks(project, stop(30));
      await reconcileCodexDispatchers(file, codexTrust());
      await editHooks(file, (hooks) => { hooks.Stop.push(member('after-dispatcher')); });
      const dispatcher = (await codexEntries(file))[0].command;
      await approve(file, dispatcher, 'echo after-dispatcher');

      await setCodexDispatcherHooks(project, null);
      await reconcileCodexDispatchers(file, codexTrust());

      expect((await fse.readJson(file)).hooks.Stop).toEqual([member('after-dispatcher')]);
      expect(await trustByCommand(file)).toEqual({ 'echo after-dispatcher': 'trusted' });
      const live = new Set((await codexEntries(file)).map((e) => e.key));
      expect(trustedKeys().filter((key) => !live.has(key))).toEqual([]);
    });
  });

  describe('agent hooks', () => {
    const agent = { slug: 'a', event: 'Stop', command: 'echo agent' };

    it('replaces an agent hook in its own slot', async () => {
      const file = hooksFile();
      await applyAgentHook(file, CODEX_TOOL_ID, { ...agent, timeout: 10 }, codexTrust());
      await editHooks(file, (hooks) => { hooks.Stop.push(member('after-agent')); });
      await approve(file, 'echo after-agent');
      const key = await keyOf(file, 'echo after-agent');
      const started = calls('initialize');

      await applyAgentHook(file, CODEX_TOOL_ID, { ...agent, timeout: 20 }, codexTrust());

      expect((await fse.readJson(file)).hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: 'echo agent', timeout: 20 }] }, member('after-agent'),
      ]);
      expect(await keyOf(file, 'echo after-agent')).toBe(key);
      expect(calls('initialize')).toBe(started);
    });

    it('carries the approval of a member group a removed agent hook moves', async () => {
      const file = hooksFile();
      await applyAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());
      await editHooks(file, (hooks) => { hooks.Stop.push(member('after-agent')); });
      await approve(file, 'echo agent', 'echo after-agent');

      await removeAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());

      expect((await fse.readJson(file)).hooks.Stop).toEqual([member('after-agent')]);
      expect(await trustByCommand(file)).toEqual({ 'echo after-agent': 'trusted' });
    });

    it('keeps the approval of a member group in an event a removed agent hook does not touch', async () => {
      const file = hooksFile();
      await applyAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());
      await editHooks(file, (hooks) => {
        hooks.Stop.push(member('after-agent'));
        hooks.SessionStart = [member('other-event')];
      });
      await approve(file, 'echo agent', 'echo after-agent', 'echo other-event');

      await removeAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());

      expect(await trustByCommand(file)).toEqual({ 'echo after-agent': 'trusted', 'echo other-event': 'trusted' });
    });

    it('keeps the approval of a member group in another event when it collapses a duplicate agent hook', async () => {
      const file = hooksFile();
      await applyAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());
      await editHooks(file, (hooks) => {
        hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo agent', timeout: 5 }] }, member('after-copy'));
        hooks.SessionStart = [member('other-event')];
      });
      await approve(file, 'echo after-copy', 'echo other-event');

      await applyAgentHook(file, CODEX_TOOL_ID, agent, codexTrust());

      expect((await fse.readJson(file)).hooks.Stop).toEqual([
        { hooks: [{ type: 'command', command: 'echo agent' }] }, member('after-copy'),
      ]);
      expect(await trustByCommand(file)).toMatchObject({ 'echo after-copy': 'trusted', 'echo other-event': 'trusted' });
    });
  });

  it('keeps every member group at its index with equal bytes, for any interleaving and any update without removals', async () => {
    const file = hooksFile();
    const manifestPath = path.join(home, '.teamai', 'managed-hooks.json');
    const events = ['PreToolUse', 'Stop', 'SessionStart'];
    const teamHook = (event: string, id: string, command: string, timeout?: number): HookDef => ({
      source: 'team', key: id, event, command, description: `[teamai:hook:${id}]`, ...(timeout === undefined ? {} : { timeout }),
    });
    const event = fc.constantFrom(...events);

    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ event, timeout: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }) }), { maxLength: 6 }),
      fc.array(fc.record({ event, at: fc.nat() }), { minLength: 1, maxLength: 6 }),
      fc.array(fc.constantFrom('same', 'command', 'timeout'), { maxLength: 6 }),
      fc.array(event, { maxLength: 3 }),
      async (team, members, changes, additions) => {
        await fse.remove(file);
        await fse.remove(manifestPath);
        const installed = team.map((h, i) => teamHook(h.event, `t${i}`, `npm run t${i}`, h.timeout));
        await reconcileHooks(file, CODEX_TOOL_ID, installed, { manifestPath });
        await editHooks(file, (hooks) => members.forEach((m, i) => {
          const groups = hooks[m.event] ??= [];
          groups.splice(m.at % (groups.length + 1), 0, member(`member-${i}`));
        }));
        const placed: Record<string, Group[]> = (await fse.readJson(file)).hooks;
        const desired = [
          ...installed.map((def, i) => changes[i] === 'command' ? { ...def, command: `${def.command}:v2` }
            : changes[i] === 'timeout' ? { ...def, timeout: (def.timeout ?? 0) + 1 } : def),
          ...additions.map((e, i) => teamHook(e, `n${i}`, `npm run n${i}`)),
        ];

        await reconcileHooks(file, CODEX_TOOL_ID, desired, { manifestPath });

        const now: Record<string, Group[]> = (await fse.readJson(file)).hooks;
        for (const [name, groups] of Object.entries(placed)) {
          groups.forEach((group, index) => {
            if (group.hooks[0].command.startsWith('echo member-')) expect(now[name][index]).toEqual(group);
          });
        }
      },
    ), { numRuns: 60 });
    expect(readFakeCodexState(codexHome()).calls).toEqual([]);
  });
});

describe('Codex trust — which Codex build answers (#1244)', () => {
  const OLD = { version: '0.142.5', hashIgnores: ['additionalContextLimit'] };

  function installPathCodex(options: { version: string; hashIgnores?: string[] }): string {
    const dir = installFakeCodex(options);
    extraDirs.push(dir);
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
    return path.join(dir, 'codex');
  }

  function installDesktopCodex(version: string): string {
    return path.join(installFakeCodex({ version, dir: path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources') }), 'codex');
  }

  async function withoutCodexOnPath(): Promise<void> {
    const empty = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-trust-empty-'));
    extraDirs.push(empty);
    vi.stubEnv('PATH', empty);
  }

  function answeredBy(method?: string): string[] {
    return [...new Set(readFakeCodexState(codexHome()).calls.filter((c) => !method || c.method === method).map((c) => c.codex))];
  }

  function started(codex: string): number {
    return readFakeCodexState(codexHome()).calls.filter((c) => c.method === 'initialize' && c.codex === codex).length;
  }

  const extraDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(extraDirs.splice(0).map((dir) => fse.remove(dir)));
  });

  it('trusts and diagnoses with the newest build, and names both when PATH and the desktop app hash a hook differently', async () => {
    const old = installPathCodex(OLD);
    const desktop = installDesktopCodex('0.163.0');
    const skew = { chosen: { path: desktop, version: '0.163.0' }, others: [{ path: old, version: '0.142.5' }] };

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust).toMatchObject({ kind: 'trusted', skew });
    expect(answeredBy('config/batchWrite')).toEqual([desktop]);
    expect(answeredBy()).toEqual([desktop, old]);
    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toEqual({ kind: 'listed', notTrusted: [], skew });

    reportCodexTrust(codexTrust, 'problems');
    const warning = vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).find((m) => m.startsWith('Codex builds disagree:'));
    expect(warning).toContain(`teamai trusts its hooks with ${desktop} (codex-cli 0.163.0)`);
    expect(warning).toContain(`${old} (codex-cli 0.142.5) hashes some of them differently and skips those`);
  });

  it('warns on every pull while the builds disagree, and the second pull starts no Codex', async () => {
    installPathCodex(OLD);
    installDesktopCodex('0.163.0');

    const first = await writeAndTrust(userConfig());
    const callsAfterFirst = readFakeCodexState(codexHome()).calls.length;
    const second = await writeAndTrust(userConfig());

    expect(readFakeCodexState(codexHome()).calls.length).toBe(callsAfterFirst);
    reportCodexTrust(first.codexTrust, 'problems');
    reportCodexTrust(second.codexTrust, 'problems');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).filter((m) => m.startsWith('Codex builds disagree:'));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe(warnings[0]);
  });

  it('compares the builds again on the next pull when an older build could not list the hooks', async () => {
    const old = installPathCodex(OLD);
    installDesktopCodex('0.163.0');
    writeFakeCodexOptions(codexHome(), { failMethod: 'hooks/list', failCodex: old });
    await writeAndTrust(userConfig());
    writeFakeCodexOptions(codexHome(), {});

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(started(old)).toBe(2);
    reportCodexTrust(codexTrust, 'problems');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).filter((m) => m.startsWith('Codex builds disagree:'));
    expect(warnings).toHaveLength(1);
  });

  it('stops starting an older build once it failed to list the hooks on two pulls in a row', async () => {
    const old = installPathCodex(OLD);
    installDesktopCodex('0.163.0');
    writeFakeCodexOptions(codexHome(), { failMethod: 'hooks/list', failCodex: old });
    await writeAndTrust(userConfig());
    await writeAndTrust(userConfig());
    expect(started(old)).toBe(2);

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust?.kind).toBe('trusted');
    expect(started(old)).toBe(2);
  });

  it('re-trusts with the newest build a hash an older build wrote', async () => {
    installPathCodex(OLD);
    await writeAndTrust(userConfig());
    const desktop = installDesktopCodex('0.163.0');

    await writeAndTrust(userConfig());

    expect(started(desktop)).toBe(1);
    expect(readFakeCodexState(codexHome()).calls.filter((c) => c.method === 'config/batchWrite').map((c) => c.codex).at(-1)).toBe(desktop);
    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toMatchObject({ kind: 'listed', notTrusted: [] });
  });

  it('reports no skew when builds of different versions hash the teamai hooks alike', async () => {
    installPathCodex({ version: '0.142.5' });
    installDesktopCodex('0.163.0');

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust?.kind).toBe('trusted');
    expect(codexTrust).not.toHaveProperty('skew');
    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toEqual({ kind: 'listed', notTrusted: [] });
    reportCodexTrust(codexTrust, 'problems');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('starts no older build when the newest lists none of the teamai hooks', async () => {
    const old = installPathCodex(OLD);
    installDesktopCodex('0.163.0');
    await reconcileTeamHooksForConfig(teamConfig, userConfig());
    const commands = (await codexEntries(path.join(codexHome(), 'hooks.json'))).map((e) => e.command);
    writeFakeCodexOptions(codexHome(), { omitCommands: commands });

    expect(await trustCodexForScope(teamConfig, userConfig())).toMatchObject({ kind: 'failed' });
    expect(await readCodexHookTrustForScope(teamConfig, userConfig())).toMatchObject({ kind: 'listed' });
    expect(started(old)).toBe(0);
  });

  it('reports no skew when every build reports one version, and keeps the PATH build', async () => {
    const onPath = installPathCodex({ version: '0.163.0' });
    installDesktopCodex('0.163.0');

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust?.kind).toBe('trusted');
    expect(codexTrust).not.toHaveProperty('skew');
    expect(answeredBy()).toEqual([onPath]);
    reportCodexTrust(codexTrust, 'problems');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('uses the desktop build when codex is not on PATH', async () => {
    await withoutCodexOnPath();
    const desktop = installDesktopCodex('0.163.0');

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust?.kind).toBe('trusted');
    expect(codexTrust).not.toHaveProperty('skew');
    expect(answeredBy()).toEqual([desktop]);
  });

  it('uses ChatGPT.app codex-cli/bin/codex when codex is not on PATH', async () => {
    await withoutCodexOnPath();
    const desktop = path.join(installFakeCodex({
      version: '0.163.0',
      dir: path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
    }), 'codex');

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust?.kind).toBe('trusted');
    expect(answeredBy()).toEqual([desktop]);
  });

  it('reports Codex unavailable without starting a process when no build exists', async () => {
    await withoutCodexOnPath();
    vi.mocked(crossSpawn).mockClear();

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust).toEqual({ kind: 'unavailable', reason: 'codex is not on PATH and no Codex desktop app is installed' });
    expect(crossSpawn).not.toHaveBeenCalled();
  });

  it('counts only the most recently modified Windows desktop bundle', async () => {
    const localAppData = path.join(home, 'AppData', 'Local');
    vi.stubEnv('LOCALAPPDATA', localAppData);
    const bundle = async (hash: string, version: string, mtime: Date): Promise<string> => {
      const dir = installFakeCodex({ version, dir: path.join(localAppData, 'OpenAI', 'Codex', 'bin', hash) });
      const exe = path.join(dir, 'codex.exe');
      await fse.move(path.join(dir, 'codex'), exe);
      await fse.utimes(exe, mtime, mtime);
      return exe;
    };
    await bundle('aaa', '0.100.0', new Date('2026-01-01'));
    const newest = await bundle('bbb', '0.170.0', new Date('2026-06-01'));
    const onPath = installPathCodex({ ...OLD, version: '0.163.0' });

    const { codexTrust } = await writeAndTrust(userConfig());

    expect(codexTrust).toMatchObject({
      kind: 'trusted',
      skew: { chosen: { path: newest, version: '0.170.0' }, others: [{ path: onPath, version: '0.163.0' }] },
    });
  });

  it('asks Codex again after the desktop build changed', async () => {
    installPathCodex(OLD);
    const desktop = installDesktopCodex('0.163.0');
    await writeAndTrust(userConfig());
    await writeAndTrust(userConfig());
    expect(started(desktop)).toBe(1);

    await fse.appendFile(desktop, '# upgraded\n');
    await writeAndTrust(userConfig());

    expect(started(desktop)).toBe(2);
  });
});
