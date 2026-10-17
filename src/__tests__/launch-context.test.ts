import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { LAUNCH_PAYLOAD_KEY, launchEnv, launchHoldsCheckout, readLaunch, workflowLaunch } = await import('../launch-context.js');
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
