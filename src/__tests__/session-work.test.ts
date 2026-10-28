import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { AttemptStore } from '../scorers/attempts.js';
import { acquireLock, releaseLock } from '../update.js';
import { parseLeaseRef } from '../scorers/entry.js';
import { parseScoreLabels } from '../scorers/label.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { scoreSession } from '../session-flow/scoring.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { nextJudgeLease, runJudgeLease, submitJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const scorer = (frontmatter: string) => `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
${frontmatter}---
Judge the session.
`;
const SESSION_SCORER = scorer('samplingRate: 100\nsessions: true\n');

const SESSION = '7c1e0000-0000-4000-8000-000000000002';
// Local noon, so a few hours either side stay on the same local day in every time zone.
const NOW = new Date(2026, 9, 25, 12).toISOString();
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const driver = { kind: 't3', machine: 'm1', workspace: '/w' };
const request = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({ driver, judge: { isolation: 'verified', tools: ['claude'] }, running: [], ...overrides });

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-work-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

function errorOf(envelope: WorkflowEnvelope): { code: string; message: string } {
  if (!('error' in envelope)) throw new Error(`expected an error, got ${JSON.stringify(envelope.data)}`);
  return envelope.error;
}

const LeaseSchema = z.object({ ref: z.string() }).passthrough();
const leaseOf = (envelope: WorkflowEnvelope) => LeaseSchema.parse(data(envelope).lease);

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** A Claude session `sessionId` in `<root>/app`, captured in `config`'s data home in `runMode`, with nothing happening in it for `idleFor`. */
function plantSession(sessionId: string, idleFor = 7 * HOUR, runMode?: RunMode): void {
  const cwd = path.join(root, 'app');
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries to the client' } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
  const idleSince = new Date(Date.parse(NOW) - idleFor);
  fs.utimesSync(file, idleSince, idleSince);

  const captures = path.join(root, 'data', 'sessions', 'captures', 'claude-code', sessionId);
  fs.mkdirSync(captures, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
  fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
    capturedAt: '2026-10-20T10:00:00.000Z', ...(runMode ? { runMode } : {}), agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

/** A user scope with `scoring` in its `config.yaml`, `scorerText` cached, and session `SESSION` captured in `runMode` `idleFor` ago. */
async function fixture({ scorerText = SESSION_SCORER, scoring = { sessions: true }, idleFor = 7 * HOUR, runMode }: {
  scorerText?: string;
  scoring?: LocalConfig['scoring'];
  idleFor?: number;
  runMode?: RunMode;
} = {}): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorerText);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'), scoring,
  };
  await syncScorerDefinitions(config);
  plantSession(SESSION, idleFor, runMode);
  return config;
}

/** A Claude judge on PATH that answers `{ label: answer }`, or with `answer: undefined` exits 1 without one. */
function fakeClaude(answer: string | undefined): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
${answer === undefined ? 'process.exit(1);' : ''}
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: ${JSON.stringify(answer)}, reasoning: 'the reasoning' } }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

async function attemptOf(config: LocalConfig, ref: string) {
  const key = parseLeaseRef(ref);
  return key && AttemptStore.get(config, key.entry, key.attempt);
}

const IDLE = { idle: { open: 0, leased: 0 } };

describe('a finished session as judge work', () => {
  it('is leased to be submitted from the data home, and the submit keeps a session label with its agent, skills and first prompt', async () => {
    const config = await fixture();

    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
    expect(lease).toMatchObject({ source: 'session', scorer: 'quality', subject: { platform: 'claude-code', sessionId: SESSION }, cwd: path.join(root, 'data') });
    expect(fs.readFileSync(String(lease.prompt), 'utf8')).toContain('Add retries to the client');

    const labelled = data(await submitJudgeLease(config, lease.ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }, NOW));
    expect(labelled).toMatchObject({ label: { scorer: 'quality', subject: { platform: 'claude-code', sessionId: SESSION }, label: 'good', passed: true } });
    const [label] = parseScoreLabels(fs.readFileSync(path.join(root, 'data', 'scores', 'labels.jsonl'), 'utf8'));
    expect(label).toMatchObject({ source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, used: { skills: [] }, agent: { tool: { name: 'claude' } } });
    expect(fs.readFileSync(String(z.object({ label: z.object({ reasoning: z.string() }) }).parse(labelled).label.reasoning), 'utf8')).toContain('Add retries to the client');
    expect(data(await nextJudgeLease(config, request(), NOW))).toEqual(IDLE);
  });

  it.each([
    ['config.yaml does not set scoring.sessions', { scoring: {} }],
    ['no scorer sets sessions: true', { scorerText: scorer('samplingRate: 100\n') }],
    ['the scorer samples no session', { scorerText: scorer('samplingRate: 0\nsessions: true\n') }],
    ['something happened in the session within six hours', { idleFor: 5 * HOUR }],
  ])('is not handed out when %s', async (_, options) => {
    const config = await fixture(options);
    expect(data(await nextJudgeLease(config, request(), NOW))).toEqual(IDLE);
  });

  it('is not handed out when it ran unattended and no drain reached it, however long it has been idle', async () => {
    const config = await fixture({ scoring: {}, runMode: 'unattended', idleFor: 30 * HOUR });
    expect(data(await nextJudgeLease(config, request(), NOW))).toEqual(IDLE);
  });

  it('is not opened again once its lease is released', async () => {
    const config = await fixture();
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
    data(await submitJudgeLease(config, lease.ref, { driver, outcome: 'released' }, NOW));

    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
  });

  it('is left leased when the driver leaves it out of running, and not handed back', async () => {
    const config = await fixture();
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));

    expect(data(await nextJudgeLease(config, request(), at(60_000)))).toEqual({ idle: { open: 0, leased: 1 } });
    expect(await attemptOf(config, lease.ref)).toMatchObject({ status: 'leased' });
  });

  it('accepts a late submit while no judge has labelled the session since', async () => {
    const config = await fixture();
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));

    expect(data(await submitJudgeLease(config, lease.ref, { driver, outcome: 'success', answer: { label: 'bad', reasoning: 'r' } }, at(HOUR))))
      .toMatchObject({ label: { label: 'bad' } });
  });

  it('refuses a late submit once teamai score --session has labelled the session with the same rubric', async () => {
    const config = await fixture();
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
    fakeClaude('good');
    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }, at(HOUR)));

    expect(errorOf(await submitJudgeLease(config, lease.ref, { driver, outcome: 'success', answer: { label: 'bad', reasoning: 'r' } }, at(2 * HOUR))))
      .toMatchObject({ code: 'lease_expired' });
  });

  it('closes when the local judge fails, so it is not judged again', async () => {
    const config = await fixture();
    fakeClaude(undefined);
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));

    expect(errorOf(await runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW }))).toMatchObject({ code: 'judge_failed', message: expect.stringContaining('not judged again') });
    expect(await attemptOf(config, lease.ref)).toMatchObject({ status: 'failed', code: 'judge_failed' });
    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
  });

  it('starts one local judge however often score --lease runs on the lease', async () => {
    const config = await fixture();
    fakeClaude('good');
    const claude = path.join(root, 'bin', 'claude');
    fs.writeFileSync(claude, fs.readFileSync(claude, 'utf8').replace('process.stdin.resume();', `require('fs').appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, 'x'); process.stdin.resume();`));
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));

    const results = await Promise.all([runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW }), runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW })]);

    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('x');
    expect(results.filter((result) => 'error' in result).map(errorOf)).toMatchObject([{ code: 'lease_judging' }]);
    expect(errorOf(await runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW }))).toMatchObject({ code: 'lease_settled' });
  });

  it('keeps the local judge\'s answer while another process holds the attempts lock for a while', async () => {
    const config = await fixture();
    fakeClaude('good');
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
    const lock = path.join(root, 'data', 'scores', 'attempts.lock');
    expect(await acquireLock(lock)).toBe(true);
    const held = new Promise((resolve) => setTimeout(resolve, 1500)).then(() => releaseLock(lock));

    const judged = await runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW });
    await held;

    expect(data(judged)).toMatchObject({ label: { label: 'good' } });
  });

  it('closes as evidence_empty when its session file can no longer be read', async () => {
    const config = await fixture();
    fs.writeFileSync(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(path.join(root, 'app')), `${SESSION}.jsonl`), '');
    const idleSince = new Date(Date.parse(NOW) - 7 * HOUR);
    fs.utimesSync(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(path.join(root, 'app')), `${SESSION}.jsonl`), idleSince, idleSince);

    expect(data(await nextJudgeLease(config, request(), NOW))).toMatchObject({ ...IDLE, closed: [{ code: 'evidence_empty' }] });
    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
  });

  it('stops leasing for the local day once the daily limit is reached, counting a session that could not be read', async () => {
    const config = await fixture({ scoring: { sessions: true, daily_limit: 1 } });
    const OTHER = '7c1e0000-0000-4000-8000-000000000003';
    plantSession(OTHER, 8 * HOUR);
    fs.writeFileSync(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(path.join(root, 'app')), `${OTHER}.jsonl`), '');
    const idleSince = new Date(Date.parse(NOW) - 8 * HOUR);
    fs.utimesSync(path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(path.join(root, 'app')), `${OTHER}.jsonl`), idleSince, idleSince);

    expect(data(await nextJudgeLease(config, request(), NOW))).toEqual({ ...IDLE, closed: [{ ref: expect.any(String), code: 'evidence_empty' }] });
    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
    expect(leaseOf(await nextJudgeLease(config, request(), at(24 * HOUR)))).toMatchObject({ subject: { sessionId: SESSION } });
  });

  it('stays closed after a lease its driver never settled lapses, and that launch still counts for the day', async () => {
    const config = await fixture({ scoring: { sessions: true, daily_limit: 1 } });
    const OTHER = '7c1e0000-0000-4000-8000-000000000003';
    plantSession(OTHER, 8 * HOUR);
    expect(leaseOf(await nextJudgeLease(config, request(), NOW))).toMatchObject({ subject: { sessionId: OTHER } });

    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
    expect(leaseOf(await nextJudgeLease(config, request(), at(24 * HOUR)))).toMatchObject({ subject: { sessionId: SESSION } });
  });

  it('counts a launch whose local judge failed towards the daily limit', async () => {
    const config = await fixture({ scoring: { sessions: true, daily_limit: 1 } });
    plantSession('7c1e0000-0000-4000-8000-000000000003', 8 * HOUR);
    fakeClaude(undefined);
    const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
    errorOf(await runJudgeLease(config, lease.ref, { driver }, { clock: () => NOW }));

    expect(data(await nextJudgeLease(config, request(), at(HOUR)))).toEqual(IDLE);
  });

  describe('attempts of a session whose captures are gone', () => {
    async function released(): Promise<{ config: LocalConfig; ref: string }> {
      const config = await fixture();
      const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
      data(await submitJudgeLease(config, lease.ref, { driver, outcome: 'released' }, NOW));
      return { config, ref: lease.ref };
    }
    const dropCaptures = () => fs.rmSync(path.join(root, 'data', 'sessions', 'captures', 'claude-code', SESSION), { recursive: true });

    it('are removed on a later day', async () => {
      const { config, ref } = await released();
      dropCaptures();
      data(await nextJudgeLease(config, request(), at(24 * HOUR)));
      expect(await attemptOf(config, ref)).toBeUndefined();
    });

    it('are removed with the evidence of a lease that lapsed', async () => {
      const config = await fixture();
      const lease = leaseOf(await nextJudgeLease(config, request(), NOW));
      dropCaptures();
      data(await nextJudgeLease(config, request(), at(24 * HOUR)));
      expect(await attemptOf(config, lease.ref)).toBeUndefined();
      expect(fs.existsSync(String(lease.evidence))).toBe(false);
    });

    it('are removed after the team removed its last session scorer', async () => {
      const { config, ref } = await released();
      dropCaptures();
      fs.rmSync(path.join(root, 'knowledge', 'scorers', 'quality.md'));
      await syncScorerDefinitions(config);
      data(await nextJudgeLease(config, request(), at(24 * HOUR)));
      expect(await attemptOf(config, ref)).toBeUndefined();
    });

    it('are kept on the day they were leased, which they count towards', async () => {
      const { config, ref } = await released();
      dropCaptures();
      data(await nextJudgeLease(config, request(), at(HOUR)));
      expect(await attemptOf(config, ref)).toMatchObject({ status: 'released' });
    });

    it('are kept while the session is still captured', async () => {
      const { config, ref } = await released();
      data(await nextJudgeLease(config, request(), at(24 * HOUR)));
      expect(await attemptOf(config, ref)).toMatchObject({ status: 'released' });
    });
  });

  describe('of a namespace scorer', () => {
    const ROLES = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n';

    /** A member of role ops whose team keeps the session scorer in the ops namespace, with `SESSION` captured once per selection. */
    async function namespaced(...selections: Array<Record<string, unknown> | undefined>): Promise<LocalConfig> {
      const knowledge = path.join(root, 'knowledge');
      fs.mkdirSync(path.join(knowledge, 'scorers', 'ops'), { recursive: true });
      fs.mkdirSync(path.join(knowledge, 'manifest'), { recursive: true });
      fs.writeFileSync(path.join(knowledge, 'manifest', 'roles.yaml'), ROLES);
      fs.writeFileSync(path.join(knowledge, 'scorers', 'ops', 'quality.md'), SESSION_SCORER);
      const config: LocalConfig = {
        repo: { localPath: knowledge, remote: 'local', kind: 'self' },
        username: 'tester', scope: 'user', primaryRole: 'ops', additionalRoles: [], dataHome: path.join(root, 'data'), scoring: { sessions: true },
      };
      await syncScorerDefinitions(config);
      plantSession(SESSION);
      const dir = path.join(root, 'data', 'sessions', 'captures', 'claude-code', SESSION);
      const sessionFile = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(path.join(root, 'app')), `${SESSION}.jsonl`);
      fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(dir);
      for (const [index, selection] of selections.entries()) {
        const captureId = `0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f1${index}`;
        const team = selection && { revision: 'a'.repeat(40), localChanges: false, selection: { scope: 'user', additionalRoles: [], ...selection } };
        fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId: SESSION, capturedAt: `2026-10-20T10:00:1${index}.000Z`,
          agent: { v: 1, tool: { name: 'claude' }, ...(team ? { team } : {}), teamai: '1.0.0', driver: 'session' }, sessionFile }));
      }
      return config;
    }

    it('judges a session whose captures all had the namespace active', async () => {
      const config = await namespaced({ primaryRole: 'ops' }, { primaryRole: 'ops' });
      expect(leaseOf(await nextJudgeLease(config, request(), NOW))).toMatchObject({ scorer: 'quality', subject: { sessionId: SESSION } });
    });

    it.each([
      ['a capture had another role', [{ primaryRole: 'ops' }, { primaryRole: 'dev' }]],
      ['a capture records no selection', [{ primaryRole: 'ops' }, undefined]],
      ['a capture saw other workspace children', [{ primaryRole: 'ops', children: 'f'.repeat(64) }]],
    ])('leaves the session alone when %s', async (_, selections) => {
      const config = await namespaced(...selections);
      expect(data(await nextJudgeLease(config, request(), NOW))).toEqual(IDLE);
    });
  });
});
