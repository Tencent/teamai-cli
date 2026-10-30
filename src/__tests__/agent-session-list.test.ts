/**
 * agent-session-list.test.ts — listing the sessions of every tool through AgentSession.
 *
 * Each listed session is a ref `find` reads exactly, a tool that cannot be listed is one failure
 * value beside the other tools' sessions, and every store lives under a temporary home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '', writeAs: '' }));

// Adapter storage paths come from os.homedir(); replace it so every store is a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

// One id in two workspaces only happens with copies an older TeamAI wrote; writing through the
// adapters under a fixed id plants them.
vi.mock('../session-flow/ids.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../session-flow/ids.js');
  return {
    ...actual,
    deriveTargetSessionId: (target: Parameters<typeof actual.deriveTargetSessionId>[0]) =>
      mocks.writeAs || actual.deriveTargetSessionId(target),
  };
});

import { AgentSession } from '../session-flow/agent-session.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import type { Session } from '../session-flow/ir.js';
import { installFakeOpencode, opencodeExportFixture, plantOpencodeSession } from './helpers/fake-opencode.js';

function mkSession(cwd: string, text: string, updatedAt: string): Session {
  return {
    // Its own source id per text, so two sessions planted in one workspace get two target ids.
    sessionId: `source-${text.replace(/ /g, '-')}`,
    title: text,
    cwd,
    platform: 'claude-internal',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt,
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text }] },
      { role: 'assistant', timestamp: updatedAt, content: [{ type: 'text', text: 'ok' }] },
    ],
    metadata: {},
  };
}

/** A workspace that exists, spelled the way the file system stores it. */
function workspace(name: string): string {
  const dir = path.join(mocks.home, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

/** Write a session on `platform` in `cwd`, last updated at `updatedAt`, and return its id. */
async function plant(platform: string, cwd: string, text: string, updatedAt: string, id = ''): Promise<string> {
  mocks.writeAs = id;
  try {
    return await getAdapter(platform).writeSession(mkSession(cwd, text, updatedAt), cwd);
  } finally {
    mocks.writeAs = '';
  }
}

beforeEach(() => {
  mocks.writeAs = '';
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamailist')));
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', '');
  // Stores found through the environment stay under the temporary home too.
  vi.stubEnv('XDG_DATA_HOME', path.join(mocks.home, '.local', 'share'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(mocks.home, '.config'));
  vi.stubEnv('TEAMAI_CODEBUDDY_IDE_DATA', path.join(mocks.home, 'CodeBuddyExtension', 'Data'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('AgentSession.list', () => {
  it('lists every workspace of a tool, newest first', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const alpha = workspace('alpha');
    const beta = workspace('beta');
    const older = await plant('claude-code', alpha, 'older work', '2026-09-24T10:00:05.000Z');
    const newer = await plant('claude-code', beta, 'newer work', '2026-09-25T10:00:05.000Z');

    const listed = await AgentSession.list({ platforms: ['claude-code'] });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions.map((s) => [s.sessionId, s.cwd, s.title])).toEqual([
      [newer, beta, 'newer work'],
      [older, alpha, 'older work'],
    ]);
    expect(listed.sessions[0]).toMatchObject({ platform: 'claude-code', messageCount: 2 });
  });

  it('lists a Claude Code session under the workspace it ran in, whatever characters its path has', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const cwd = workspace('my_app-v2.0 copy');
    const id = await plant('claude-code', cwd, 'tricky path', '2026-09-24T10:00:05.000Z');

    const listed = await AgentSession.list({ platforms: ['claude-code'] });

    expect(listed.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([[id, cwd]]);
  });

  it('lists every installed tool when no tool is named, including Qoder editions in their moved stores', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(mocks.home, '.codex', 'sessions'), { recursive: true });
    const qoderRoot = path.join(mocks.home, 'qoder-config');
    const qoderCnRoot = path.join(mocks.home, 'qodercn-config');
    vi.stubEnv('QODER_CONFIG_DIR', qoderRoot);
    vi.stubEnv('QODERCN_CONFIG_DIR', qoderCnRoot);
    fs.mkdirSync(path.join(qoderRoot, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(qoderCnRoot, 'projects'), { recursive: true });
    const claudeId = await plant('claude-code', workspace('alpha'), 'claude work', '2026-09-24T10:00:05.000Z');
    const codexId = await plant('codex', workspace('beta'), 'codex work', '2026-09-25T10:00:05.000Z');
    const qoderId = await plant('qoder', workspace('gamma'), 'qoder work', '2026-09-26T10:00:05.000Z');
    const qoderCnId = await plant('qoder-cn', workspace('delta'), 'qoder cn work', '2026-09-27T10:00:05.000Z');

    const listed = await AgentSession.list();

    expect(listed.failures).toEqual([]);
    expect(listed.sessions.map((s) => [s.platform, s.sessionId])).toEqual([
      ['codex', codexId],
      ['qoder-cn', qoderCnId],
      ['qoder', qoderId],
      ['claude-code', claudeId],
    ]);
  });

  it('limits the listing to the workspace given, and to sessions updated since the time given', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const alpha = workspace('alpha');
    const oldAlpha = await plant('claude-code', alpha, 'old alpha', '2026-09-20T10:00:00.000Z');
    const newAlpha = await plant('claude-code', alpha, 'new alpha', '2026-09-26T10:00:00.000Z');
    const newBeta = await plant('claude-code', workspace('beta'), 'new beta', '2026-09-27T10:00:00.000Z');

    const inAlpha = await AgentSession.list({ platforms: ['claude-code'], cwd: alpha });
    const recent = await AgentSession.list({ platforms: ['claude-code'], updatedSince: '2026-09-25T00:00:00.000Z' });

    expect(inAlpha.sessions.map((s) => s.sessionId)).toEqual([newAlpha, oldAlpha]);
    expect(recent.sessions.map((s) => s.sessionId)).toEqual([newBeta, newAlpha]);
  });

  it('lists one id in two workspaces as two sessions, each of which find reads exactly', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const shared = '7d6c0f8e-1c2b-4a5d-9e8f-0a1b2c3d4e5f';
    await plant('claude-code', workspace('alpha'), 'alpha copy', '2026-09-24T10:00:05.000Z', shared);
    await plant('claude-code', workspace('beta'), 'beta copy', '2026-09-25T10:00:05.000Z', shared);

    const { sessions } = await AgentSession.list({ platforms: ['claude-code'] });
    const read = await Promise.all(sessions.map((listed) => AgentSession.find(listed, { scrub: false })));

    expect(sessions.map((s) => s.sessionId)).toEqual([shared, shared]);
    expect(read.map((found) => (found.status === 'done' ? found.session.title : found.failure.code))).toEqual([
      'beta copy',
      'alpha copy',
    ]);
  });

  // A session being written, or a damaged one, must not look absent: a lookup reports it unreadable.
  const READS_A_HEAD = [
    ['claude-code', ['.claude', 'projects']],
    ['qoder', ['.qoder', 'projects']],
    ['qoder-cn', ['.qoder-cn', 'projects']],
    ['codebuddy', ['.codebuddy', 'projects']],
    ['cursor', ['.cursor', 'projects']],
    ['workbuddy', ['.workbuddy', 'projects']],
  ] as const;
  it.each(READS_A_HEAD)('%s: lists a session whose first lines do not parse, and find names it unreadable', async (platform, store) => {
    fs.mkdirSync(path.join(mocks.home, ...store), { recursive: true });
    const cwd = workspace('alpha');
    const sessionId = await plant(platform, cwd, 'damaged work', '2026-09-24T10:00:05.000Z');
    const [{ filePath }] = (await AgentSession.list({ platforms: [platform], cwd })).sessions;
    fs.writeFileSync(filePath!, '{"truncated\nnot json either\n');

    const listed = await AgentSession.list({ platforms: [platform], cwd });
    const found = await AgentSession.find(listed.sessions[0], { scrub: false });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ platform, sessionId, filePath, title: `Session ${sessionId.slice(0, 8)}` });
    expect(found).toMatchObject({ status: 'failed', failure: { code: 'unreadable' } });
  });

  // Dated now, a damaged session would sort above every recent one.
  const DATED_BY_RECORDS = READS_A_HEAD.filter(([platform]) => platform === 'claude-code' || platform === 'codebuddy');
  it.each(DATED_BY_RECORDS)('%s: dates a session whose first lines do not parse by its file, not by now', async (platform, store) => {
    fs.mkdirSync(path.join(mocks.home, ...store), { recursive: true });
    const cwd = workspace('alpha');
    await plant(platform, cwd, 'damaged work', '2026-09-24T10:00:05.000Z');
    const [{ filePath }] = (await AgentSession.list({ platforms: [platform], cwd })).sessions;
    fs.writeFileSync(filePath!, '{"truncated\nnot json either\n');
    const modified = new Date('2026-01-02T03:04:05.000Z');
    fs.utimesSync(filePath!, modified, modified);

    const [listed] = (await AgentSession.list({ platforms: [platform], cwd })).sessions;

    expect(listed).toMatchObject({ createdAt: modified.toISOString(), updatedAt: modified.toISOString() });
  });

  it('names an unknown tool no_adapter and a tool that is not installed tool_unavailable, and still lists the others', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const sessionId = await plant('claude-code', workspace('alpha'), 'alpha work', '2026-09-24T10:00:05.000Z');

    const listed = await AgentSession.list({ platforms: ['nope', 'codex', 'claude-code'] });

    expect(listed.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    expect(listed.failures.map((f) => [f.code, 'platform' in f ? f.platform : ''])).toEqual([
      ['no_adapter', 'nope'],
      ['tool_unavailable', 'codex'],
    ]);
  });

  // An unreadable project directory makes the listing throw; root reads it anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a tool whose listing throws as list_failed and still lists the others',
    async () => {
      const projects = path.join(mocks.home, '.claude', 'projects');
      fs.mkdirSync(path.join(mocks.home, '.codex', 'sessions'), { recursive: true });
      const codexId = await plant('codex', workspace('alpha'), 'codex work', '2026-09-24T10:00:05.000Z');
      const locked = path.join(projects, '-locked');
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o000);
      try {
        const listed = await AgentSession.list({ platforms: ['claude-code', 'codex'] });

        expect(listed.sessions.map((s) => [s.platform, s.sessionId])).toEqual([['codex', codexId]]);
        expect(listed.failures).toEqual([
          { code: 'list_failed', platform: 'claude-code', message: expect.stringContaining('EACCES') },
        ]);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
  );
});

// OpenCode keeps its sessions behind its CLI, which lists one workspace at a time. A stand-in
// `opencode` on PATH serves them from export files under the temporary data home.
describe('AgentSession.list on OpenCode', () => {
  let dataHome = '';

  beforeEach(() => {
    dataHome = path.join(mocks.home, '.local', 'share');
    fs.mkdirSync(path.join(dataHome, 'opencode'), { recursive: true });
    vi.stubEnv('PATH', installFakeOpencode());
  });

  function plantOpencode(cwd: string, id: string): string {
    const session = opencodeExportFixture();
    session.info.id = id;
    session.info.location.directory = cwd;
    plantOpencodeSession(dataHome, session);
    return id;
  }

  it('lists the workspace given, leaving out the message count and size its CLI does not report', async () => {
    const cwd = workspace('alpha');
    const sessionId = plantOpencode(cwd, 'ses_ec4a5b73fffeAAAAAAAAAAAAAA');
    plantOpencode(workspace('beta'), 'ses_ec4a5b73fffeBBBBBBBBBBBBBB');

    const listed = await AgentSession.list({ platforms: ['opencode'], cwd });
    const found = await AgentSession.find(listed.sessions[0], { scrub: false });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ platform: 'opencode', sessionId, cwd });
    expect(listed.sessions[0]).not.toHaveProperty('messageCount');
    expect(listed.sessions[0]).not.toHaveProperty('sizeBytes');
    expect(found.status === 'done' && found.session.sessionId).toBe(sessionId);
  });

  // Inside a git repo its CLI lists the whole repo, every directory of it.
  it('lists only the workspace given when another directory of the same git repo has sessions', async () => {
    const repo = workspace('repo');
    fs.mkdirSync(path.join(repo, '.git'));
    const sub1 = workspace(path.join('repo', 'sub_1'));
    const sessionId = plantOpencode(sub1, 'ses_ec4a5b73fffeAAAAAAAAAAAAAA');
    plantOpencode(workspace(path.join('repo', 'sub_2')), 'ses_ec4a5b73fffeBBBBBBBBBBBBBB');

    const listed = await AgentSession.list({ platforms: ['opencode'], cwd: sub1 });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([[sessionId, sub1]]);
  });

  // Its CLI cannot list every workspace; listing only the one this process runs in would look complete.
  it('reports list_failed without a workspace, and still lists the other tools', async () => {
    fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
    const claudeId = await plant('claude-code', workspace('alpha'), 'claude work', '2026-09-24T10:00:05.000Z');
    plantOpencode(process.cwd(), 'ses_ec4a5b73fffeAAAAAAAAAAAAAA');

    const listed = await AgentSession.list({ platforms: ['opencode', 'claude-code'] });

    expect(listed.sessions.map((s) => s.sessionId)).toEqual([claudeId]);
    expect(listed.failures).toEqual([
      { code: 'list_failed', platform: 'opencode', message: expect.stringContaining('one workspace at a time') },
    ]);
  });

  it('names a missing opencode CLI tool_unavailable', async () => {
    vi.stubEnv('PATH', '');

    const listed = await AgentSession.list({ platforms: ['opencode'], cwd: workspace('alpha') });

    expect(listed.failures).toEqual([
      { code: 'tool_unavailable', platform: 'opencode', message: expect.stringContaining('opencode CLI was not found') },
    ]);
  });
});
