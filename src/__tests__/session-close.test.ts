import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import type { LocalConfig } from '../types.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { LabelStore } from '../scorers/label-store.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { SessionWork } from '../session-flow/session-work.js';
import { SessionClose } from '../session-close.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';

const scorer = (frontmatter: string) => `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
${frontmatter}---
Judge the session.
`;

const SESSION = '7c1e0000-0000-4000-8000-000000000002';
const NOW = new Date(2026, 9, 25, 12).toISOString();
const ROLES = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n';
const SCORERS_WHY = 'Scorers that judge this session now.';
const PUBLISH_WHY = 'Archive this session\'s transcript, scrubbed, for the team.';

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-close-')));
  mocks.home = path.join(root, 'home');
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A dev member's user scope whose team keeps `scorers` (by relative path under scorers/) and `files`, with `config`
 * merged into config.yaml, and Claude session `SESSION` captured once with role dev.
 */
async function member({ scorers, files = {}, config = {} }: { scorers: Record<string, string>; files?: Record<string, string>; config?: Partial<LocalConfig> }): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  for (const [file, text] of Object.entries({ 'manifest/roles.yaml': ROLES, ...files, ...Object.fromEntries(Object.entries(scorers).map(([name, source]) => [`scorers/${name}`, source])) })) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), text);
  }
  const local: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', primaryRole: 'dev', additionalRoles: [], dataHome: path.join(root, 'data'),
    scoring: { sessions: { attended: 'ask' } },
    ...config,
  };
  await syncScorerDefinitions(local);
  const cwd = path.join(root, 'app');
  const sessionFile = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-25T10:00:00.000Z', message: { role: 'user', content: 'Add retries' } })}\n`);
  const captures = path.join(root, 'data', 'sessions', 'captures', 'claude-code', SESSION);
  fs.mkdirSync(captures, { recursive: true });
  const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f10';
  fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({
    captureId, platform: 'claude-code', sessionId: SESSION, capturedAt: '2026-10-25T10:00:00.000Z', sessionFile,
    agent: { v: 1, tool: { name: 'claude' }, team: { revision: 'a'.repeat(40), localChanges: false, selection: { scope: 'user', primaryRole: 'dev', additionalRoles: [] } }, teamai: '1.0.0', driver: 'session' },
  }));
  return local;
}

const offerOf = (config: LocalConfig, tool = 'claude', judgeTools = ['claude']) => SessionClose.offer(config, { tool, sessionId: SESSION }, { now: NOW, judgeTools: () => judgeTools });

describe('the session-close offer', () => {
  it('proposes the scorers that sample the session, as the background judge picks them', async () => {
    const config = await member({ scorers: {
      'review-quality.md': scorer('samplingRate: 100\nsessions: true\n'),
      'never.md': scorer('samplingRate: 0\nsessions: true\n'),
      'runs-only.md': scorer('samplingRate: 100\n'),
      'ops/ops-quality.md': scorer('samplingRate: 100\nsessions: true\n'),
    } });

    expect((await offerOf(config)).scorers).toEqual({
      value: ['review-quality'],
      why: `${SCORERS_WHY} review-quality samples this session (samplingRate 100). [] skips scoring.`,
    });
  });

  it('leaves out a scorer this session already has a label of', async () => {
    const config = await member({ scorers: { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n') } });
    const [sampled] = await SessionWork.sampledScorers(config, { platform: 'claude-code', sessionId: SESSION }, NOW);
    await LabelStore.append(config, {
      scorer: 'review-quality', rubric: { sourceHash: sampled?.pin.sourceHash ?? '' }, label: 'good', score: 1, passed: true,
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION },
      judge: { kind: 'model', tool: 'claude', isolation: 'verified', access: 'read' }, scoredAt: NOW,
    }, 'Did the work.');

    expect((await offerOf(config)).scorers).toEqual({
      value: [],
      why: `${SCORERS_WHY} None proposed: no scorer samples this session. Name any scorer to judge with it.`,
    });
  });

  it('judges here when a judge tool teamai runs is installed, and with the session\'s agent otherwise, leaving out scorers that need verified isolation', async () => {
    const scorers = { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n'), 'secure-review.md': scorer('samplingRate: 100\nsessions: true\n') };
    const config = await member({ scorers, files: { 'scorers/scoring.yaml': 'isolation: verified\n' } });

    expect(await offerOf(config, 'claude', [])).toMatchObject({
      judge: { value: 'driver', why: 'No judge tool teamai runs is installed here, so this session\'s agent judges, best-effort.' },
      scorers: {
        value: [],
        why: `${SCORERS_WHY} None proposed: review-quality and secure-review are left out: scorers/scoring.yaml asks for verified isolation, which this session's agent cannot give. Name any scorer to judge with it.`,
      },
    });

    expect(await offerOf(config)).toMatchObject({
      judge: { value: 'here', why: 'claude is installed here, so teamai\'s own judge scores it.' },
      scorers: { value: ['review-quality', 'secure-review'] },
    });
  });

  it('leaves out, for the session\'s agent, a scorer whose own file asks for verified isolation', async () => {
    const config = await member({ scorers: {
      'review-quality.md': scorer('samplingRate: 100\nsessions: true\n'),
      'secure-review.md': scorer('samplingRate: 100\nsessions: true\nisolation: verified\n'),
    } });

    expect((await offerOf(config, 'claude', [])).scorers).toEqual({
      value: ['review-quality'],
      why: `${SCORERS_WHY} review-quality samples this session (samplingRate 100). secure-review is left out: scorers/secure-review.md asks for verified isolation, which this session's agent cannot give. [] skips scoring.`,
    });
  });

  it('proposes publishing while the attended publish policy is ask, and says why not otherwise', async () => {
    const scorers = { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n') };

    expect((await offerOf(await member({ scorers }))).publish).toEqual({
      value: true,
      why: `${PUBLISH_WHY} Proposed because the attended publish policy (the default) is ask. You confirm it again from your own terminal or the dashboard before it runs.`,
    });
    expect((await offerOf(await member({ scorers, config: { sessions: { publish: { attended: 'off' } } } }))).publish).toEqual({
      value: false,
      why: `${PUBLISH_WHY} Not proposed: the attended publish policy (config.yaml sessions.publish.attended) is off.`,
    });
    expect((await offerOf(await member({ scorers, files: { 'teamai.yaml': 'team: acme\nrepo: local\nsessions:\n  publish:\n    attended: auto\n' } }))).publish).toEqual({
      value: false,
      why: `${PUBLISH_WHY} Not proposed: the attended publish policy is auto, so teamai publishes this session, scrubbed, once it has been idle 6 hours.`,
    });
  });

  it('proposes no scorer while the attended scoring policy is off or auto, and says which', async () => {
    const scorers = { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n') };

    expect((await offerOf(await member({ scorers, config: { scoring: {} } }))).scorers).toEqual({
      value: [],
      why: `${SCORERS_WHY} None proposed: the attended scoring policy (the default) is off. Name any scorer to judge with it.`,
    });
    expect((await offerOf(await member({ scorers, config: { scoring: { sessions: { attended: 'auto' } } } }))).scorers).toEqual({
      value: [],
      why: `${SCORERS_WHY} None proposed: the attended scoring policy is auto, so the background judge scores this session once it has been idle 6 hours. Name any scorer to judge with it.`,
    });
  });

  it('proposes neither publishing nor scoring for a tool teamai reads no sessions from', async () => {
    const config = await member({ scorers: { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n') } });

    expect(await offerOf(config, 'trae')).toMatchObject({
      session: { value: SESSION, why: 'The session to close: this one.' },
      source: { value: 'trae' },
      publish: { value: false, why: `${PUBLISH_WHY} Not proposed: teamai reads no sessions from trae.` },
      scorers: { value: [], why: `${SCORERS_WHY} None proposed: teamai reads no sessions from trae.` },
    });
  });

  it('names the session and its tool as teamai session list names them', async () => {
    const config = await member({ scorers: {} });

    expect(await offerOf(config)).toMatchObject({
      session: { value: SESSION, why: 'The session to close: this one.' },
      source: { value: 'claude-code', why: 'This session\'s tool, as teamai session list names it.' },
    });
  });

  it('offers in the reminder the same publish and scorers describe proposes, looking for judge tools only when a scorer needs verified isolation', async () => {
    const judgeTools = vi.fn(() => []);
    const plain = await member({ scorers: { 'review-quality.md': scorer('samplingRate: 100\nsessions: true\n') } });
    expect(await SessionClose.reminderOffer(plain, { tool: 'claude', sessionId: SESSION, cwd: root, run: { runMode: 'attended' } }, { now: NOW, judgeTools })).toEqual({ publish: true, scorers: ['review-quality'] });
    expect(judgeTools).not.toHaveBeenCalled();

    const verified = await member({ scorers: {
      'review-quality.md': scorer('samplingRate: 100\nsessions: true\n'),
      'secure-review.md': scorer('samplingRate: 100\nsessions: true\nisolation: verified\n'),
    } });
    const proposed = await offerOf(verified, 'claude', []);
    expect(await SessionClose.reminderOffer(verified, { tool: 'claude', sessionId: SESSION, cwd: root, run: { runMode: 'attended' } }, { now: NOW, judgeTools }))
      .toEqual({ publish: proposed.publish.value, scorers: proposed.scorers.value });
    expect(proposed.scorers.value).toEqual(['review-quality']);
    expect(judgeTools).toHaveBeenCalledTimes(1);
  });
});
