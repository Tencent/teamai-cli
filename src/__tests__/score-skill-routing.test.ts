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
import { parseScoreLabels } from '../scorers/label.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { scoreSession } from '../session-flow/scoring.js';
import { scoreSessions } from '../score-sessions.js';
import { routingScorer } from '../scorers/skill-routing.js';
import type { AvailableSkill } from '../scorers/skill-evidence.js';

const SESSION = '7c1e0000-0000-4000-8000-000000000001';
const RELEASE: AvailableSkill = { name: 'release', namespace: 'ops', description: 'Cut an npm release: bump, changelog, tag, publish.' };
const REVIEW_NOTES: AvailableSkill = { name: 'review-notes', description: 'Write review notes for a PR. Use when asked to review a branch or a PR.' };

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-routing-')));
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

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** A Claude judge on PATH that answers `answer` and counts its calls in `<root>/calls`. */
function fakeClaude(answer: string | Record<string, unknown>): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, 'x');
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify(typeof answer === 'string' ? { label: answer, reasoning: 'the reasoning' } : answer)} }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

/** A session planted under `<root>/app` with a capture that delivered `skills`, idle for seven hours. */
function plantSession(config: LocalConfig, skills: Record<string, { namespace?: string; description?: string }> | null): string {
  const cwd = path.join(root, 'app');
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  fs.writeFileSync(file,
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Review this branch and cut a release' } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Reviewed and released.' }] } }));
  const idleSince = new Date(Date.parse('2026-10-25T12:00:00.000Z') - 7 * 60 * 60 * 1000);
  fs.utimesSync(file, idleSince, idleSince);
  const captures = path.join(config.dataHome as string, 'sessions', 'captures', 'claude-code', SESSION);
  fs.mkdirSync(captures, { recursive: true });
  fs.writeFileSync(path.join(captures, '0b6f2a52-5d7e-4c7e-9a43-000000000001.json'), JSON.stringify({
    captureId: '0b6f2a52-5d7e-4c7e-9a43-000000000001', platform: 'claude-code', sessionId: SESSION,
    capturedAt: '2026-10-20T10:00:00.000Z', agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file,
    ...(skills === null ? {} : { teamSkillInfo: skills }),
  }));
  return cwd;
}

/** A user scope with `scoring.yaml` settings, session judging on and no cached scorer unless one is given. */
async function fixture(settings = '', scorers: Record<string, string> = {}): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  if (settings !== '') fs.writeFileSync(path.join(knowledge, 'scorers', 'scoring.yaml'), settings);
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'), scoring: { sessions: true },
  };
  await syncScorerDefinitions(config);
  return config;
}

const BOTH_ANSWERS = {
  'teamai:routing:ops:release': { label: 'fit', reasoning: 'the session asked for a release' },
  'teamai:routing:review-notes': { label: 'idle', reasoning: 'no review was asked for' },
};

function labels(config: LocalConfig) {
  const file = path.join(config.dataHome as string, 'scores', 'labels.jsonl');
  return fs.existsSync(file) ? parseScoreLabels(fs.readFileSync(file, 'utf8')) : [];
}

const calls = (): number => (fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').length : 0);

const data = (envelope: { error?: { code: string; message: string }; data?: unknown }): Record<string, unknown> => {
  if ('error' in envelope && envelope.error) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data as Record<string, unknown>;
};

describe('teamai score --session --scorer teamai:routing:<skill> (#1469)', () => {
  it('resolves a routing name against the session\'s delivered skills and keeps its label', async () => {
    const config = await fixture();
    plantSession(config, { release: RELEASE, 'review-notes': REVIEW_NOTES });
    fakeClaude('fit');

    expect(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['teamai:routing:review-notes'] }))).toMatchObject({
      label: { scorer: 'teamai:routing:review-notes', label: 'fit', score: 1, passed: true },
    });
    expect(labels(config)).toEqual([expect.objectContaining({
      scorer: 'teamai:routing:review-notes', label: 'fit', source: 'session',
      rubric: { sourceHash: routingScorer(REVIEW_NOTES).pin.sourceHash },
    })]);
  });

  it('a session\'s routing questions share one judge call, whatever --batch says', async () => {
    const config = await fixture();
    plantSession(config, { release: RELEASE, 'review-notes': REVIEW_NOTES });
    fakeClaude(BOTH_ANSWERS);

    const scored = data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['teamai:routing:ops:release', 'teamai:routing:review-notes'] })) as { labels: unknown[] };
    expect(scored.labels).toHaveLength(2);
    expect(calls()).toBe(1);
    expect(labels(config).map(({ scorer, label }) => [scorer, label]).sort()).toEqual([
      ['teamai:routing:ops:release', 'fit'],
      ['teamai:routing:review-notes', 'idle'],
    ]);
  });

  it('joins a session scorer\'s call only where batch puts them together', async () => {
    const config = await fixture('', {
      quality: `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
sessions: true
---
Judge the session.
`,
    });
    plantSession(config, { 'review-notes': REVIEW_NOTES });
    fakeClaude({ 'teamai:routing:review-notes': { label: 'extra', reasoning: 'loaded for no reason' }, quality: { label: 'good', reasoning: 'did the work' } });

    const scored = data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['teamai:routing:review-notes', 'quality'], batch: true })) as { labels: unknown[] };
    expect(scored.labels).toHaveLength(2);
    expect(calls()).toBe(1);
  });

  it('answers scorer_not_found for a skill the session was not delivered, or none at all', async () => {
    const delivered = await fixture();
    plantSession(delivered, { 'review-notes': REVIEW_NOTES });
    const absent = await scoreSession(delivered, { session: SESSION, source: 'claude-code', scorers: ['teamai:routing:absent'] });
    expect('error' in absent && absent.error).toMatchObject({ code: 'scorer_not_found' });

    const unknown = await fixture();
    plantSession(unknown, null);
    const noSkills = await scoreSession(unknown, { session: SESSION, source: 'claude-code', scorers: ['teamai:routing:review-notes'] });
    expect('error' in noSkills && noSkills.error).toMatchObject({ code: 'scorer_not_found' });
  });
});

describe('the background session judge with skill_routing on (#1469)', () => {
  const clock = (): string => '2026-10-25T12:00:00.000Z';

  it('asks one question per delivered skill of a finished session in one judge launch', async () => {
    const config = await fixture('skill_routing: true\n');
    plantSession(config, { release: RELEASE, 'review-notes': REVIEW_NOTES });
    fakeClaude(BOTH_ANSWERS);

    await scoreSessions([config], { clock });

    expect(labels(config).map(({ scorer, label }) => [scorer, label]).sort()).toEqual([
      ['teamai:routing:ops:release', 'fit'],
      ['teamai:routing:review-notes', 'idle'],
    ]);
    expect(calls()).toBe(1);
  });

  it('asks nothing while skill_routing is off, and nothing for a session whose captures recorded no skills', async () => {
    const off = await fixture();
    plantSession(off, { 'review-notes': REVIEW_NOTES });
    fakeClaude('fit');
    await scoreSessions([off], { clock });
    expect(labels(off)).toEqual([]);

    const unknown = await fixture('skill_routing: true\n');
    plantSession(unknown, null);
    await scoreSessions([unknown], { clock });
    expect(labels(unknown)).toEqual([]);
    expect(calls()).toBe(0);
  });
});
