import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import { readSessionSharing } from '../dashboard/session-sharing.js';
import type { RunMode } from '../launch-context.js';
import { Drain } from '../score-drain.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { LabelStore } from '../scorers/label-store.js';
import { SessionCaptures } from '../session-flow/captures.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { LocalConfig } from '../types.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

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

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: One step.
steps:
  - id: review
    prompt: Review the change.
`;

const NOW = new Date().toISOString();

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-sharing-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(mocks.home, { recursive: true });
  fs.writeFileSync(path.join(mocks.home, '.gitconfig'), '[user]\n\tname = tester\n\temail = tester@example.com\n[gc]\n\tauto = 0\n');
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A team of `kind` whose repo holds `files`, cloned as this machine's user install, with its scorers cached. */
async function team(files: Record<string, string> = {}, kind: 'git' | 'http' = 'git'): Promise<LocalConfig> {
  const seed = path.join(root, 'seed');
  for (const [file, text] of Object.entries({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\n', 'scorers/quality.md': SCORER, ...files })) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'team');
  const origin = path.join(root, 'team.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const clone = path.join(root, 'team');
  git(root, 'clone', '-q', origin, clone);
  const config: LocalConfig = { repo: { localPath: clone, remote: origin, kind }, username: 'tester', scope: 'user', additionalRoles: [] };
  await syncScorerDefinitions(config);
  return config;
}

describe('the session sharing read model', () => {
  it('reads a team with no settings, from an attended machine, as the defaults with nothing waiting', async () => {
    const config = await team();

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      configured: true,
      runMode: { mode: 'attended', source: 'default' },
      archive: 'teamai-reports',
      publish: { attended: { policy: 'ask', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } },
      scoring: { state: 'ok', policies: { attended: { policy: 'off', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } }, dailyLimit: 10 },
      problems: [],
      next: [],
    });
  });

  it('reads CI as unattended, and names the team files that turn unattended off', async () => {
    const config = await team({
      'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n',
      'scorers/scoring.yaml': 'sessions: { unattended: off }\n',
    });

    expect(await readSessionSharing(config, { env: { CI: 'true' }, platform: 'linux', now: NOW })).toMatchObject({
      runMode: { mode: 'unattended', source: 'CI' },
      publish: { attended: { policy: 'ask', source: { kind: 'default' } }, unattended: { policy: 'off', source: { kind: 'setting', key: 'teamai.yaml sessions.publish.unattended' } } },
      scoring: { state: 'ok', policies: { attended: { policy: 'off', source: { kind: 'default' } }, unattended: { policy: 'off', source: { kind: 'setting', key: 'scorers/scoring.yaml sessions.unattended' } } } },
      problems: [],
    });
  });

  it('reads an HTTP team as keeping no archive, so nothing is published, and says so as doctor does', async () => {
    const config = await team({}, 'http');

    const http = { policy: 'off', source: { kind: 'http-team' } };
    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      archive: 'none',
      publish: { attended: http, unattended: http },
      problems: ['Sessions are not published: the team repo is an HTTP repo, which keeps no session archive, so sessions.publish acts as off.'],
    });
  });

  it('counts the sessions captured here by run mode and state, and serves none of their text or paths', async () => {
    const config = await team();
    captured(ATTENDED_ACTIVE, 'attended', { idleFor: HOUR });
    captured(ATTENDED_FINISHED, 'attended', { idleFor: 7 * HOUR });
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });
    captured(UNATTENDED_DRAINED, 'unattended', { idleFor: HOUR });
    await SessionCaptures.markDrained(config, { platform: 'claude-code', sessionId: UNATTENDED_DRAINED }, NOW);

    const sharing = await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW });

    expect(sharing).toMatchObject({
      captured: {
        attended: { active: 1, finished: 1, waitingToArchive: 0, archived: 0 },
        unattended: { waitingForDrain: 1, finished: 0, waitingToArchive: 1, archived: 0 },
      },
    });
    const served = JSON.stringify(sharing);
    for (const secret of [PROMPT, ANSWER, ATTENDED_ACTIVE, UNATTENDED_DRAINED, path.join(root, 'app'), mocks.home]) expect(served).not.toContain(secret);
  });

  it('leaves out of the counts a captured session whose file is gone, which is neither judged nor published', async () => {
    const config = await team();
    captured(ATTENDED_ACTIVE, 'attended', { idleFor: HOUR });
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });
    fs.rmSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      captured: {
        attended: { active: 0, finished: 0, waitingToArchive: 0, archived: 0 },
        unattended: { waitingForDrain: 0, finished: 0, waitingToArchive: 0, archived: 0 },
      },
      next: [],
    });
  });

  it('counts an unattended session as archived once an unattended drain published it', async () => {
    vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(path.delimiter));
    const config = await team();
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });

    const drained = await Drain.run([config], { mode: 'unattended' });

    expect(drained.capturedArchived).toBe(1);
    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: new Date().toISOString() })).toMatchObject({
      captured: { unattended: { waitingForDrain: 0, finished: 0, waitingToArchive: 0, archived: 1 } },
    });
  });

  it('counts pending labels, and names the drain of the run mode whose sessions wait for it', async () => {
    const config = await team();
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });
    await LabelStore.append(config, {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: ATTENDED_FINISHED }, judge: { kind: 'human' }, scoredAt: NOW,
    }, 'Did the work.');

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      pendingLabels: 1,
      next: [{ mode: 'unattended', command: 'TEAMAI_MODE=unattended teamai score --drain' }],
    });
    expect(await readSessionSharing(config, { env: { CI: 'true' }, platform: 'linux', now: NOW })).toMatchObject({
      next: [{ mode: 'unattended', command: 'teamai score --drain' }],
    });
  });

  it('names the drain of another run mode as PowerShell sets its variable when the dashboard runs on Windows', async () => {
    const config = await team();
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });

    expect(await readSessionSharing(config, { env: {}, platform: 'win32', now: NOW })).toMatchObject({
      next: [{ mode: 'unattended', command: "$env:TEAMAI_MODE='unattended'; teamai score --drain" }],
    });
    expect(await readSessionSharing(config, { env: { CI: 'true' }, platform: 'win32', now: NOW })).toMatchObject({
      next: [{ mode: 'unattended', command: 'teamai score --drain' }],
    });
  });

  it('sets the mode in every drain it names on Windows once one of them sets it, as PowerShell keeps it for the session', async () => {
    const config = await team({ 'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { attended: auto }\n' });
    captured(ATTENDED_FINISHED, 'attended', { idleFor: 7 * HOUR });
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });

    expect(await readSessionSharing(config, { env: { CI: 'true' }, platform: 'win32', now: NOW })).toMatchObject({
      next: [
        { mode: 'attended', command: "$env:TEAMAI_MODE='attended'; teamai score --drain" },
        { mode: 'unattended', command: "$env:TEAMAI_MODE='unattended'; teamai score --drain" },
      ],
    });
  });

  it('names the drain of this machine for pending labels alone, and none where no session archive can take them', async () => {
    const label = {
      scorer: 'quality', rubric: { sourceHash: 'h1' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: ATTENDED_FINISHED }, judge: { kind: 'human' }, scoredAt: NOW,
    } as const;
    const config = await team();
    await LabelStore.append(config, label, 'Did the work.');

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({ next: [{ mode: 'attended', command: 'teamai score --drain' }] });
    expect(await readSessionSharing({ ...config, repo: { ...config.repo, kind: 'http' } }, { env: {}, platform: 'linux', now: NOW })).toMatchObject({ pendingLabels: 1, next: [] });
  });

  it('names the enabled tools whose sessions are never captured, and the scorers that judge sessions', async () => {
    const config = await team({ 'scorers/style.md': SCORER.replace('sessions: true\n', '') });

    expect(await readSessionSharing({ ...config, enabledAgents: ['claude', 'pi', 'copilot'] }, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      unreadTools: ['copilot', 'pi'],
      scoring: { state: 'ok', scorers: ['quality'] },
    });
  });

  it('counts the step sessions of ended runs that wait to be archived where publish is auto for their mode, and names their drain', async () => {
    const config = await team({ 'workflows/review.yaml': WORKFLOW });
    await settledRun(config, 'unattended', { tool: 'claude', session: STEP_UNATTENDED });
    await settledRun(config, 'attended', { tool: 'claude', session: STEP_ATTENDED });

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      stepSessionsWaitingToArchive: { attended: 0, unattended: 1 },
      next: [{ mode: 'unattended', command: 'TEAMAI_MODE=unattended teamai score --drain' }],
    });
  });

  it('names no drain for an unattended session it would neither publish nor judge', async () => {
    const config = await team({
      'teamai.yaml': 'team: acme\nrepo: https://example.com/acme/team.git\nsessions:\n  publish: { unattended: off }\n',
      'scorers/quality.md': SCORER.replace('sessions: true\n', ''),
    });
    captured(UNATTENDED_OPEN, 'unattended', { idleFor: HOUR });

    expect(await readSessionSharing(config, { env: {}, platform: 'linux', now: NOW })).toMatchObject({
      scoring: { state: 'ok', policies: { unattended: { policy: 'auto' } }, scorers: [] },
      captured: { unattended: { waitingForDrain: 1 } },
      next: [],
    });
  });
});

const HOUR = 60 * 60 * 1000;
const ATTENDED_ACTIVE = '7c1e0000-0000-4000-8000-000000000001';
const ATTENDED_FINISHED = '7c1e0000-0000-4000-8000-000000000002';
const UNATTENDED_OPEN = '7c1e0000-0000-4000-8000-000000000003';
const UNATTENDED_DRAINED = '7c1e0000-0000-4000-8000-000000000004';
const STEP_UNATTENDED = '7c1e0000-0000-4000-8000-000000000021';
const STEP_ATTENDED = '7c1e0000-0000-4000-8000-000000000022';
const PROMPT = 'Rotate the PROMPT-SECRET-7 key';
const ANSWER = 'Rotated it as ANSWER-SECRET-9.';

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/**
 * A Claude session `sessionId` in `<root>/app`, captured in the user scope's data home in `runMode`, with nothing
 * happening in it for `idleFor`.
 */
function captured(sessionId: string, runMode: RunMode, { idleFor }: { idleFor: number }): void {
  const cwd = path.join(root, 'app');
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: PROMPT } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: ANSWER }] } }));
  const idleSince = new Date(Date.now() - idleFor);
  fs.utimesSync(file, idleSince, idleSince);
  const dir = path.join(mocks.home, '.teamai', 'sessions', 'captures', 'claude-code', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
  fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
    capturedAt: idleSince.toISOString(), runMode, agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
}

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

/** Runs the review workflow in `config` to its end in `runMode`, its step settled by `report` as an external driver would. */
async function settledRun(config: LocalConfig, runMode: RunMode, report: Record<string, unknown>): Promise<void> {
  await syncWorkflowDefinitions(config);
  const checkout = path.join(root, 'app');
  fs.mkdirSync(checkout, { recursive: true });
  const runId = String(data(await startRun(config, 'review', {}, { secrets: {}, runMode, checkout })).run);
  const driver = { kind: 'external', machine: 'm1', workspace: checkout };
  const { attempt, revision } = data(await leaseNext(config, runId, driver, { runMode })).lease as { attempt: string; revision: number };
  const parsed = parseReport({ attempt, revision, outcome: 'success', driver, outputs: {}, ...report });
  if (typeof parsed === 'string') throw new Error(parsed);
  data(await reportAttempt(config, runId, parsed.report));
  expect(data(await leaseNext(config, runId, driver))).toMatchObject({ done: { outcome: 'succeeded' } });
}
