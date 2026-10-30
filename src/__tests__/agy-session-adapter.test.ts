/**
 * agy-session-adapter.test.ts — reading Antigravity CLI (agy) conversations as sessions.
 *
 * The transcripts under fixtures/agy are copies of real agy 1.4.8 conversations; the summaries
 * database is rebuilt here with agy's own table and the rows agy wrote for them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgyAdapter } from '../session-flow/adapters/agy.js';

const HAS_SQLITE3 = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'agy');

const SKILL = '06073d60-63d2-43f8-a8c2-062189a4ddd2';
const DENIED = 'a593d699-b9a1-4e7e-850c-d1334878c06a';
const NOTE = 'a72e9137-39dc-4042-80a7-d113527c4b72';

// agy 1.4.8's own table, as `.schema conversation_summaries` prints it.
const SCHEMA = 'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob, group_id TEXT NOT NULL DEFAULT \'\',PRIMARY KEY (`conversation_id`));';

const ROWS = [
  [SKILL, 'Release Notes Skill Code Word', 5, '2026-10-28 23:53:38.208141+00:00', '["file:///tmp/agyprobe/usagereal/work"]', '2026-10-28 23:53:33.16187+00:00'],
  [DENIED, 'Executing Shell Command And System Security Check', 5, '2026-10-28 23:47:37.443309+00:00', '["file:///tmp/agyprobe/hooksreal/work"]', '2026-10-28 23:47:22.101546+00:00'],
  [NOTE, 'Read Note File and Run Shell Command', 6, '2026-10-28 23:36:55.411116+00:00', '["file:///tmp/agyprobe/proj6"]', '2026-10-28 23:36:44.785214+00:00'],
] as const;

let root: string;

function transcriptOf(id: string): string {
  return path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

/** A summaries database in `store` with agy's table and `rows`. */
function writeSummaries(store: string, rows: ReadonlyArray<(typeof ROWS)[number]>): void {
  const inserts = rows.map(([id, title, steps, modified, uris, input]) =>
    `INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, last_user_input_time, app_data_dir) VALUES ('${id}', '${title}', '${title}', ${steps}, '${modified}', '${uris}', 'CASCADE_RUN_STATUS_IDLE', 'default-cli-project', '${input}', '${path.basename(store)}');`);
  const made = spawnSync('sqlite3', [path.join(store, 'conversation_summaries.db')], { input: [SCHEMA, ...inserts].join('\n') });
  expect(made.status).toBe(0);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-agy-'));
  fs.cpSync(path.join(FIXTURES, 'brain'), path.join(root, 'brain'), { recursive: true });
  if (!HAS_SQLITE3) return;
  writeSummaries(root, ROWS);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!HAS_SQLITE3)('agy session listing', () => {
  it('lists each conversation with its title, workspace and times, newest first', async () => {
    const listed = await new AgyAdapter([root]).listConversations();

    expect(listed.map((meta) => meta.sessionId)).toEqual([SKILL, DENIED, NOTE]);
    expect(listed[0]).toEqual({
      sessionId: SKILL,
      title: 'Release Notes Skill Code Word',
      cwd: '/tmp/agyprobe/usagereal/work',
      platform: 'agy',
      createdAt: '2026-10-28T23:53:33.000Z',
      updatedAt: '2026-10-28T23:53:38.208Z',
      filePath: transcriptOf(SKILL),
      sizeBytes: fs.statSync(transcriptOf(SKILL)).size,
    });
  });
});

// The Antigravity app keeps its conversations in ~/.gemini/antigravity, in the same shape as the CLI's.
describe.skipIf(!HAS_SQLITE3)('agy session listing across the CLI and the Antigravity app', () => {
  it("lists and reads the app's conversations beside the CLI's, newest first", async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-antigravity-'));
    try {
      fs.mkdirSync(path.join(app, 'brain'));
      fs.renameSync(path.join(root, 'brain', DENIED), path.join(app, 'brain', DENIED));
      writeSummaries(app, ROWS.filter(([id]) => id === DENIED));

      const adapter = new AgyAdapter([root, app]);
      const listed = await adapter.listConversations();

      expect(listed.map((meta) => meta.sessionId)).toEqual([SKILL, DENIED, NOTE]);
      expect(listed[1]).toMatchObject({ cwd: '/tmp/agyprobe/hooksreal/work', filePath: path.join(app, 'brain', DENIED, '.system_generated', 'logs', 'transcript.jsonl') });
      expect(await adapter.readSession({ sessionId: DENIED })).toMatchObject({ sessionId: DENIED, title: 'Executing Shell Command And System Security Check' });
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_SQLITE3)('agy session listing beside an app store of another shape', () => {
  it("still lists the CLI's conversations when the app's summaries table has other columns", async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-antigravity-'));
    try {
      fs.mkdirSync(path.join(app, 'brain'));
      // As a later app version might keep it: the table renamed its columns.
      expect(spawnSync('sqlite3', [path.join(app, 'conversation_summaries.db'), 'CREATE TABLE conversation_summaries (id TEXT, name TEXT);']).status).toBe(0);

      const listed = await new AgyAdapter([root, app]).listConversations();

      expect(listed.map((meta) => meta.sessionId)).toEqual([SKILL, DENIED, NOTE]);
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_SQLITE3)('agy session listing from a store agy closed', () => {
  it('reads the summaries agy left in WAL mode, without a -shm file, and writes nothing beside them', async () => {
    const db = path.join(root, 'conversation_summaries.db');
    expect(spawnSync('sqlite3', [db, 'PRAGMA journal_mode=WAL;']).status).toBe(0);
    const before = fs.readdirSync(root).sort();

    const listed = await new AgyAdapter([root]).listConversations();

    expect(listed.map((meta) => meta.sessionId)).toEqual([SKILL, DENIED, NOTE]);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });
});

describe.skipIf(!HAS_SQLITE3)('agy session listing with a row agy wrote oddly', () => {
  it('still lists the conversation, without the workspace or start time it cannot read, and the others with it', async () => {
    const db = path.join(root, 'conversation_summaries.db');
    const odd = spawnSync('sqlite3', [db, `UPDATE conversation_summaries SET workspace_uris = 'not json' WHERE conversation_id = '${DENIED}';`]);
    expect(odd.status).toBe(0);
    fs.writeFileSync(transcriptOf(NOTE), '{"step_index":"0","type":"USER_INPUT","created_at":"yesterday"}\n');

    const listed = await new AgyAdapter([root]).listConversations();

    expect(listed.map((meta) => meta.sessionId)).toEqual([SKILL, DENIED, NOTE]);
    expect(listed[1]).toMatchObject({ sessionId: DENIED, cwd: '', updatedAt: '2026-10-28T23:47:37.443Z' });
    expect(listed[2]).toMatchObject({ sessionId: NOTE, createdAt: '2026-10-28T23:36:55.411Z', updatedAt: '2026-10-28T23:36:55.411Z' });
  });
});

describe.skipIf(!HAS_SQLITE3)('agy session reading', () => {
  it('reads the request, the tool calls with their arguments decoded, the results and the answer', async () => {
    const session = await new AgyAdapter([root]).readSession({ sessionId: SKILL });

    expect(session).toMatchObject({ sessionId: SKILL, title: 'Release Notes Skill Code Word', cwd: '/tmp/agyprobe/usagereal/work', platform: 'agy' });
    const [request, injected, call, result, answer] = session.messages;
    expect(request).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Use the release-notes skill: load it, then tell me its code word.' }] });
    // What a hook injected is context, not something the member typed.
    expect(injected).toMatchObject({ role: 'user', metadata: { isMeta: true } });
    expect(call).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_call', toolName: 'read_file', arguments: { Path: '/tmp/agyprobe/usagereal/work/.agents/skills/release-notes/SKILL.md' } }],
    });
    const callId = call.content[0].type === 'tool_call' ? call.content[0].callId : '';
    expect(result).toMatchObject({ role: 'user', content: [{ type: 'tool_result', callId, isError: false }] });
    expect(answer.role).toBe('assistant');
    expect(answer.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('RELNOTES-6627') })]);
  });

  it('reads a tool call a hook denied as a failed result carrying the reason', async () => {
    const session = await new AgyAdapter([root]).readSession({ sessionId: DENIED });
    const call = session.messages.find((message) => message.content.some((block) => block.type === 'tool_call'));
    expect(call?.content).toContainEqual(expect.objectContaining({ toolName: 'bash', arguments: expect.objectContaining({ CommandLine: 'rm -rf build .' }) }));
    const results = session.messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ isError: true, content: expect.stringContaining('Team policy RMRF-7731') })]);
  });

  it('finds a session by id, and only in its own workspace when one is given', async () => {
    const adapter = new AgyAdapter([root]);
    expect(await adapter.existingSessionId(NOTE)).toBe(NOTE);
    expect(await adapter.existingSessionId(NOTE, '/tmp/agyprobe/proj6')).toBe(NOTE);
    expect(await adapter.existingSessionId(NOTE, '/tmp/agyprobe/hooksreal/work')).toBeUndefined();
    expect(await adapter.existingSessionId('00000000-0000-4000-8000-000000000000')).toBeUndefined();
    await expect(adapter.readSession({ sessionId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/No agy conversation/);
  });
});

describe('agy session writing', () => {
  it('refuses to write or delete a conversation, since agy resumes from a store teamai cannot write', async () => {
    const adapter = new AgyAdapter([root]);
    const session = { sessionId: 's', title: 't', cwd: '/tmp', platform: 'claude-code', createdAt: '', updatedAt: '', messages: [] };
    await expect(adapter.writeSession(session)).rejects.toThrow(/cannot write agy sessions/);
    expect(await adapter.deleteSession(NOTE)).toBe(false);
    expect(fs.existsSync(transcriptOf(NOTE))).toBe(true);
  });
});
