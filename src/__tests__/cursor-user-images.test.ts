/**
 * cursor-user-images.test.ts — Cursor has no image storage, so an image a
 * member pasted is written as the shared placeholder in the transcript and in
 * the composer bubbles, and the fidelity report counts it as degraded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { getAdapter } from '../session-flow/adapters/index.js';
import { fidelityFromSession } from '../session-flow/migrate.js';
import type { Session } from '@teamai/tool-core/sessions/ir';

// 4 base64 chars -> 3 bytes -> rounds to 0KB.
const PLACEHOLDER = '[image: pic.png, 0KB]';

function sessionWithUserImages(): Session {
  return {
    sessionId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
    title: 'pasted images',
    cwd: '/proj/alpha',
    platform: 'claude-code',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      {
        role: 'user',
        timestamp: '2026-09-24T10:00:00.000Z',
        content: [
          { type: 'text', text: 'what is wrong in this screenshot' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA', label: 'pic.png' },
        ],
      },
      { role: 'assistant', timestamp: '2026-09-24T10:00:01.000Z', content: [{ type: 'text', text: 'the margin' }] },
      {
        role: 'user',
        timestamp: '2026-09-24T10:00:02.000Z',
        content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA', label: 'pic.png' }],
      },
      { role: 'assistant', timestamp: '2026-09-24T10:00:03.000Z', content: [{ type: 'text', text: 'fixed now' }] },
    ],
    metadata: {},
  };
}

function textOf(session: Session): string[] {
  return session.messages.map((m) =>
    m.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join(' | '),
  );
}

/**
 * A real Cursor composer store under the temporary home that knows the workspace `cwd`.
 * Returns the path of its state.vscdb.
 */
function createCursorStore(cwd: string): string {
  fs.mkdirSync(cwd, { recursive: true });
  const userDir =
    process.platform === 'darwin'
      ? path.join(mocks.home, 'Library', 'Application Support', 'Cursor', 'User')
      : path.join(mocks.home, '.config', 'Cursor', 'User');
  const wsDir = path.join(userDir, 'workspaceStorage', 'ws1');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: `file://${cwd}` }));
  const db = path.join(userDir, 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const schema = spawnSync('sqlite3', [db], {
    encoding: 'utf-8',
    input:
      'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);' +
      'CREATE TABLE composerHeaders (composerId TEXT UNIQUE, workspaceId TEXT, createdAt INTEGER,' +
      ' lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER,' +
      ' checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);',
  });
  expect(schema.status, schema.stderr).toBe(0);
  return db;
}

/** The composer bubbles Cursor shows, oldest first. */
function readBubbles(db: string): { type: number; text: string; createdAt: string }[] {
  const rows = spawnSync('sqlite3', ['-json', db, "SELECT value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';"], {
    encoding: 'utf-8',
  });
  expect(rows.status, rows.stderr).toBe(0);
  return (JSON.parse(rows.stdout || '[]') as { value: string }[])
    .map((r) => JSON.parse(r.value) as { type: number; text: string; createdAt: string })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

beforeEach(() => {
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cursor-img-'));
  fs.mkdirSync(path.join(mocks.home, '.cursor', 'projects'), { recursive: true });
  // The composer store this file builds lives under ~/.config/Cursor; on Linux the IDE resolves
  // $XDG_CONFIG_HOME/Cursor first, so pin the variable to that same directory.
  vi.stubEnv('XDG_CONFIG_HOME', path.join(mocks.home, '.config'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('migrating user images to Cursor', () => {
  it('writes a placeholder for each user image in the transcript', async () => {
    const adapter = getAdapter('cursor');
    const cwd = path.join(mocks.home, 'work');
    const id = await adapter.writeSession(sessionWithUserImages(), cwd);

    const back = await adapter.readSession({ sessionId: id, projectPath: cwd });
    expect(textOf(back)).toEqual([
      `what is wrong in this screenshot | ${PLACEHOLDER}`,
      'the margin',
      PLACEHOLDER,
      'fixed now',
    ]);
  });

  it('reports each user image as degraded to a placeholder', () => {
    const report = fidelityFromSession(sessionWithUserImages(), 'cursor');
    expect(report.degradedBlocks).toBe(2);
    expect(report.lostBlocks).toBe(0);
    expect(report.degradations).toContain('image_blocks_degraded_to_placeholder (2)');
  });

  // Cursor shows the conversation from the bubbles in state.vscdb, not from the
  // transcript, so the placeholder has to land there too.
  it.skipIf(process.platform === 'win32')('writes a placeholder for each user image in the composer bubbles', async () => {
    const cwd = path.join(mocks.home, 'work');
    const db = createCursorStore(cwd);

    await getAdapter('cursor').writeSession(sessionWithUserImages(), cwd);

    const bubbles = readBubbles(db);
    expect(bubbles.filter((b) => b.type === 1).map((b) => b.text)).toEqual([
      `what is wrong in this screenshot\n\n${PLACEHOLDER}`,
      PLACEHOLDER,
    ]);
  });
});

// Cursor has no reasoning blocks. The adapter keeps reasoning in the transcript as `<thinking>`
// text, whatever wrote the session, and leaves it out of the bubbles Cursor renders.
describe('writing reasoning to Cursor', () => {
  const REASONING = 'weighing the margin against the padding';
  const withReasoning: Session = {
    ...sessionWithUserImages(),
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text: 'why is it off' }] },
      {
        role: 'assistant',
        timestamp: '2026-09-24T10:00:01.000Z',
        content: [
          { type: 'thinking', text: REASONING },
          { type: 'text', text: 'the margin' },
        ],
      },
    ],
  };

  it.skipIf(process.platform === 'win32')('keeps a raw reasoning block as <thinking> text in the transcript, not in the bubbles', async () => {
    const cwd = path.join(mocks.home, 'work');
    const db = createCursorStore(cwd);
    const adapter = getAdapter('cursor');

    const id = await adapter.writeSession(withReasoning, cwd);

    const back = await adapter.readSession({ sessionId: id, projectPath: cwd });
    expect(textOf(back)).toEqual(['why is it off', `<thinking>\n${REASONING}\n</thinking> | the margin`]);
    const bubbles = readBubbles(db);
    expect(bubbles.map((b) => b.text)).toEqual(['why is it off', 'the margin']);
    expect(bubbles.some((b) => JSON.stringify(b).includes(REASONING))).toBe(false);
  });
});
