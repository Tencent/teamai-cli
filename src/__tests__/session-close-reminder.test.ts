import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { loadLocalConfigForScope } from '../config.js';
import { readContributeState, writeContributeState } from '../contribute-check.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { SessionClose } from '../session-close.js';
import type { LocalConfig } from '../types.js';
import { CONTRIBUTE_BASE_THRESHOLD, CONTRIBUTE_SMART_THRESHOLD } from '../types.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { skillHarness } from './helpers/skill-harness.js';

const SESSION = '7c1e0000-0000-4000-8000-000000000003';
const DESCRIBE = 'teamai workflow start --describe session-close --driver skill';

const stop = buildHandlerRegistry().find(({ handler }) => handler.name === 'contribute-check')?.handler;

let home = '';
let project = '';
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-close-reminder-')));
  project = path.join(home, 'app');
  fs.mkdirSync(project);
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CI', '');
  vi.stubEnv('TEAMAI_MODE', '');
  vi.stubEnv('TEAMAI_LAUNCHED_BY', '');
  vi.stubEnv('TEAMAI_WORKFLOW_ATTEMPT', '');
  const team = path.join(home, '.teamai', 'team-repo');
  fs.mkdirSync(team, { recursive: true });
  fs.writeFileSync(path.join(team, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\nsharing:\n  recall:\n    enabled: true\n');
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), `repo:\n  localPath: ${team}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function memberConfig(): Promise<LocalConfig> {
  const config = await loadLocalConfigForScope('user', undefined, { dryRun: true });
  if (!config) throw new Error('the test member has no user-scope config');
  return config;
}

/** A session whose friction already reached the reminder's threshold, as a previous Stop cached it. */
async function frictionSession(): Promise<void> {
  await writeContributeState(SESSION, {
    contributed: false,
    smartScore: CONTRIBUTE_SMART_THRESHOLD + 1,
    toolCount: CONTRIBUTE_BASE_THRESHOLD,
    lastEvaluated: Date.now(),
    friction: { interrupt: 0, toolReject: 0, correction: 1, toolError: 0 },
  });
}

/** What the Stop hook of `tool` gives the agent for the session, under `config`. */
async function stopOf(tool: string, config: LocalConfig | null, payload: Record<string, unknown> = {}): Promise<string | null> {
  if (!stop) throw new Error('no contribute-check handler');
  const output = await stop.execute({ session_id: SESSION, cwd: project, ...payload }, tool, config);
  if (output === null) return null;
  const parsed = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) }).safeParse(JSON.parse(output));
  return parsed.success ? parsed.data.hookSpecificOutput.additionalContext : null;
}

describe('the friction reminder offers session-close', () => {
  it('names the describe command, carries no inputs, and records what it offered in the same state', async () => {
    await frictionSession();

    const reminder = await stopOf('claude', await memberConfig());

    expect(reminder).toContain(`Offer the person the session-close workflow: run \`${DESCRIBE}\` and start it with the inputs it proposes, once the person confirms them.`);
    expect(reminder).not.toContain('skill get share');
    expect(reminder).not.toContain('publish');
    expect(await readContributeState(SESSION)).toMatchObject({ hinted: true, offered: { publish: true, scorers: [] } });
  });

  it.each([
    ['below the friction threshold', { smartScore: CONTRIBUTE_SMART_THRESHOLD - 1 }],
    ['in a session with too little work', { toolCount: CONTRIBUTE_BASE_THRESHOLD - 1 }],
    ['after the person shared', { contributed: true }],
    ['after the reminder fired once', { hinted: true }],
  ])('offers nothing on a Stop where today\'s reminder does not fire: %s', async (_, seeded) => {
    await frictionSession();
    await writeContributeState(SESSION, { ...(await readContributeState(SESSION)), ...seeded });

    expect(await stopOf('claude', await memberConfig())).toBeNull();
    expect((await readContributeState(SESSION)).offered).toBeUndefined();
  });

  it('stashes the same reminder for a tool whose Stop cannot print, with what it offered', async () => {
    await frictionSession();

    expect(await stopOf('codex', await memberConfig())).toBeNull();

    const state = await readContributeState(SESSION);
    expect(state).toMatchObject({ hinted: true, offered: { publish: true, scorers: [] } });
    expect(state.pendingHint).toContain(`run \`${DESCRIBE}\``);
    expect(state.pendingHint).not.toContain('skill get share');
  });
});

describe('the friction reminder keeps today\'s text, offering nothing,', () => {
  /** Expects the Stop of `tool` to give today's reminder and record no offer. */
  async function expectTodaysReminder(config: LocalConfig, payload: Record<string, unknown> = {}): Promise<void> {
    await frictionSession();
    const reminder = await stopOf('claude', config, payload);
    expect(reminder).toContain('teamai skill get share');
    expect(reminder).not.toContain('session-close');
    const state = await readContributeState(SESSION);
    expect(state.hinted).toBe(true);
    expect(state.offered).toBeUndefined();
  }

  it.each([
    ['a workflow step', 'workflow'],
    ['a judge', 'scorer'],
  ])('in a session teamai launched for %s', async (_, launchedBy) => {
    await expectTodaysReminder(await memberConfig(), { teamai_run: { runMode: 'attended', launchedBy } });
  });

  it('in a skill driver\'s attempt, which sets TEAMAI_WORKFLOW_ATTEMPT only', async () => {
    vi.stubEnv('TEAMAI_WORKFLOW_ATTEMPT', 'r0123456789abcdef/a01234567');
    await expectTodaysReminder(await memberConfig());
  });

  it('in an unattended session', async () => {
    await expectTodaysReminder(await memberConfig(), { teamai_run: { runMode: 'unattended' } });
  });

  it('in a checkout on a workflow branch, where a step of a run works', async () => {
    execFileSync('git', ['init', '-q', '-b', 'teamai/r0123456789abcdef/fix-retries', project]);
    await expectTodaysReminder(await memberConfig());
  });

  it('where the team overrides session-close with invoke: deny', async () => {
    const config = await memberConfig();
    const workflows = path.join(config.repo.localPath, 'workflows');
    fs.mkdirSync(workflows);
    fs.writeFileSync(path.join(workflows, 'session-close.yaml'), 'schemaVersion: v1alpha1\nname: session-close\ndescription: Our close-out, started by hand only.\ninvoke: deny\nsteps:\n  - id: note\n    command: node -e "console.log(\'closed\')"\n');
    expect((await syncWorkflowDefinitions(config)).cached).toEqual(['session-close']);

    await expectTodaysReminder(config);
  });
});

describe('the session-close offer of a session that drives a skill-driven run', () => {
  const NOTE = `schemaVersion: v1alpha1
name: note
description: Write a note
invoke: allow
steps:
  - id: note
    command: node -e "console.log('noted')"
`;

  it('is nothing while the run is not done, and the offer again once it is, or for another session', async () => {
    const harness = await skillHarness({ note: NOTE });
    onTestFinished(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    const started = await harness.call({ kind: 'start', name: 'note', answers: { confirmed: false }, inputs: undefined }, { session: SESSION });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const offerTo = (sessionId: string) => SessionClose.reminderOffer(harness.config, { tool: 'claude', sessionId, cwd: harness.work, run: { runMode: 'attended' } }, { judgeTools: () => [] });

    expect(await offerTo(SESSION)).toBeUndefined();
    expect(await offerTo('another-session')).toEqual({ publish: true, scorers: [] });

    for (let poll = 0; poll < 10; poll += 1) {
      const turn = await harness.call({ kind: 'next', run: started.data.turn.run, wait: true }, { session: SESSION });
      if (!('data' in turn) || !('turn' in turn.data)) throw new Error(JSON.stringify(turn));
      if (turn.data.turn.status === 'done') break;
    }
    expect(await offerTo(SESSION)).toEqual({ publish: true, scorers: [] });
  });

  it('is nothing in a project while the session drives a run of the user scope', async () => {
    const user = await memberConfig();
    fs.mkdirSync(path.join(user.repo.localPath, 'workflows'));
    fs.writeFileSync(path.join(user.repo.localPath, 'workflows', 'note.yaml'), NOTE);
    await syncWorkflowDefinitions(user);
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    const harness = await skillHarness({}, { install: { config: user, checkout: project } });
    onTestFinished(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    // The harness gives itself a home; the member's user scope is in this one.
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const started = await harness.call({ kind: 'start', name: 'note', answers: { confirmed: false }, inputs: undefined }, { session: SESSION });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));
    const inProject: LocalConfig = { ...user, scope: 'project', projectRoot: project, dataHome: path.join(project, '.teamai') };

    expect(await SessionClose.reminderOffer(inProject, { tool: 'claude', sessionId: SESSION, cwd: project, run: { runMode: 'attended' } }, { judgeTools: () => [] })).toBeUndefined();
  });

  it('is nothing outside any project while the session drives a run of a project on this machine', async () => {
    const user = await memberConfig();
    fs.mkdirSync(path.join(user.repo.localPath, 'workflows'));
    fs.writeFileSync(path.join(user.repo.localPath, 'workflows', 'note.yaml'), NOTE);
    execFileSync('git', ['init', '-q', '-b', 'main', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    const partition = path.join(home, '.teamai', 'projects', 'app');
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'config.yaml'), `repo:\n  localPath: ${user.repo.localPath}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: project\nprojectRoot: ${project}\n`);
    const inProject: LocalConfig = { ...user, scope: 'project', projectRoot: project, dataHome: partition };
    await syncWorkflowDefinitions(inProject);
    const harness = await skillHarness({}, { install: { config: inProject, checkout: project } });
    onTestFinished(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const started = await harness.call({ kind: 'start', name: 'note', answers: { confirmed: false }, inputs: undefined }, { session: SESSION });
    if (!('data' in started) || !('turn' in started.data)) throw new Error(JSON.stringify(started));

    expect(await SessionClose.reminderOffer(user, { tool: 'claude', sessionId: SESSION, cwd: home, run: { runMode: 'attended' } }, { judgeTools: () => [] })).toBeUndefined();
  });
});
