/**
 * qoder-adapter.test.ts — Qoder and Qoder CN write Claude Code transcript
 * JSONL into their own stores (<QODER_CONFIG_DIR or QODER_CLI_HOME/.qoder or
 * ~/.qoder>/projects, and the QODERCN_ equivalents), so both platforms read
 * through ClaudeCodeAdapter on their store (#1571). The store resolution is
 * covered in locate-sessions.test.ts; this file pins the adapter behaviour:
 * transcript discovery, subagent reading, and the env-moved root reaching the
 * adapter (#1418).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { AgentSession } from '../session-flow/agent-session.js';

const SID = 'c0ffee00-0000-4000-8000-00000000d0de';
const SUB = 'agent-01020304-0000-4000-8000-000000000099';

/** Write the transcript Claude Code-shaped tools keep, plus one subagent. */
function writeTranscript(storeRoot: string, cwd: string, sessionId = SID): void {
  const base = { isSidechain: false, cwd, sessionId, version: '1.1.78', userType: 'external', timestamp: '2026-11-01T10:00:00.000Z' };
  const records = [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'review the payments flow' }] } },
    {
      ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q1', name: 'Task', input: { prompt: 'check the ledger' } }] },
    },
  ];
  const dir = path.join(storeRoot, 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Qoder writes Claude Code-style subagents under <id>/subagents/, with the
  // records marked isSidechain as Claude Code marks them.
  const subDir = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subBase = { ...base, sessionId: SUB, isSidechain: true };
  fs.writeFileSync(path.join(subDir, `${SUB}.jsonl`), [
    JSON.stringify({ ...subBase, type: 'user', uuid: 'su1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'check the ledger' }] } }),
    JSON.stringify({ ...subBase, type: 'assistant', uuid: 'sa1', parentUuid: 'su1', message: { role: 'assistant', content: [{ type: 'text', text: 'ledger is consistent' }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, `${SUB}.meta.json`), JSON.stringify({ toolUseId: 'toolu_q1', spawnDepth: 1, finished: true }));
}

function workspace(): string {
  const work = path.join(mocks.home, 'work');
  fs.mkdirSync(work, { recursive: true });
  return fs.realpathSync.native(work);
}

beforeEach(() => {
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-qoder-')));
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
  vi.stubEnv('QODER_CONFIG_DIR', '');
  vi.stubEnv('QODER_CLI_HOME', '');
  vi.stubEnv('QODERCN_CONFIG_DIR', '');
  vi.stubEnv('QODERCN_CLI_HOME', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('qoder session platforms (#1418)', () => {
  it('credits qoder and qoder-cn sessions to their tools', () => {
    expect(AgentSession.platformForTool('qoder')).toBe('qoder');
    expect(AgentSession.platformForTool('qoder-cn')).toBe('qoder-cn');
    expect(AgentSession.toolForPlatform('qoder')).toBe('qoder');
    expect(AgentSession.toolForPlatform('qoder-cn')).toBe('qoder-cn');
  });

  it('reads a Qoder transcript from ~/.qoder/projects and its subagents', async () => {
    const cwd = workspace();
    writeTranscript(path.join(mocks.home, '.qoder'), cwd);

    const adapter = getAdapter('qoder');
    expect(adapter.isReady()).toBe(true);
    const listed = await adapter.listConversations(cwd);
    expect(listed.map((m) => m.sessionId)).toEqual([SID]);

    const ref = listed[0];
    if (!ref?.filePath) throw new Error('expected a transcript file path');
    expect(ref.filePath).toBe(path.join(mocks.home, '.qoder', 'projects', encodeCwdClaude(cwd), `${SID}.jsonl`));

    const session = await adapter.readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const subagents = await adapter.readSubagents(session, { sessionId: SID, projectPath: cwd, filePath: ref.filePath });
    expect(subagents.status).toBe('read');
    if (subagents.status !== 'read') throw new Error('unread');
    expect(subagents.agents).toHaveLength(1);
    expect(subagents.agents[0].session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(subagents.agents[0].finished).toBe(true);
  });

  it('reads a Qoder CN transcript from ~/.qoder-cn/projects', async () => {
    const cwd = workspace();
    writeTranscript(path.join(mocks.home, '.qoder-cn'), cwd);

    const adapter = getAdapter('qoder-cn');
    expect(adapter.isReady()).toBe(true);
    const session = await adapter.readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('reads from QODER_CONFIG_DIR when the install is relocated', async () => {
    const cwd = workspace();
    const moved = path.join(mocks.home, 'qoder-config');
    writeTranscript(moved, cwd);
    vi.stubEnv('QODER_CONFIG_DIR', moved);

    const adapter = getAdapter('qoder');
    expect(adapter.isReady()).toBe(true);
    const session = await adapter.readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('reads from QODER_CLI_HOME/.qoder: the variable names the parent', async () => {
    const cwd = workspace();
    const parent = path.join(mocks.home, 'qoder-cli-home');
    writeTranscript(path.join(parent, '.qoder'), cwd);
    vi.stubEnv('QODER_CLI_HOME', parent);

    const adapter = getAdapter('qoder');
    expect(adapter.isReady()).toBe(true);
    const session = await adapter.readSession({ sessionId: SID, projectPath: cwd });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
