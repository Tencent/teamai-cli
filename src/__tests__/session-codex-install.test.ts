/**
 * Codex counts as installed before its first session: `~/.codex/sessions/` only
 * appears once Codex has run a session, so a member who installed Codex but
 * never used it must still be a valid migrate target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as unknown as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { getAdapter, listInstalledPlatforms } from '../session-flow/adapters/index.js';
import { MigrationEngine } from '../session-flow/migrate.js';
import type { Session } from '../session-flow/ir.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

let tmp = '';
let emptyBin = '';
const savedPath = process.env.PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
  mocks.home = path.join(tmp, 'home');
  fs.mkdirSync(mocks.home);
  emptyBin = path.join(tmp, 'empty-bin');
  fs.mkdirSync(emptyBin);
  process.env.PATH = emptyBin;
});

afterEach(() => {
  process.env.PATH = savedPath;
  mocks.home = '';
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Plants a Claude Code session for `cwd` and returns its id. */
async function plantClaudeSession(cwd: string): Promise<string> {
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  const session: Session = {
    sessionId: SESSION_ID,
    title: 'hello codex',
    cwd,
    platform: 'claude-code',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:01:00.000Z',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello codex' }], timestamp: '2026-09-20T10:00:00.000Z' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: '2026-09-20T10:00:30.000Z' },
    ],
    metadata: {},
  };
  return getAdapter('claude-code').writeSession(session, cwd);
}

describe('Codex installed without a sessions directory', () => {
  it('migrates into Codex when only ~/.codex exists, creating the dated sessions dir', async () => {
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const sourceId = await plantClaudeSession(cwd);
    fs.mkdirSync(path.join(mocks.home, '.codex'));

    const result = await new MigrationEngine('claude-code', 'codex').migrate(sourceId, cwd);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    const dayDir = path.join(mocks.home, '.codex', 'sessions', '2026', '09', '20');
    const rollouts = fs.readdirSync(dayDir).filter((f) => f.endsWith('.jsonl'));
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0]).toContain(result.targetSessionId);
  });

  it('lists Codex as installed when the codex CLI is on PATH and ~/.codex does not exist yet', () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const exe = path.join(bin, 'codex');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    process.env.PATH = bin;

    expect(listInstalledPlatforms()).toContain('codex');
  });

  it('does not list Codex when neither ~/.codex nor the codex CLI is present', () => {
    expect(listInstalledPlatforms()).not.toContain('codex');
  });

  it('lists no Codex sessions, without failing, when ~/.codex has no sessions dir', async () => {
    fs.mkdirSync(path.join(mocks.home, '.codex'));

    await expect(getAdapter('codex').listConversations()).resolves.toEqual([]);
  });
});
