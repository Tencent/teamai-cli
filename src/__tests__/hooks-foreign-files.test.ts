import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getHookStatus, hasTeamaiHooks, reconcileHooks } from '../hooks.js';

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

describe('hasTeamaiHooks on a hook file the member edited', () => {
  it.each([
    ['claude', { hooks: { SessionStart: {}, Stop: [null, 1] } }],
    ['cursor', { version: 1, hooks: { sessionStart: {}, stop: [null, 1] } }],
    ['copilot', { version: 1, hooks: { SessionStart: {}, Stop: [null, 1] } }],
    ['codex', { hooks: { SessionStart: {}, Stop: [null, 1] } }],
    ['zcode', { hooks: { events: { SessionStart: {}, Stop: [null, 1] } } }],
  ])('reads malformed %s events and entries as no teamai hook', async (tool, json) => {
    await expect(hasTeamaiHooks(write('hooks.json', json), tool)).resolves.toBe(false);
  });
});

describe('reconcileHooks on a hook file the member edited', () => {
  it.each([
    ['claude', { hooks: { SessionStart: {} } }, 'hooks.SessionStart is not a list'],
    ['claude', { hooks: { SessionStart: 'x' } }, 'hooks.SessionStart is not a list'],
    ['claude', { hooks: 'x' }, 'hooks is not an object'],
    ['cursor', { version: 1, hooks: { sessionStart: {} } }, 'hooks.sessionStart is not a list'],
    ['copilot', { version: 1, hooks: { SessionStart: 'x' } }, 'hooks.SessionStart is not a list'],
    ['codex', { hooks: { SessionStart: {} } }, 'hooks.SessionStart is not a list'],
    ['zcode', { hooks: { events: { SessionStart: {} } } }, 'hooks.events.SessionStart is not a list'],
    ['zcode', { hooks: { events: [] } }, 'hooks.events is not an object'],
  ])('leaves a %s file whose events are not lists as it is and names the key', async (tool, json, problem) => {
    const file = write('hooks.json', json);
    const before = fs.readFileSync(file, 'utf8');

    await expect(reconcileHooks(file, tool, [])).rejects.toThrow(
      `${file}: ${problem}, so teamai left the file as it is. Fix it, then run the command again.`,
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
