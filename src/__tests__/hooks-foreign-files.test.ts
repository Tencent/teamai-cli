import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyAgentHook, getHookStatus, hasTeamaiHooks, reconcileHooks, removeAgentHook } from '../hooks.js';

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

describe('reconcileHooks on a hook file whose entries the member edited', () => {
  type Written = { hooks: { SessionStart: unknown[]; sessionStart: unknown[]; events: { SessionStart: unknown[] } } };

  const claude = {
    fileOf: (entries: unknown[]) => ({ hooks: { SessionStart: entries } }),
    listOf: (written: Written) => written.hooks.SessionStart,
    entries: [
      null, 1, { matcher: 1, hooks: [{ command: 2 }] }, { hooks: [null] }, { hooks: {} }, { description: 3, hooks: 'x' },
      { description: '[teamai:hook:x] mine', hooks: [{ command: 2 }] },
    ],
  };

  const flat = (version: object, event: 'SessionStart' | 'sessionStart') => ({
    fileOf: (entries: unknown[]) => ({ ...version, hooks: { [event]: entries } }),
    listOf: (written: Written) => written.hooks[event],
    entries: [null, 1, { command: 2, bash: 3, powershell: 4, matcher: 5 }],
  });

  const codex = {
    fileOf: (entries: unknown[]) => ({ hooks: { SessionStart: entries } }),
    listOf: (written: Written) => written.hooks.SessionStart,
    entries: [false, 1, { matcher: 1, hooks: [{ command: 2 }] }, { hooks: [false] }, { hooks: {} }],
  };

  const zcode = {
    fileOf: (entries: unknown[]) => ({ hooks: { events: { SessionStart: entries } } }),
    listOf: (written: Written) => written.hooks.events.SessionStart,
    entries: [null, 1, { hooks: [{ command: 2 }] }, { hooks: [{ args: [3] }] }, { hooks: [null] }],
  };

  it.each([
    ['claude', 'no options', claude, {}],
    ['claude', 'teamOnly', claude, { teamOnly: true }],
    ['claude', 'removeAll', claude, { removeAll: true }],
    ['claude', 'a project root', claude, { teamHookProjectRoot: '/elsewhere', manifestPath: 'managed-hooks.json' }],
    ['cursor', 'no options', flat({ version: 1 }, 'sessionStart'), {}],
    ['copilot', 'no options', flat({ version: 1 }, 'SessionStart'), {}],
    ['copilot', 'teamOnly', flat({ version: 1 }, 'SessionStart'), { teamOnly: true }],
    ['codex', 'no options', codex, {}],
    ['codex', 'teamOnly', codex, { teamOnly: true }],
    ['zcode', 'no options', zcode, {}],
    ['zcode', 'teamOnly', zcode, { teamOnly: true }],
  ])('keeps malformed %s entries in place as the member wrote them, with %s', async (tool, _, format, opts) => {
    const file = write('hooks.json', format.fileOf(format.entries));
    const manifestPath = 'manifestPath' in opts ? path.join(tmpDir, opts.manifestPath) : undefined;

    await reconcileHooks(file, tool, [], { ...opts, manifestPath });

    // SAFETY: each row's file holds the event list its listOf reads, and reconcileHooks keeps every event.
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Written;
    expect(format.listOf(written).slice(0, format.entries.length)).toEqual(format.entries);
  });
});

describe('agent hooks in a hook file whose entries the member edited', () => {
  const agentHook = { slug: 'audit', event: 'SessionStart', command: 'echo audit' };

  it.each([
    ['claude', [null, 1, { description: 3, hooks: 'x' }, { hooks: [{ command: 2 }] }]],
    ['codex', [false, 1, { hooks: {} }, { hooks: [{ command: 2 }] }]],
  ])('installs and removes a %s agent hook beside malformed entries, which stay as written', async (tool, entries) => {
    const file = write('hooks.json', { hooks: { SessionStart: entries } });

    await applyAgentHook(file, tool, agentHook, { kind: 'disabled' });
    // SAFETY: the file holds the SessionStart list written above, and the agent hook writes only to that list.
    const installed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: { SessionStart: unknown[] } };
    expect(installed.hooks.SessionStart).toEqual([...entries, expect.objectContaining({ hooks: [expect.objectContaining({ command: 'echo audit' })] })]);

    await removeAgentHook(file, tool, { slug: agentHook.slug, command: agentHook.command }, { kind: 'disabled' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hooks: { SessionStart: entries } });
  });
});
