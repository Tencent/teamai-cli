import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getHookStatus } from '../hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-foreign-hooks-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, json: object): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(json));

  return file;
}

describe('getHookStatus on a hook file the member edited', () => {
  it.each([
    ['claude', { hooks: { SessionStart: {} } }],
    ['cursor', { version: 1, hooks: { sessionStart: {} } }],
    ['copilot', { version: 1, hooks: { SessionStart: {} } }],
    ['codex', { hooks: { SessionStart: {} } }],
    ['zcode', { hooks: { events: { SessionStart: {} } } }],
  ])('reads a %s event that is not a list as missing hooks', async (tool, json) => {
    await expect(getHookStatus(write('hooks.json', json), tool)).resolves.toBe('missing');
  });

  it.each([
    ['claude', { hooks: { SessionStart: [null, 1] } }],
    ['cursor', { version: 1, hooks: { sessionStart: [null, 1] } }],
    ['copilot', { version: 1, hooks: { SessionStart: [null, 1] } }],
    ['codex', { hooks: { SessionStart: [null, 1] } }],
    ['zcode', { hooks: { events: { SessionStart: [null, 1] } } }],
  ])('reads a %s entry that is not an object as no hook', async (tool, json) => {
    await expect(getHookStatus(write('hooks.json', json), tool)).resolves.toBe('missing');
  });
});
