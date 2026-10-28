/**
 * An unattended session is never judge work at Stop (#1385): the real hook dispatcher runs Stop on it, and only a drain
 * makes it judge work. The detached background child, the pull and the update are stubbed; the background pass runs
 * inline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() => {
    const child = {
      stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'close') setTimeout(() => cb(0), 0);
        return child;
      },
      unref: vi.fn(),
    };
    return child;
  }),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined), settleLateUsageReport: vi.fn(async () => undefined) }));
vi.mock('../update.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../update.js')>()), doUpdate: vi.fn(async () => undefined) }));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { loadLocalConfig } = await import('../config.js');
const { SESSION_RUN_PAYLOAD_KEY, sessionRun } = await import('../launch-context.js');
const { syncScorerDefinitions } = await import('../scorers/cache.js');
const { Drain } = await import('../score-drain.js');
const { encodeCwdClaude } = await import('../session-flow/fs.js');
const { AGENT_SESSION_ENV } = await import('../utils/session-id.js');
const { nextJudgeLease } = await import('../workflow/scoring.js');

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 100
sessions: true
---
Judge the session.
`;
const SESSION = '7c1e0000-0000-4000-8000-0000000000d1';
const HOUR = 60 * 60 * 1000;

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-drain-stop-')));
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home'));
  vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(path.delimiter));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** Runs the Stop hook of Claude Code session `payload` in `env`, its foreground pass then its background pass. */
async function stop(env: Record<string, string>, payload: Record<string, unknown>): Promise<void> {
  const stdinFile = path.join(root, `stop-${Math.random()}.json`);
  fs.writeFileSync(stdinFile, JSON.stringify({ ...payload, hook_event_name: 'Stop' }));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const forwarded = sessionRun(process.env);
  await hookDispatchCli('stop', 'claude', '*', { stdinFile });
  for (const key of Object.keys(env)) vi.stubEnv(key, '');
  fs.writeFileSync(stdinFile, JSON.stringify({ ...payload, hook_event_name: 'Stop', [SESSION_RUN_PAYLOAD_KEY]: forwarded }));
  await hookDispatchCli('stop', 'claude', '*', { bgOnly: true, stdinFile });
}

describe('an unattended session at Stop', () => {
  it('is no judge work after three Stops, however long after, until a drain reaches it', async () => {
    const home = path.join(root, 'home');
    const team = path.join(root, 'team');
    fs.mkdirSync(path.join(team, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(team, 'scorers', 'quality.md'), SCORER);
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${JSON.stringify(team)}\n  remote: https://example.test/acme/team.git\n  kind: git\nusername: tester\nscope: user\nadditionalRoles: []\n`);
    const config = await loadLocalConfig();
    if (!config) throw new Error('the user install did not load');
    await syncScorerDefinitions(config);
    const cwd = path.join(root, 'app');
    fs.mkdirSync(cwd, { recursive: true });
    const project = path.join(home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(project, `${SESSION}.jsonl`);
    fs.writeFileSync(transcript,
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add retries to the client' } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
    const captures = path.join(home, '.teamai', 'sessions', 'captures', 'claude-code', SESSION);
    fs.mkdirSync(captures, { recursive: true });
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-0000000000d1';
    fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId: SESSION,
      capturedAt: new Date().toISOString(), runMode: 'unattended', agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: transcript }));

    for (let turn = 0; turn < 3; turn += 1) {
      await stop({ TEAMAI_MODE: 'unattended' }, { session_id: SESSION, cwd, transcript_path: transcript });
    }

    const later = new Date(Date.now() + 7 * HOUR).toISOString();
    const request = { driver: { kind: 't3', machine: 'm1', workspace: '/w' }, judge: { isolation: 'best-effort' as const, tools: ['claude'] as [string] }, running: [] };
    expect(await nextJudgeLease(config, request, later)).toEqual({ data: { idle: { open: 0, leased: 0 } } });

    await Drain.run([config], { mode: 'unattended' });

    expect(await nextJudgeLease(config, request, later)).toMatchObject({ data: { lease: { source: 'session', subject: { platform: 'claude-code', sessionId: SESSION } } } });
  });
});
