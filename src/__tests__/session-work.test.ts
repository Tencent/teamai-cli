import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { FinishedSessions } from '../session-flow/finished-sessions.js';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { judgeSession } from '../session-flow/session-work.js';
import { redact } from '@teamai/shared/redact';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';

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

/** The scorers `teamai session list --finished` would judge session `SESSION` of `config` with. */
async function scorersOf(config: LocalConfig): Promise<string[]> {
  const listed = await FinishedSessions.list({}, { env: process.env, current: config, now: NOW });
  if (!listed.ok) throw new Error(`${listed.code}: ${listed.message}`);
  return listed.list.flatMap((item) => (item.session === SESSION ? item.scorers : []));
}

describe('a finished session of a namespace scorer', () => {
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
    expect(await scorersOf(config)).toEqual(['quality']);
  });

  it.each([
    ['a capture had another role', [{ primaryRole: 'ops' }, { primaryRole: 'dev' }]],
    ['a capture records no selection', [{ primaryRole: 'ops' }, undefined]],
    ['a capture saw other workspace children', [{ primaryRole: 'ops', children: 'f'.repeat(64) }]],
  ])('leaves the session alone when %s', async (_, selections) => {
    const config = await namespaced(...selections);
    expect(await scorersOf(config)).toEqual([]);
  });
});

describe('the transcript a judge reads', () => {
  const withCommand = (command: string): Session => ({
    sessionId: SESSION, title: 'log in', cwd: '/tmp/proj', platform: 'claude-code', createdAt: NOW, updatedAt: NOW,
    messages: [{ role: 'assistant', content: [{ type: 'tool_call', toolName: 'bash', callId: 'toolu_1', arguments: { command } }], timestamp: NOW }],
  });

  it('leaves out a subagent that worked a step confined to a directory of a workflow run, and keeps every other', () => {
    const said = (text: string): Session => ({
      sessionId: SESSION, title: 'agent', cwd: '/tmp/proj', platform: 'claude-code', createdAt: NOW, updatedAt: NOW,
      messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: NOW }],
    });
    const run = '~/.teamai/workflows/runs/r0123456789abcdef';
    const judged = judgeSession({
      platform: 'claude-code', captures: [], mask: (text) => text,
      found: {
        session: said('Add retries to sync.ts.'),
        subagents: { status: 'read', agents: [
          { session: said(`Read \`${run}/attempts/a1b2c3d4/brief.md\` and do what it says. Work only in \`${run}/scratch/a1b2c3d4/\`.`), depth: 1, start: 'unknown' },
          { session: said('Find where sync.ts retries.'), depth: 1 },
        ] },
      },
    });

    expect(judged.body).not.toContain('brief.md');
    expect(judged.body).toContain('Find where sync.ts retries.');
    expect(judged.manifest.gaps).not.toContain('subagent_boundary_unknown');
  });

  it('masks a key=value secret written as JSON inside a tool argument string', () => {
    const judged = judgeSession({
      platform: 'claude-code', found: { session: withCommand(`curl -d '{"password": "Tr0ub4dorAndHorse9"}' https://x`) },
      captures: [], mask: (text) => redact(text),
    });

    expect(judged.body).not.toContain('Tr0ub4dorAndHorse9');
    expect(judged.body).toContain('<REDACTED:kv>');
  });

  it('masks a known secret with a quote or backslash inside a tool argument string', () => {
    const secret = 'p@ss"w0rd\\x9';
    const judged = judgeSession({
      platform: 'claude-code', found: { session: withCommand(`PGPASSWORD='${secret}' psql`) },
      captures: [], mask: (text) => redact(text, { envSecrets: { DB_PASSWORD: secret } }),
    });

    expect(judged.body).not.toContain('w0rd');
    expect(judged.body).toContain('<REDACTED:DB_PASSWORD>');
  });

  it('masks a known secret with a quote or backslash used as an argument key', () => {
    const secret = 'p@ss"w0rd\\x9';
    const session = withCommand('psql');
    session.messages[0].content[0] = { type: 'tool_call', toolName: 'db', callId: 'toolu_1', arguments: { [secret]: 'login' } };
    const judged = judgeSession({
      platform: 'claude-code', found: { session },
      captures: [], mask: (text) => redact(text, { envSecrets: { DB_PASSWORD: secret } }),
    });

    expect(judged.body).not.toContain('w0rd');
    expect(judged.body).toContain('<REDACTED:DB_PASSWORD>');
  });
});
