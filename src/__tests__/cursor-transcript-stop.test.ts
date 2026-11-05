import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHookEvent, rebuildSessions, scanTranscriptStop } from '../dashboard-collector.js';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cursor-stop-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(records: object[]): string {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

const aborts = [
  { type: 'turn_ended', status: 'error', error: 'User aborted request' },
  { type: 'turn_ended', status: 'error', error: 'user_stopped_generation' },
  { type: 'turn_ended', status: 'aborted', error: 'User aborted/interrupted manually.' },
];

describe('Cursor Stop transcript snapshots', () => {
  it.each(aborts)('counts a user abort: $status / $error', async record => {
    expect(await scanTranscriptStop(transcript([record]))).toEqual({
      interrupt: 1, toolReject: 0, toolError: 0, prompts: 0,
    });
  });

  it('counts an aborted turn without an error message', async () => {
    expect((await scanTranscriptStop(transcript([{ type: 'turn_ended', status: 'aborted' }]))).interrupt).toBe(1);
  });

  it.each([
    { type: 'turn_ended', status: 'success' },
    { type: 'turn_ended', status: 'error', error: '[resource_exhausted] Error' },
    { type: 'turn_ended', status: 'error', error: 'quota exhausted' },
    { type: 'turn_ended', status: 'error', error: 'model unavailable' },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'User aborted request' }] } },
    { type: 'turn_ended', status: { aborted: true }, error: ['User aborted request'] },
  ])('does not count ordinary errors, success or message text: %j', async record => {
    expect(await scanTranscriptStop(transcript([record]))).toEqual({
      interrupt: 0, toolReject: 0, toolError: 0, prompts: 0,
    });
  });

  it('counts role-based human prompts, excluding tool results and injected messages', async () => {
    const file = transcript([
      { role: 'user', message: { content: [{ type: 'text', text: 'Fix the parser' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } },
      { role: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { role: 'user', isMeta: true, message: { content: 'injected' } },
      { role: 'user', isSidechain: true, message: { content: 'sidechain' } },
      { role: 'user', message: { content: '<task-notification>done</task-notification>' } },
      { role: 'user', message: { content: 'Continue' } },
      ...aborts,
    ]);
    expect(await scanTranscriptStop(file)).toEqual({ interrupt: 3, toolReject: 0, toolError: 0, prompts: 2 });
  });

  it('keeps the snapshot idempotent through repeated Cursor Stop hooks and a later turn', async () => {
    const file = transcript([
      { role: 'user', message: { content: [{ type: 'text', text: 'Fix the parser' }] } },
      ...aborts,
    ]);
    fs.appendFileSync(file, 'not JSON\n{"type":"turn_ended",\n');
    const input = JSON.stringify({ hook_event_name: 'stop', conversation_id: 'cursor-session', transcript_path: file });
    const first = await parseHookEvent(input, 'cursor', { readUsage: false });
    const repeated = await parseHookEvent(input, 'cursor', { readUsage: false });
    expect(first?.interventions).toEqual({ interrupt: 3, toolReject: 0, toolError: 0 });
    expect(first?.prompts).toBe(1);
    expect(repeated?.interventions).toEqual(first?.interventions);
    if (!first || !repeated) throw new Error('Expected Cursor Stop events');
    expect(rebuildSessions([first, repeated])[0]?.interventions.interrupt).toBe(3);

    fs.appendFileSync(file, JSON.stringify(aborts[0]) + '\n');
    const later = await parseHookEvent(input, 'cursor', { readUsage: false });
    if (!later) throw new Error('Expected the later Cursor Stop event');
    expect(later.interventions?.interrupt).toBe(4);
    expect(rebuildSessions([first, repeated, later])[0]?.interventions.interrupt).toBe(4);
  });
});
