/**
 * session-cli-discovery.test.ts — the tool CLIs a session copy runs: codex and sqlite3.
 *
 * Windows cannot run here. What Windows changes is covered through the seams that take a
 * platform; finding `codex.cmd` through PATHEXT is cross-spawn's, and stays unverified.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ hasSqlite3: true }));

vi.mock('@teamai/tool-core/sessions/sqlite', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@teamai/tool-core/sessions/sqlite');
  return {
    ...actual,
    findSqlite3: (...args: Parameters<typeof actual.findSqlite3>) => (mocks.hasSqlite3 ? actual.findSqlite3(...args) : null),
  };
});

import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { findSqlite3 } from '@teamai/tool-core/sessions/sqlite';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { adapterAt, SESSION_HOST } from '../session-flow/adapters/index.js';
import { useToolInstances } from '../tool-registry.js';

let home = '';

const HAS_SQLITE3 = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;

/** The test's own sqlite3, found on the PATH the tests then empty. */
const TEST_PATH = process.env.PATH;

function sqlite(db: string, sql: string): string {
  const run = spawnSync('sqlite3', [db, sql], { encoding: 'utf-8', env: { PATH: TEST_PATH } });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

function mkSession(cwd: string): Session {
  return {
    sessionId: 'source-fixture',
    title: 'cli discovery',
    cwd,
    platform: 'claude-code',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', timestamp: '2026-09-24T10:00:05.000Z', content: [{ type: 'text', text: 'hi' }] },
    ],
    metadata: {},
  };
}

function rollouts(): string[] {
  const dir = path.join(home, '.codex', 'sessions');
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl'));
}

beforeEach(() => {
  mocks.hasSqlite3 = true;
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cli-discovery-')));
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, 'ws'));
  // No codex on PATH: the write must not start a real CLI.
  vi.stubEnv('PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * A `codex` on PATH that logs each call to `$CODEX_HOME/calls.log`. The first
 * `migrate-rollouts` finds the thread unindexed, `app-server` answers `thread/list`, and the
 * retry migrates it: the path a fresh copy takes in a real Codex.
 */
function installFakeCodex(): string {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const script = [
    '#!/bin/sh',
    'echo "$*" >> "$CODEX_HOME/calls.log"',
    'case "$1" in',
    '  --version) echo "codex-cli 0.0.0-test" ;;',
    '  migrate-rollouts)',
    '    if [ -f "$CODEX_HOME/indexed" ]; then status=migrated; else status=missing_sqlite_metadata; fi',
    '    echo "{\\"outcomes\\":[{\\"thread_id\\":\\"$4\\",\\"status\\":\\"$status\\"}]}" ;;',
    '  app-server)',
    '    while read -r line; do',
    '      case "$line" in',
    '        *\'"id":1\'*) echo \'{"jsonrpc":"2.0","id":1,"result":{}}\' ;;',
    '        *\'"id":2\'*) : > "$CODEX_HOME/indexed"; echo \'{"jsonrpc":"2.0","id":2,"result":{}}\' ;;',
    '      esac',
    '    done ;;',
    'esac',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'codex'), `${script}\n`, { mode: 0o755 });
  return bin;
}

describe('Codex CLI', () => {
  it.skipIf(process.platform === 'win32')('indexes a fresh copy with the codex found on PATH', async () => {
    vi.stubEnv('PATH', installFakeCodex());
    const codex = new CodexAdapter('codex', path.join(home, '.codex', 'sessions'), SESSION_HOST);
    const cwd = path.join(home, 'ws');

    const id = await codex.writeSession(mkSession(cwd), cwd);

    const calls = fs.readFileSync(path.join(home, '.codex', 'calls.log'), 'utf-8').split('\n');
    const migrate = `migrate-rollouts --apply --thread ${id} --json`;
    expect(calls.filter((c) => c === migrate)).toHaveLength(2);
    expect(calls).toContain('app-server');
    expect(codex.consumeWriteNotice()).toBeUndefined();
  });
});

describe('Codex CLI of a tool instance', () => {
  afterEach(() => { useToolInstances(new Map()); });

  // The session adapter probes and runs the build at the store's home; a build that reads only its own variable needs that one too.
  it.skipIf(process.platform === 'win32')('starts the instance\'s own build with its own variable at the home of the store it writes', async () => {
    const bin = installFakeCodex();
    fs.writeFileSync(path.join(bin, 'acme-codex'), `#!/bin/sh\necho "$*" >> "$ACME_CODEX_HOME/acme-calls.log"\nexec ${JSON.stringify(path.join(bin, 'codex'))} "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', bin);
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', command: 'acme-codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' },
      source: 'personal', file: path.join(home, 'acme-codex.yaml'), location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    const acmeHome = path.join(home, 'acme-moved');
    fs.mkdirSync(path.join(acmeHome, 'sessions'), { recursive: true });
    const cwd = path.join(home, 'ws');

    const id = await adapterAt({ platform: 'acme-codex', storeDir: path.join(acmeHome, 'sessions') }).writeSession(mkSession(cwd), cwd);

    const calls = fs.readFileSync(path.join(acmeHome, 'acme-calls.log'), 'utf-8').split('\n');
    expect(calls).toContain('--version');
    expect(calls).toContain(`migrate-rollouts --apply --thread ${id} --json`);
    expect(calls).toContain('app-server');
  });
});

describe('Codex rollback', () => {
  it.runIf(HAS_SQLITE3)('removes the thread row Codex lists, then the rollout', async () => {
    const codex = new CodexAdapter('codex', path.join(home, '.codex', 'sessions'), SESSION_HOST);
    const cwd = path.join(home, 'ws');
    const id = await codex.writeSession(mkSession(cwd), cwd);
    const db = path.join(home, '.codex', 'state_5.sqlite');
    sqlite(db, `CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('${id}');`);

    expect(await codex.deleteSession(id, cwd)).toBe(true);

    expect(sqlite(db, 'SELECT count(*) FROM threads;')).toBe('0');
    expect(rollouts()).toHaveLength(0);
  });

  it('reports that it could not unregister the thread when sqlite3 is missing, and keeps the rollout for a retry', async () => {
    const codex = new CodexAdapter('codex', path.join(home, '.codex', 'sessions'), SESSION_HOST);
    const cwd = path.join(home, 'ws');
    const id = await codex.writeSession(mkSession(cwd), cwd);
    // Codex lists threads from this database; the copy may be registered there.
    fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), '');
    mocks.hasSqlite3 = false;

    await expect(codex.deleteSession(id, cwd)).rejects.toThrow(`could not unregister Codex thread ${id}`);
    expect(rollouts()).toHaveLength(1);
  });
});

describe('sqlite3 lookup', () => {
  // Windows runs a program by its extension: a PATH entry holds sqlite3.exe, never sqlite3.
  it('finds sqlite3.exe on a Windows PATH', () => {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'sqlite3.exe'), '', { mode: 0o755 });
    vi.stubEnv('PATH', bin);

    expect(findSqlite3('win32')).toBe(path.join(bin, 'sqlite3.exe'));
  });
});
