import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import { AgentSession } from '../session-flow/agent-session.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import type { Session } from '../session-flow/ir.js';
import { installFakeOpencode, opencodeExportFixture, plantOpencodeSession } from './helpers/fake-opencode.js';

const SECRET = 'sk-ABCDEFGH1234567890abcdefghij';
const FAKE_OPENCODE_BIN = installFakeOpencode();

const jsonl = (records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

function workspace(): string {
  const dir = path.join(mocks.home, 'work', 'ws');
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

const texts = (session: Session): string[] =>
  session.messages.flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])));

beforeEach(() => {
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-subagents-')));
  for (const dir of [['.claude', 'projects'], ['.codex', 'sessions'], ['.codebuddy', 'projects'], ['.local', 'share']]) {
    fs.mkdirSync(path.join(mocks.home, ...dir), { recursive: true });
  }
  vi.stubEnv('PATH', `${FAKE_OPENCODE_BIN}${path.delimiter}${path.dirname(process.execPath)}`);
  vi.stubEnv('XDG_DATA_HOME', path.join(mocks.home, '.local', 'share'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(mocks.home, { recursive: true, force: true });
});

const user = (uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid, parentUuid, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content }, ...extra,
});
const assistant = (uuid: string, parentUuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, parentUuid, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'assistant', model: 'claude-x', content }, ...extra,
});

function plantClaude(cwd: string): string {
  const sessionId = '6f1c2d3e-0000-4000-8000-000000000001';
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  const agents = path.join(project, sessionId, 'subagents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), jsonl([
    user('u1', null, 'Review the change.', { cwd }),
    assistant('u2', 'u1', [
      { type: 'tool_use', id: 'toolu_first', name: 'Agent', input: { prompt: 'look at a' } },
      { type: 'tool_use', id: 'toolu_second', name: 'Agent', input: { prompt: 'look at b' } },
    ], { cwd }),
  ]));
  const agent = (name: string, meta: Record<string, unknown>, records: unknown[], tail = ''): void => {
    fs.writeFileSync(path.join(agents, `agent-${name}.meta.json`), JSON.stringify(meta));
    fs.writeFileSync(path.join(agents, `agent-${name}.jsonl`), jsonl(records) + tail);
  };
  agent('b', { toolUseId: 'toolu_second', spawnDepth: 1 }, [
    user('b1', null, 'look at b', { isSidechain: true }),
    assistant('b2', 'b1', [{ type: 'text', text: `b found ${SECRET}` }], { isSidechain: true }),
  ], '{"type":"assistant","uuid":"b3","parentUu');
  agent('a', { toolUseId: 'toolu_first', spawnDepth: 1, finished: true }, [
    user('a1', null, 'look at a', { isSidechain: true }),
    assistant('a2', 'a1', [{ type: 'tool_use', id: 'toolu_nested', name: 'Agent', input: { prompt: 'deeper' } }], { isSidechain: true }),
    assistant('a3', 'a2', [{ type: 'text', text: 'a is fine' }], { isSidechain: true }),
  ]);
  agent('c', { toolUseId: 'toolu_nested', spawnDepth: 2, finished: true }, [
    user('c1', null, 'deeper', { isSidechain: true }),
    assistant('c2', 'c1', [{ type: 'text', text: 'c is fine' }], { isSidechain: true }),
  ]);
  return sessionId;
}

const codexMeta = (id: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  timestamp: '2026-10-20T10:00:00.000Z', ordinal: 0, type: 'session_meta',
  payload: { id, session_id: id, timestamp: '2026-10-20T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.163.0', ...extra },
});
const codexMessage = (ordinal: number, role: string, text: string) => ({
  timestamp: '2026-10-20T10:00:02.000Z', ordinal, type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] },
});

describe('AgentSession.find with subagents', () => {
  it('reads no subagent unless asked, so copies and archives stay as they were', async () => {
    const cwd = workspace();
    const sessionId = plantClaude(cwd);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd });

    expect(found.status).toBe('done');
    expect(found).not.toHaveProperty('subagents');
  });

  it('Claude: reads each agent in the order the session started it, nested ones under their parent, redacted', async () => {
    const cwd = workspace();
    const sessionId = plantClaude(cwd);

    const found = await AgentSession.find({ platform: 'claude-code', sessionId, cwd }, { subagents: true });

    if (found.status !== 'done' || found.subagents?.status !== 'read') throw new Error(`not read: ${JSON.stringify(found)}`);
    expect(found.subagents.agents.map((agent) => ({ depth: agent.depth, finished: agent.finished, text: texts(agent.session) }))).toEqual([
      { depth: 1, finished: true, text: ['look at a', 'a is fine'] },
      { depth: 2, finished: true, text: ['deeper', 'c is fine'] },
      { depth: 1, finished: false, text: ['look at b', expect.not.stringContaining(SECRET)] },
    ]);
    expect(texts(found.session)).toEqual(['Review the change.']);
  });

  it('Codex: reads child rollouts of the session from where their own work starts, and says when a rollout does not record it', async () => {
    const cwd = workspace();
    const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    const parent = '019a0000-0000-7000-8000-00000000000a';
    const child = '019a0000-0000-7000-8000-00000000000b';
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-00-${parent}.jsonl`), jsonl([
      codexMeta(parent, cwd), codexMessage(1, 'user', 'Review the change.'), codexMessage(2, 'assistant', 'Spawning a helper.'),
    ]));
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-05-${child}.jsonl`), jsonl([
      codexMeta(child, cwd, { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }, subagent_history_start_ordinal: 3 }),
      codexMessage(1, 'user', 'Review the change.'),
      codexMessage(2, 'developer', 'You are a spawned agent.'),
      codexMessage(3, 'user', 'Check the tests.'),
      codexMessage(4, 'assistant', 'The tests pass.'),
      { ...codexMessage(5, 'assistant', 'A line without its ordinal.'), ordinal: undefined },
      { timestamp: '2026-10-20T10:00:03.000Z', ordinal: 6, type: 'event_msg', payload: { type: 'task_complete' } },
    ]));
    const legacy = '019a0000-0000-7000-8000-00000000000e';
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-09-${legacy}.jsonl`), jsonl([
      { ...codexMeta(legacy, cwd, { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } }), timestamp: '2026-10-20T10:00:09.000Z',
        payload: { ...codexMeta(legacy, cwd).payload, timestamp: '2026-10-20T10:00:09.000Z', source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } } },
      codexMessage(1, 'user', 'Review the change.'),
      codexMessage(2, 'assistant', 'Legacy child work.'),
    ]));
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-01-00-019a0000-0000-7000-8000-00000000000c.jsonl`), jsonl([
      codexMeta('019a0000-0000-7000-8000-00000000000c', cwd, { source: { subagent: { thread_spawn: { parent_thread_id: 'someone-else', depth: 1 } } } }),
      codexMessage(1, 'user', 'Unrelated.'),
    ]));

    const old = '019a0000-0000-7000-8000-00000000000d';
    fs.writeFileSync(path.join(day, `rollout-2026-10-19T12-00-00-${old}.jsonl`), jsonl([
      { ...codexMeta(old, cwd, { source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, subagent_history_start_ordinal: 1 }),
        payload: { ...codexMeta(old, cwd).payload, timestamp: '2026-10-19T10:00:00.000Z', source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, subagent_history_start_ordinal: 1 } },
      codexMessage(1, 'assistant', 'old unrelated work'),
    ]));
    const found = await AgentSession.find({ platform: 'codex', sessionId: parent, cwd }, { subagents: true });

    if (found.status !== 'done' || found.subagents?.status !== 'read') throw new Error(`not read: ${JSON.stringify(found)}`);
    expect(found.subagents.agents.map((agent) => ({ id: agent.session.sessionId, depth: agent.depth, finished: agent.finished, start: agent.start, text: texts(agent.session) }))).toEqual([
      { id: child, depth: 1, finished: true, start: 'recorded', text: ['Check the tests.', 'The tests pass.'] },
      { id: legacy, depth: 1, finished: false, start: 'unknown', text: ['Review the change.', 'Legacy child work.'] },
    ]);
  });

  it('OpenCode: asks a server of its own for the children of the session', async () => {
    const cwd = workspace();
    const parent = opencodeExportFixture();
    plantOpencodeSession(process.env.XDG_DATA_HOME ?? '', { ...parent, info: { ...parent.info, id: 'ses_parent', location: { directory: cwd } } });
    plantOpencodeSession(process.env.XDG_DATA_HOME ?? '', { ...parent, info: { ...parent.info, id: 'ses_child', parentID: 'ses_parent', location: { directory: cwd } } });

    const found = await AgentSession.find({ platform: 'opencode', sessionId: 'ses_parent', cwd }, { subagents: true });

    if (found.status !== 'done' || found.subagents?.status !== 'read') throw new Error(`not read: ${JSON.stringify(found)}`);
    expect(found.subagents.agents.map((agent) => [agent.session.sessionId, agent.depth])).toEqual([['ses_child', 1]]);
  });

  it('CodeBuddy: reads the agents beside the session, as Claude lays them out', async () => {
    const cwd = workspace();
    const adapter = getAdapter('codebuddy');
    const base: Session = {
      sessionId: 'x', title: 't', cwd, platform: 'codebuddy', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:01.000Z',
      messages: [{ role: 'user', timestamp: '2026-10-20T10:00:00.000Z', content: [{ type: 'text', text: 'main' }] }], metadata: {},
    };
    const sessionId = await adapter.writeSession(base, cwd);
    const helper = await adapter.writeSession({ ...base, sessionId: 'y', createdAt: '2026-10-20T10:00:02.000Z', messages: [{ role: 'user', content: [{ type: 'text', text: 'helper' }] }] }, cwd);
    const [listed] = (await adapter.listConversations(cwd)).filter((meta) => meta.sessionId === helper);
    if (!listed?.filePath) throw new Error('helper not listed');
    const agents = path.join(path.dirname(listed.filePath), sessionId, 'subagents');
    fs.mkdirSync(agents, { recursive: true });
    fs.renameSync(listed.filePath, path.join(agents, 'agent-1.jsonl'));

    const found = await AgentSession.find({ platform: 'codebuddy', sessionId, cwd }, { subagents: true });

    if (found.status !== 'done' || found.subagents?.status !== 'read') throw new Error(`not read: ${JSON.stringify(found)}`);
    expect(found.subagents.agents.map((agent) => [agent.depth, texts(agent.session)])).toEqual([[1, ['helper']]]);
  });
});
