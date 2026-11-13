import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sessionSince } from './sessions.js';

describe('the session a step thread kept', () => {
  it('is the first one started in the folder since the launch, not a delegated task\'s later one', async () => {
    const toolHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-t3-sessions-')));
    const cwd = path.join(toolHome, 'worktree');
    const dir = path.join(toolHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const write = (sessionId: string, at: string): void => fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId, cwd, timestamp: at, uuid: `${sessionId}-u`, message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', sessionId, cwd, timestamp: at, uuid: `${sessionId}-a`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n') + '\n');
    const launchedAt = Date.parse('2026-11-06T10:00:00.000Z');
    write('5ab0c71a-0000-4000-8000-000000000001', '2026-11-06T10:00:01.000Z');
    write('dd5bedbf-0000-4000-8000-000000000002', '2026-11-06T10:00:30.000Z');

    try {
      expect(await sessionSince({ driver: 'claudeAgent', toolHome, cwd, since: launchedAt })).toMatchObject({ kind: 'found', session: { id: '5ab0c71a-0000-4000-8000-000000000001' } });
    } finally {
      fs.rmSync(toolHome, { recursive: true, force: true });
    }
  });

  it.each([
    {
      cause: 'a file system error that is not about permission', error: (folder: string) => Object.assign(new Error(`EMFILE: too many open files, scandir '${folder}'`), { code: 'EMFILE', path: folder }),
      why: (folder: string) => `reading ${folder} failed (EMFILE: too many open files, scandir '${folder}')`,
    },
    { cause: 'an error that is not the file system\'s', error: () => new TypeError('listing broke'), why: () => 'listing broke' },
  ])('is a failed lookup, with its message, not a folder teamai has no permission to read, when listing the store hits $cause', async ({ error, why }) => {
    const toolHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-t3-sessions-')));
    const folder = path.join(toolHome, 'sessions', '2026');
    fs.mkdirSync(folder, { recursive: true });
    // The store lists through node:fs's named exports, which follow the default object only once synced. Other folders list
    // through opendir, which the spy leaves alone.
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, _options: { withFileTypes: true }) => {
      if (dir.toString() === folder) throw error(folder);
      const listing = fs.opendirSync(dir.toString());
      const entries: fs.Dirent[] = [];

      for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) entries.push(entry);
      listing.closeSync();

      return entries;
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();

    try {
      expect(await sessionSince({ driver: 'codex', toolHome, cwd: path.join(toolHome, 'worktree'), since: Date.now() })).toEqual({ kind: 'failed', why: why(folder) });
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      fs.rmSync(toolHome, { recursive: true, force: true });
    }
  });
});
