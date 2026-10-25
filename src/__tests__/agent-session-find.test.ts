/**
 * agent-session-find.test.ts — reading the session a caller listed.
 *
 * `find` opens the file the caller listed, not another session with the same id or id suffix,
 * and redacts unless asked not to. Every store lives under a temporary home.
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
import { SessionSearchEngine } from '../session-flow/search.js';
import { SyncManager, defaultSyncMeta } from '../session-flow/sync.js';
import {
  installFakeOpencode,
  opencodeExportFixture,
  plantOpencodeSession,
  setFakeOpencodeExportError,
  setFakeOpencodeVersion,
} from './helpers/fake-opencode.js';
import { WRITABLE } from './helpers/writable-platforms.js';

const SECRET = 'sk-ABCDEFGH1234567890abcdefghij';
/** OpenCode keeps its sessions behind its CLI: a stand-in `opencode`, the only command on PATH. */
const FAKE_OPENCODE_BIN = installFakeOpencode();

function mkSession(cwd: string, text: string, createdAt = '2026-09-24T10:00:00.000Z'): Session {
  return {
    sessionId: 'source-fixture',
    title: 'find contract',
    cwd,
    platform: 'claude-internal',
    createdAt,
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text }] },
      { role: 'assistant', timestamp: '2026-09-24T10:00:05.000Z', content: [{ type: 'text', text: 'ok' }] },
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

/**
 * Write a session on `platform` in `cwd` and return the id the adapter gave it. Codex names the
 * rollout file by creation time and id, so two copies of one id need two creation times.
 */
async function plant(platform: string, cwd: string, text: string, id = '', createdAt?: string): Promise<string> {
  mocks.writeAs = id;
  try {
    return await getAdapter(platform).writeSession(mkSession(cwd, text, createdAt), cwd);
  } finally {
    mocks.writeAs = '';
  }
}

const firstText = (session: Session): string => {
  const block = session.messages[0]?.content[0];
  return block?.type === 'text' ? (block.text ?? '') : '';
};

beforeEach(() => {
  mocks.writeAs = '';
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-find-')));
  for (const dir of [
    ['.claude', 'projects'],
    ['.codebuddy', 'projects'],
    ['.codex', 'sessions'],
    ['.cursor', 'projects'],
    ['.local', 'share', 'opencode'],
    ['.workbuddy', 'projects'],
  ]) {
    fs.mkdirSync(path.join(mocks.home, ...dir), { recursive: true });
  }
  process.env.TEAMAI_CODEBUDDY_IDE_DATA = path.join(mocks.home, 'CodeBuddyExtension', 'Data');
  fs.mkdirSync(path.join(process.env.TEAMAI_CODEBUDDY_IDE_DATA, 'ext-x', 'CodeBuddyIDE', 'ext-x', 'history'), {
    recursive: true,
  });
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', FAKE_OPENCODE_BIN);
  vi.stubEnv('XDG_DATA_HOME', path.join(mocks.home, '.local', 'share'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('AgentSession.find', () => {
  it('returns the session redacted by default', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, `token ${SECRET}`);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd });

    expect(found).toMatchObject({ status: 'done', redactedCount: 1 });
    expect(found.status === 'done' && firstText(found.session)).not.toContain(SECRET);
  });

  it('returns the raw session when scrub is false', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, `token ${SECRET}`);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd }, { scrub: false });

    expect(found.status === 'done' && firstText(found.session)).toBe(`token ${SECRET}`);
    expect(found).not.toHaveProperty('redactedCount');
  });

  it('fails with not_found for a session that does not exist', async () => {
    const ref = { platform: 'claude-code', sessionId: 'no-such-session', cwd: workspace('ws') };

    expect(await AgentSession.find(ref)).toMatchObject({ status: 'failed', failure: { code: 'not_found', ref } });
  });

  // A session the client is writing at that moment must not read as absent.
  it('fails with unreadable for a session that exists but does not parse', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('claude-code', cwd, 'hello');
    const [listed] = await getAdapter('claude-code').listConversations(cwd);
    fs.writeFileSync(listed.filePath!, '{"truncated');

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd });

    expect(found).toMatchObject({ status: 'failed', failure: { code: 'unreadable' } });
  });

  const SHARED_ID = '0190a0b0-c0d0-7e0f-8a0b-0c0d0e0f1a2b';
  // One OpenCode id names one session in every workspace, so one id never lives in two.
  const ONE_ID_IN_TWO_WORKSPACES = WRITABLE.filter((platform) => platform !== 'opencode');

  it.each(ONE_ID_IN_TWO_WORKSPACES)('%s: each listed session is read from the file listed, when one id lives in two workspaces', async (platform) => {
    await plant(platform, workspace('ws-a'), 'in a', SHARED_ID);
    await plant(platform, workspace('ws-b'), 'in b', SHARED_ID, '2026-09-25T10:00:00.000Z');
    const listed = await getAdapter(platform).listConversations();
    expect(listed).toHaveLength(2);

    const texts: string[] = [];
    for (const meta of listed) {
      const found = await AgentSession.find(
        { platform, sessionId: meta.sessionId, filePath: meta.filePath },
        { scrub: false },
      );
      expect(found.status).toBe('done');
      if (found.status === 'done') texts.push(firstText(found.session));
    }

    expect(texts.sort()).toEqual(['in a', 'in b']);
  });

  // A suffix taken as the id would derive another target id than the full id, so a later
  // copy by the full id would duplicate the first.
  it('codex: an id suffix yields the full id of the session opened', async () => {
    const cwd = workspace('ws');
    const sessionId = await plant('codex', cwd, 'hello');

    const found = await AgentSession.find({ platform: 'codex', sessionId: sessionId.slice(-12), cwd });

    expect(found.status === 'done' && found.session.sessionId).toBe(sessionId);
  });

  it('codex: reads the copy in the workspace given, when one id lives in two workspaces', async () => {
    await plant('codex', workspace('ws-a'), 'in a', SHARED_ID);
    await plant('codex', workspace('ws-b'), 'in b', SHARED_ID, '2026-09-25T10:00:00.000Z');

    const inA = await AgentSession.find({ platform: 'codex', sessionId: SHARED_ID, cwd: workspace('ws-a') }, { scrub: false });
    const inB = await AgentSession.find({ platform: 'codex', sessionId: SHARED_ID, cwd: workspace('ws-b') }, { scrub: false });

    expect(inA.status === 'done' && firstText(inA.session)).toBe('in a');
    expect(inB.status === 'done' && firstText(inB.session)).toBe('in b');
  });

  // These stores keep a session under its id alone, so `readSession` falls back to the id across
  // the platform. Every other platform reads only the workspace given.
  const READ_BY_ID_ANYWHERE = new Set(['codebuddy-ide', 'cursor', 'opencode', 'workbuddy']);

  it.each(WRITABLE.filter((platform) => READ_BY_ID_ANYWHERE.has(platform)))('%s: a session outside the workspace given is found by its id', async (platform) => {
    const sessionId = await plant(platform, workspace('ws-a'), 'in a');

    const found = await AgentSession.find({ platform, sessionId, cwd: workspace('ws-b') }, { scrub: false });

    expect(found.status === 'done' && firstText(found.session)).toBe('in a');
  });

  it.each(WRITABLE.filter((platform) => !READ_BY_ID_ANYWHERE.has(platform)))('%s: a session outside the workspace given is not found', async (platform) => {
    const sessionId = await plant(platform, workspace('ws-a'), 'in a');

    const found = await AgentSession.find({ platform, sessionId, cwd: workspace('ws-b') });

    expect(found).toMatchObject({ status: 'failed', failure: { code: 'not_found' } });
  });
});

// OpenCode keeps its sessions behind its CLI. A stand-in `opencode` on PATH serves them from
// export files under the temporary data home, in the shape a real OpenCode 2 exports.
describe('AgentSession.find on OpenCode', () => {
  let dataHome = '';

  beforeEach(() => {
    dataHome = path.join(mocks.home, '.local', 'share');
  });

  /** Plant the recorded export as a session with `id` in `cwd`, its first prompt replaced by `text`. */
  function plantOpencode(cwd: string, text?: string, id = 'ses_ec4a5b73fffeRP6bDXlApNBFvY'): string {
    const session = opencodeExportFixture();
    session.info.id = id;
    session.info.location.directory = cwd;
    if (text !== undefined) session.messages[0].text = text;
    plantOpencodeSession(dataHome, session);
    return id;
  }

  it('reads a session with its tool calls, their results, and an attached image', async () => {
    const cwd = workspace('ws');
    const sessionId = plantOpencode(cwd);

    const found = await AgentSession.find({ platform: 'opencode', sessionId, cwd }, { scrub: false });

    expect(found.status).toBe('done');
    if (found.status !== 'done') return;
    expect(found.session).toMatchObject({
      sessionId,
      platform: 'opencode',
      title: 'tool probe',
      cwd,
      createdAt: new Date(1791997135138).toISOString(),
      updatedAt: new Date(1791997140333).toISOString(),
    });
    expect(found.session.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "\"Use the read tool to read notes.txt, then use the bash tool to run 'ls'. Then reply with one short sentence describing the attached image.\"",
          },
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            label: 'dot.png',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: expect.stringContaining('Let me first check the directory.') },
          {
            type: 'tool_call',
            toolName: 'read_file',
            callId: 'call_00_q74ylt4yvqpms9j096k4iuys',
            arguments: { path: '/private/tmp/oc-iso/proj/notes.txt' },
          },
          {
            type: 'tool_call',
            toolName: 'bash',
            callId: 'call_01_jd59tpf23t1tr03psnwyln88',
            arguments: { command: 'ls', workdir: '/private/tmp/oc-iso/proj' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: 'call_00_q74ylt4yvqpms9j096k4iuys',
            content: 'Read file /private/tmp/oc-iso/proj/notes.txt, lines 1-1\n1: hello from fixture',
            isError: false,
          },
          { type: 'tool_result', callId: 'call_01_jd59tpf23t1tr03psnwyln88', content: 'dot.png\nnotes.txt\n', isError: false },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Now the image: I need to inform the user I cannot read the image.' },
          { type: 'text', text: expect.stringContaining('notes.txt contains "hello from fixture"') },
        ],
      },
    ]);
  });

  it('returns the session redacted by default, and raw when scrub is false', async () => {
    const cwd = workspace('ws');
    const sessionId = plantOpencode(cwd, `token ${SECRET}`);

    const redacted = await AgentSession.find({ platform: 'opencode', sessionId, cwd });
    const raw = await AgentSession.find({ platform: 'opencode', sessionId, cwd }, { scrub: false });

    expect(redacted).toMatchObject({ status: 'done', redactedCount: 1 });
    expect(redacted.status === 'done' && firstText(redacted.session)).not.toContain(SECRET);
    expect(raw.status === 'done' && firstText(raw.session)).toBe(`token ${SECRET}`);
  });

  it('reads each session the workspace lists', async () => {
    const cwd = workspace('ws');
    plantOpencode(cwd, 'first', 'ses_ec4a5b73fffeAAAAAAAAAAAAAA');
    plantOpencode(cwd, 'second', 'ses_ec4a5b73fffeBBBBBBBBBBBBBB');
    plantOpencode(workspace('elsewhere'), 'elsewhere', 'ses_ec4a5b73fffeCCCCCCCCCCCCCC');

    const listed = await getAdapter('opencode').listConversations(cwd);
    const texts: string[] = [];
    for (const meta of listed) {
      const found = await AgentSession.find({ platform: 'opencode', sessionId: meta.sessionId, filePath: meta.filePath }, { scrub: false });
      if (found.status === 'done') texts.push(firstText(found.session));
    }

    expect(listed.map((meta) => ({ platform: meta.platform, cwd: meta.cwd, title: meta.title }))).toEqual([
      { platform: 'opencode', cwd, title: 'tool probe' },
      { platform: 'opencode', cwd, title: 'tool probe' },
    ]);
    expect(texts.sort()).toEqual(['first', 'second']);
  });

  it('fails with not_found for a session that does not exist', async () => {
    const ref = { platform: 'opencode', sessionId: 'ses_ec4a5b73fffeNoSuchSession', cwd: workspace('ws') };

    expect(await AgentSession.find(ref)).toMatchObject({ status: 'failed', failure: { code: 'not_found', ref } });
  });

  it('fails with unreadable for a session that exists but does not parse', async () => {
    const session = opencodeExportFixture();
    session.info.location.directory = workspace('ws');
    plantOpencodeSession(dataHome, session, '{"truncated');

    const found = await AgentSession.find({ platform: 'opencode', sessionId: session.info.id });

    expect(found).toMatchObject({ status: 'failed', failure: { code: 'unreadable' } });
  });

  it('fails with tool_unavailable when no opencode CLI is on PATH', async () => {
    vi.stubEnv('PATH', '');

    const found = await AgentSession.find({ platform: 'opencode', sessionId: 'ses_ec4a5b73fffeRP6bDXlApNBFvY' });

    expect(found).toMatchObject({
      status: 'failed',
      failure: { code: 'tool_unavailable', platform: 'opencode', message: expect.stringContaining('opencode CLI was not found') },
    });
  });

  // Only "Session not found" says the session is absent; any other failure leaves it unknown.
  it('fails with tool_unavailable when its CLI cannot tell whether the session exists', async () => {
    const sessionId = plantOpencode(workspace('ws'));
    setFakeOpencodeExportError(dataHome, 'Error: database is locked');

    const found = await AgentSession.find({ platform: 'opencode', sessionId });

    expect(found).toMatchObject({
      status: 'failed',
      failure: { code: 'tool_unavailable', platform: 'opencode', message: expect.stringContaining('database is locked') },
    });
  });

  // What `session push` does with a session it found, and what `session list` and `session search` read back.
  it('an archived session is listed and searchable in the team repo, its tool output included', async () => {
    const cwd = workspace('ws');
    const sessionId = plantOpencode(cwd);
    const repoRoot = fs.mkdtempSync(path.join(mocks.home, 'team-'));
    const sync = new SyncManager(repoRoot);

    const found = await AgentSession.find({ platform: 'opencode', sessionId, cwd });
    if (found.status !== 'done') throw new Error(`find failed: ${JSON.stringify(found)}`);
    const meta = defaultSyncMeta({ platform: 'opencode', author: 'tester', cwd, sessionId, title: found.session.title });
    expect((await sync.saveSession(found.session, meta)).status).toBe('written');

    const listed = sync.listSessions(null);
    const loaded = listed.map((entry) => ({ ...entry, session: sync.loadSession(null, entry.sessionName, entry.author).session }));
    const hits = await new SessionSearchEngine().search(loaded, 'lines');

    expect(listed).toMatchObject([{ platform: 'opencode', title: 'tool probe', messageCount: 4 }]);
    expect(hits).toMatchObject([{ platform: 'opencode', title: 'tool probe' }]);
  });

  // OpenCode 1 has no `opencode session export`.
  it('fails with tool_unavailable on OpenCode 1', async () => {
    plantOpencode(workspace('ws'));
    setFakeOpencodeVersion(dataHome, '1.18.23');

    const found = await AgentSession.find({ platform: 'opencode', sessionId: 'ses_ec4a5b73fffeRP6bDXlApNBFvY' });

    expect(found).toMatchObject({
      status: 'failed',
      failure: { code: 'tool_unavailable', message: expect.stringContaining('Upgrade OpenCode to version 2') },
    });
  });
});
