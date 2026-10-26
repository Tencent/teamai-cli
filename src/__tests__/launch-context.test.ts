import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { commitFile, initRepo, recordDelivery } from './helpers/delivered-checkout.js';

const { mockPull, mockSeed } = vi.hoisted(() => ({
  mockPull: vi.fn().mockResolvedValue(undefined),
  mockSeed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pull.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../pull.js')>()), pull: mockPull }));
vi.mock('../project-agent-root.js', () => ({ seedProjectAgentRoot: mockSeed }));
vi.mock('../pkg/pkg-hint.js', () => ({
  packageManifestHashForCwd: vi.fn().mockResolvedValue(null),
  stashPackageHintAfterPull: vi.fn().mockResolvedValue(undefined),
}));

const { checkoutRecordKey } = await import('../pull.js');
const {
  explainRunMode, LAUNCH_PAYLOAD_KEY, launchEnv, launchedBy, launchHoldsCheckout, readLaunch, readSessionRun, resolveRunMode, SESSION_RUN_PAYLOAD_KEY,
  sessionRun, workflowLaunch,
} = await import('../launch-context.js');
const { buildHandlerRegistry } = await import('../hook-handlers.js');

const dirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A project checkout a pull of the team clone's head delivered to claude. */
async function delivered(): Promise<{ config: LocalConfig; project: string; team: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-launch-'));
  dirs.push(root);
  const team = path.join(root, 'team');
  const project = path.join(root, 'project');
  initRepo(team);
  initRepo(project);
  commitFile(project, 'README.md');
  const rev = commitFile(team, 'skills/review/SKILL.md');
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'local', kind: 'git' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: project,
    dataHome: path.join(root, 'data'),
  };
  await recordDelivery(config, { rev: rev.slice(0, 7), targets: ['claude'] });
  return { config, project, team };
}

describe('the workflow launch signal (#1176)', () => {
  it('reads back the launch its environment carries, and nothing from a partial one', async () => {
    const { config } = await delivered();
    const launch = await workflowLaunch(config, 'claude');

    expect(launch).toEqual({ by: 'workflow', tool: 'claude', checkout: await checkoutRecordKey(config) });
    expect(launchEnv(launch!)).toMatchObject({ TEAMAI_LAUNCHED_BY: 'workflow' });
    expect(readLaunch({ ...process.env, ...launchEnv(launch!) })).toEqual(launch);
    expect(readLaunch({ TEAMAI_LAUNCHED_BY: 'workflow', TEAMAI_LAUNCHED_TOOL: 'claude' })).toBeUndefined();
    expect(readLaunch({ ...launchEnv(launch!), TEAMAI_LAUNCHED_BY: 'scorer' })).toBeUndefined();
    expect(readLaunch(undefined)).toBeUndefined();
  });

  it('holds the checkout only for the tool and checkout it was launched in', async () => {
    const { config } = await delivered();
    const launch = (await workflowLaunch(config, 'claude'))!;

    expect(await launchHoldsCheckout(config, launch)).toBe(true);
    expect(await launchHoldsCheckout(config, { ...launch, checkout: 'another-checkout' })).toBe(false);
    expect(await launchHoldsCheckout(config, { ...launch, tool: 'codex' })).toBe(false);
  });
});

describe('the run mode of a launch', () => {
  it.each([
    [{ TEAMAI_MODE: 'attended', CI: '1' }, 'attended'],
    [{ TEAMAI_MODE: 'unattended' }, 'unattended'],
    [{ TEAMAI_MODE: '', CI: '1' }, 'unattended'],
    [{ CI: '1' }, 'unattended'],
    [{ CI: 'true' }, 'unattended'],
    [{ CI: ' FALSE ' }, 'attended'],
    [{ CI: '0' }, 'attended'],
    [{ CI: '' }, 'attended'],
    [{}, 'attended'],
  ] as const)('reads %o as %s: TEAMAI_MODE, then CI, then attended', (env, mode) => {
    expect(resolveRunMode(env)).toBe(mode);
  });

  it('ignores a TEAMAI_MODE that names no mode, and says so on stderr once', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveRunMode({ TEAMAI_MODE: 'bogus', CI: '1' })).toBe('unattended');
    expect(resolveRunMode({ TEAMAI_MODE: 'bogus' })).toBe('attended');
    expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([
      'teamai: TEAMAI_MODE is "bogus", which is neither attended nor unattended, so teamai ignores it and reads the mode from CI. Set TEAMAI_MODE to attended or unattended, or unset it.\n',
    ]);
    stderr.mockRestore();
  });
});

describe('the source of a run mode (#1384)', () => {
  it.each([
    [{ TEAMAI_MODE: 'unattended' }, { mode: 'unattended', source: 'TEAMAI_MODE' }],
    [{ CI: 'true' }, { mode: 'unattended', source: 'CI' }],
    [{ CI: 'false' }, { mode: 'attended', source: 'default' }],
    [{}, { mode: 'attended', source: 'default' }],
  ] as const)('explains %o as %o', (env, explained) => {
    expect(explainRunMode(env)).toEqual(explained);
  });

  it('names the TEAMAI_MODE value it ignored, and leaves the warning to its caller', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(explainRunMode({ TEAMAI_MODE: 'robot', CI: '1' })).toEqual({ mode: 'unattended', source: 'CI', ignored: 'robot' });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('who launched a session (#1384)', () => {
  it.each([
    [{ TEAMAI_LAUNCHED_BY: 'workflow' }, 'workflow'],
    [{ TEAMAI_LAUNCHED_BY: 'scorer', TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a0000000a' }, 'scorer'],
    [{ TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a0000000a' }, 'workflow'],
    [{ TEAMAI_LAUNCHED_BY: '' }, undefined],
    [{}, undefined],
  ] as const)('reads %o as %s', (env, by) => {
    expect(launchedBy(env)).toBe(by);
  });

  it('forwards the mode and launcher through the payload, and reads nothing from a payload without them', () => {
    const run = sessionRun({ CI: '1', TEAMAI_LAUNCHED_BY: 'workflow' });

    expect(run).toEqual({ runMode: 'unattended', launchedBy: 'workflow' });
    expect(sessionRun({})).toEqual({ runMode: 'attended' });
    expect(readSessionRun({ [SESSION_RUN_PAYLOAD_KEY]: run })).toEqual(run);
    expect(readSessionRun({ [SESSION_RUN_PAYLOAD_KEY]: { runMode: 'robot' } })).toBeUndefined();
    expect(readSessionRun({})).toBeUndefined();
  });
});

describe('the launch variables have one spelling (#1384)', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

  it('are quoted only in launch-context.ts, so other code imports RUN_MODE_ENV, LAUNCHED_BY_ENV and ATTEMPT_ENV', () => {
    const owner = path.join(srcRoot, 'launch-context.ts');
    const quoted = /['"`](TEAMAI_MODE|TEAMAI_LAUNCHED_BY|TEAMAI_WORKFLOW_ATTEMPT)['"`]/;
    const offenders = sourceFiles(srcRoot).filter((file) => file !== owner && quoted.test(fs.readFileSync(file, 'utf8')));

    expect(offenders.map((file) => path.relative(srcRoot, file))).toEqual([]);
  });
});

describe('the session-start pull of a tool a workflow launched (#1176)', () => {
  const pullHandler = () => buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'pull')!.handler;

  it('leaves a checkout with a complete delivery as it is, even with a newer team commit', async () => {
    const { config, project, team } = await delivered();
    commitFile(team, 'skills/review/later.md');
    const launch = (await workflowLaunch(config, 'claude'))!;

    await pullHandler().execute({ cwd: project, [LAUNCH_PAYLOAD_KEY]: launchEnv(launch) }, 'claude', config);

    expect(mockSeed).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
  });

  it('pulls as before without a launch, or one bound to another checkout', async () => {
    const { config, project } = await delivered();
    const launch = (await workflowLaunch(config, 'claude'))!;

    await pullHandler().execute({ cwd: project }, 'claude', config);
    await pullHandler().execute({ cwd: project, [LAUNCH_PAYLOAD_KEY]: launchEnv({ ...launch, checkout: 'another-checkout' }) }, 'claude', config);

    expect(mockPull).toHaveBeenCalledTimes(2);
  });

  it('leaves the checkout as delivered for another tool the launched one starts there, even one it was not delivered to', async () => {
    const { config, project } = await delivered();
    const launch = (await workflowLaunch(config, 'claude'))!;

    await pullHandler().execute({ cwd: project, [LAUNCH_PAYLOAD_KEY]: launchEnv(launch) }, 'codex', config);

    expect(mockSeed).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
  });

  it.each([
    ['no record', async (config: LocalConfig) => { fs.rmSync(path.join(config.dataHome!, 'state.json')); }],
    ['a pending full sync', async (config: LocalConfig) => recordDelivery(config, { rev: 'HEAD', targets: ['claude'], lastPullRev: null })],
    ['targets without the tool', async (config: LocalConfig) => recordDelivery(config, { rev: 'HEAD', targets: ['codex'] })],
  ])('seeds and pulls a checkout with %s', async (_case, change) => {
    const { config, project } = await delivered();
    const launch = (await workflowLaunch(config, 'claude'))!;
    await change(config);

    await pullHandler().execute({ cwd: project, [LAUNCH_PAYLOAD_KEY]: launchEnv(launch) }, 'claude', config);

    expect(mockSeed).toHaveBeenCalledWith('claude', project);
    expect(mockPull).toHaveBeenCalledWith({ silent: true });
  });
});
