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

import type { LocalConfig } from '../types.js';
import { scoresDir } from '../scorers/attempts.js';
import { parseScoreLabels } from '../scorers/label.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { scoreSessions, backgroundPassScopes } from '../score-sessions.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { acquireLock, releaseLock } from '../update.js';
import { projectDataHome } from '../utils/partition.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';

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

const NOW = '2026-10-25T12:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const SESSIONS = ['7c1e0000-0000-4000-8000-000000000011', '7c1e0000-0000-4000-8000-000000000012'];

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-sessions-')));
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

/** A user scope that turns session scoring on, with the session scorer cached and `sessions` captured, idle for 7 hours. */
async function fixture(sessions: readonly string[] = SESSIONS.slice(0, 1), scorer = SCORER): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorer);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'), scoring: { sessions: true },
  };
  await syncScorerDefinitions(config);
  const cwd = path.join(root, 'app');
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  for (const [index, sessionId] of sessions.entries()) {
    const file = path.join(project, `${sessionId}.jsonl`);
    fs.writeFileSync(file,
      line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'Add retries to the client' } })
      + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId, timestamp: '2026-10-20T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
    const idleSince = new Date(Date.parse(NOW) - 7 * HOUR - index * HOUR);
    fs.utimesSync(file, idleSince, idleSince);
    const captures = path.join(root, 'data', 'sessions', 'captures', 'claude-code', sessionId);
    fs.mkdirSync(captures, { recursive: true });
    const captureId = `0b6f2a52-5d7e-4c7e-9a43-${sessionId.slice(-12)}`;
    fs.writeFileSync(path.join(captures, `${captureId}.json`), JSON.stringify({ captureId, platform: 'claude-code', sessionId,
      capturedAt: '2026-10-20T10:00:00.000Z', agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'session' }, sessionFile: file }));
  }
  return config;
}

/** A Claude judge on PATH, of `version`, that answers good. */
function fakeClaude(version = '2.1.308 (Claude Code)'): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: 'good', reasoning: 'the reasoning' } }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

/** A clock that reads `NOW` first, then `stepMs` later on each read. */
function clockFrom(stepMs: number): () => string {
  let reads = 0;
  return () => new Date(Date.parse(NOW) + stepMs * reads++).toISOString();
}

function labels(config: LocalConfig) {
  const file = path.join(scoresDir(config), 'labels.jsonl');
  return fs.existsSync(file) ? parseScoreLabels(fs.readFileSync(file, 'utf8')) : [];
}

describe('teamai score-sessions', () => {
  it('judges each finished session with the local judge and leaves its labels pending for the next pull', async () => {
    const config = await fixture(SESSIONS);
    fakeClaude();

    await scoreSessions([config], { clock: clockFrom(1000) });

    expect(labels(config).map((label) => label.source === 'session' && label.subject.sessionId).sort()).toEqual([...SESSIONS].sort());
    expect(fs.readdirSync(path.join(scoresDir(config), 'pending'))).toHaveLength(2);
  });

  it('judges a scorer that asks for verified isolation where a tool reaches it', async () => {
    const config = await fixture(SESSIONS.slice(0, 1), SCORER.replace('sessions: true\n', 'sessions: true\nisolation: verified\n'));
    fakeClaude();

    await scoreSessions([config], { clock: clockFrom(1000) });

    expect(labels(config)).toMatchObject([{ judge: { isolation: 'verified' } }]);
  });

  it('still judges a best-effort scorer where no tool reaches verified', async () => {
    const config = await fixture();
    fakeClaude('2.0.0 (Claude Code)');

    await scoreSessions([config], { clock: clockFrom(1000) });

    expect(labels(config)).toMatchObject([{ judge: { isolation: 'best-effort' } }]);
  });

  it('does nothing while another driver scores the same data home', async () => {
    const config = await fixture();
    fakeClaude();
    const lock = path.join(scoresDir(config), 'score-sessions.lock');
    expect(await acquireLock(lock)).toBe(true);

    try {
      await scoreSessions([config], { clock: clockFrom(1000) });
    } finally {
      await releaseLock(lock);
    }

    expect(labels(config)).toEqual([]);
  });

  it('takes no more work 30 minutes after it started', async () => {
    const config = await fixture(SESSIONS);
    fakeClaude();

    await scoreSessions([config], { clock: clockFrom(20 * 60 * 1000) });

    expect(labels(config)).toHaveLength(1);
  });
});

describe('the scopes a session start scores or publishes sessions in', () => {
  /** The user scope's config.yaml, with `scoring` as given. */
  function userConfig(scoring: string): void {
    const knowledge = path.join(root, 'knowledge');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.mkdirSync(path.join(mocks.home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(mocks.home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${JSON.stringify(knowledge)}\n  remote: local\n  kind: self\nusername: tester\nscope: user\nadditionalRoles: []\n${scoring}`);
  }

  it('is the user scope from a directory that no longer exists, when it turns session scoring on', async () => {
    userConfig('scoring:\n  sessions: true\n');
    expect(await backgroundPassScopes(path.join(root, 'gone'))).toMatchObject([{ scope: 'user' }]);
  });

  /** A workspace that selects project billing, with a child repo that selects checkout, and `files` in the team repo. */
  function workspace(files: Record<string, string>): string {
    const knowledge = path.join(root, 'knowledge');
    for (const [file, text] of Object.entries({
      'manifest/roles.yaml': 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n',
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: billing\n    name: Billing\n    resources: { scorers: [billing] }\n  - id: checkout\n    name: Checkout\n    resources: { scorers: [checkout] }\n',
      ...files,
    })) {
      fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
      fs.writeFileSync(path.join(knowledge, file), text);
    }
    const repoAt = (dir: string, project: string) => {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const home = projectDataHome(fs.realpathSync(dir));
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.yaml'),
        `repo:\n  localPath: ${JSON.stringify(knowledge)}\n  remote: https://git.example.com/team/team.git\nusername: tester\nscope: project\nadditionalRoles: []\nprojects: [${project}]\n`);
    };
    const ws = path.join(root, 'ws');
    repoAt(ws, 'billing');
    repoAt(path.join(ws, 'svc'), 'checkout');
    return ws;
  }

  it('reads the settings of the namespaces a workspace child makes active', async () => {
    const ws = workspace({ 'scorers/scoring.yaml': 'sessions: true\n', 'scorers/checkout/scoring.yaml': 'sessions: false\n' });
    expect(await backgroundPassScopes(ws)).toEqual([]);
  });

  it('is the workspace when only a workspace child\'s namespace turns session scoring on', async () => {
    const ws = workspace({ 'scorers/checkout/scoring.yaml': 'sessions: true\n' });
    expect(await backgroundPassScopes(ws)).toMatchObject([{ scope: 'project', children: expect.any(Object) }]);
  });

  it('is the user scope when it publishes attended sessions automatically, though it scores none', async () => {
    userConfig('sessions:\n  publish:\n    attended: auto\n');
    expect(await backgroundPassScopes(path.join(root, 'gone'))).toMatchObject([{ scope: 'user' }]);
  });

  it('is none while no scope turns session scoring on', async () => {
    userConfig('');
    expect(await backgroundPassScopes(path.join(root, 'gone'))).toEqual([]);
  });
});
