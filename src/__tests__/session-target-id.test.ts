/**
 * session-target-id.test.ts — the id a migrated session gets in the target tool.
 *
 * Every adapter derives it from the target platform, the target workspace and
 * the source session id. Stores live under a temporary home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ home: '' }));

// Adapter storage paths come from os.homedir(); replace it so every store is a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown> & { default?: object };
  const patched: Record<string, unknown> = { ...actual, homedir: () => mocks.home };
  patched.default = { ...actual.default, homedir: () => mocks.home };
  return patched;
});

import { getAdapter } from '../session-flow/adapters/index.js';
import { deriveOpencodeMessageIds, deriveTargetSessionId } from '@teamai/tool-core/sessions/ids';
import type { Session } from '@teamai/tool-core/sessions/ir';
import { installFakeOpencode } from '@teamai/tool-opencode/testing';
import { WRITABLE } from './helpers/writable-platforms.js';

/** OpenCode keeps its sessions behind its CLI: a stand-in `opencode`, the only command on PATH. */
const FAKE_OPENCODE_BIN = installFakeOpencode();
/** Platforms whose ids already included the workspace before every id was derived. */
const WORKSPACE_KEYED = ['codebuddy-ide', 'codex', 'cursor', 'workbuddy'] as const;

const UUID_SOURCE = '0b6f3c1e-5a2d-4c8e-9f10-7a1b2c3d4e5f';
const HEX_SOURCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function mkSession(sessionId: string, cwd: string): Session {
  return {
    sessionId,
    title: 'target id',
    cwd,
    platform: 'fixture',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:05.000Z',
    messages: [
      { role: 'user', timestamp: '2026-09-24T10:00:00.000Z', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', timestamp: '2026-09-24T10:00:05.000Z', content: [{ type: 'text', text: 'hi' }] },
    ],
    metadata: {},
  };
}

/** A workspace spelled the way the file system stores it. */
function workspace(name: string): string {
  const dir = path.join(mocks.home, name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function write(platform: string, sessionId: string, cwd: string): Promise<string> {
  return getAdapter(platform).writeSession(mkSession(sessionId, cwd), cwd);
}

/** CodeBuddy IDE stores the id without dashes. */
const bare = (id: string): string => id.replace(/-/g, '');

/**
 * The id the release before this change derived for a workspace-keyed store:
 * sha256 over `teamai:<platform>:<realpathSync(cwd)>:<source id>`, UUIDv7-shaped.
 */
function idBeforeThisChange(platform: string, cwd: string, sourceId: string): string {
  const hex = crypto
    .createHash('sha256')
    .update(`teamai:${platform}:${fs.realpathSync(path.resolve(cwd))}:${sourceId}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8), hex.slice(8, 12), `7${hex.slice(13, 16)}`, `${variant}${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    '-',
  );
}

/** Whether the file system under the temp dir ignores letter case (macOS and Windows defaults). */
const TMP_IGNORES_CASE = fs.existsSync(fs.realpathSync.native(os.tmpdir()).toUpperCase());

beforeEach(() => {
  mocks.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-target-id-')));
  process.env.TEAMAI_CODEBUDDY_IDE_DATA = path.join(mocks.home, 'CodeBuddyExtension', 'Data');
  fs.mkdirSync(path.join(process.env.TEAMAI_CODEBUDDY_IDE_DATA, 'ext-x', 'CodeBuddyIDE', 'ext-x', 'history'), {
    recursive: true,
  });
  // Keep Codex's indexing step from starting a real CLI.
  vi.stubEnv('PATH', FAKE_OPENCODE_BIN);
  vi.stubEnv('XDG_DATA_HOME', path.join(mocks.home, '.local', 'share'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.TEAMAI_CODEBUDDY_IDE_DATA;
  fs.rmSync(mocks.home, { recursive: true, force: true });
  mocks.home = '';
});

describe('target session id', () => {
  it.each(WORKSPACE_KEYED)(
    '%s keeps the id it derived before for a correctly spelled workspace',
    async (platform) => {
      const cwd = workspace('ws');
      expect(bare(await write(platform, HEX_SOURCE, cwd))).toBe(bare(idBeforeThisChange(platform, cwd, HEX_SOURCE)));
    },
  );

  describe.runIf(process.platform === 'darwin')('/tmp and /private/tmp on macOS', () => {
    let name = '';
    beforeEach(() => {
      name = path.basename(fs.mkdtempSync('/private/tmp/teamai-target-id-ws-'));
    });
    afterEach(() => {
      fs.rmSync(path.join('/private/tmp', name), { recursive: true, force: true });
    });

    it.each(WRITABLE)('%s gives /tmp/x and /private/tmp/x one id', async (platform) => {
      const viaLink = await write(platform, UUID_SOURCE, path.join('/tmp', name));
      expect(viaLink).toBe(await write(platform, UUID_SOURCE, path.join('/private/tmp', name)));
    });

    it.each(WORKSPACE_KEYED)('%s keeps the id it derived before for /tmp/x', async (platform) => {
      const typed = path.join('/tmp', name);
      expect(bare(await write(platform, HEX_SOURCE, typed))).toBe(bare(idBeforeThisChange(platform, typed, HEX_SOURCE)));
    });
  });

  it.each(WRITABLE)('%s never reuses a UUID source id', async (platform) => {
    const id = await write(platform, UUID_SOURCE, workspace('ws'));
    expect(bare(id)).not.toBe(bare(UUID_SOURCE));
  });

  it.each(WRITABLE)('%s gives one source two ids in two workspaces', async (platform) => {
    const inA = await write(platform, UUID_SOURCE, workspace('ws-a'));
    const inB = await write(platform, UUID_SOURCE, workspace('ws-b'));
    expect(inA).not.toBe(inB);
  });

  it.each(WRITABLE)('%s gives one id to a workspace reached through a symlink', async (platform) => {
    const real = workspace('ws');
    const link = path.join(mocks.home, 'ws-link');
    fs.symlinkSync(real, link);
    expect(await write(platform, UUID_SOURCE, link)).toBe(await write(platform, UUID_SOURCE, real));
  });

  it.skipIf(!TMP_IGNORES_CASE).each(WRITABLE)('%s gives one id to a workspace spelled in another letter case', async (platform) => {
    const real = workspace('ws');
    const shouted = path.join(path.dirname(real), path.basename(real).toUpperCase());
    expect(await write(platform, UUID_SOURCE, shouted)).toBe(await write(platform, UUID_SOURCE, real));
  });

  const NOT_ABSOLUTE = WRITABLE.flatMap((platform) =>
    ['relative/ws', 'md5:0f1e2d3c', '-Users-me-proj'].map((cwd) => [platform, cwd] as const),
  );
  it.each(NOT_ABSOLUTE)('%s refuses the target workspace "%s" before writing', async (platform, cwd) => {
    const before = listFiles(mocks.home);
    await expect(write(platform, UUID_SOURCE, cwd)).rejects.toThrow(cwd);
    expect(listFiles(mocks.home)).toEqual(before);
  });
});

// Windows cannot run here: these spellings go through the derivation with the platform named.
describe('target session id for a Windows workspace', () => {
  const idFor = (targetCwd: string): string =>
    deriveTargetSessionId({ targetPlatform: 'codex', idFormat: 'uuid', targetCwd, sourceSessionId: UUID_SOURCE }, 'win32');

  it.each([
    ['a lower-case drive letter', 'c:\\work\\repo'],
    ['forward slashes', 'C:/work/repo'],
    ['mixed separators', 'c:/work\\repo'],
    ['a trailing separator', 'C:\\work\\repo\\'],
  ])('gives a workspace spelled with %s the id of C:\\work\\repo', (_spelling, cwd) => {
    expect(idFor(cwd)).toBe(idFor('C:\\work\\repo'));
  });

  it('gives the same folder on two drives two ids', () => {
    expect(idFor('D:\\work\\repo')).not.toBe(idFor('C:\\work\\repo'));
  });

  it.each(['C:work\\repo', 'work\\repo'])('refuses "%s", which is not absolute', (cwd) => {
    expect(() => idFor(cwd)).toThrow(cwd);
  });
});

// OpenCode ids are a prefix, 12 hex of time and 14 base62. OpenCode 2.0.29 itself created the
// session `ses_ec4a5b73fffe…` at 1791997135040 ms and the message `msg_13b5a492d001…` at 1791997135149 ms.
describe('target session id in OpenCode', () => {
  const OPENCODE_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

  it('keeps the time part of an OpenCode source and derives the rest from the target workspace', () => {
    const idIn = (targetCwd: string): string =>
      deriveTargetSessionId({ targetPlatform: 'opencode', idFormat: 'opencode', targetCwd, sourceSessionId: 'ses_ec4a5b73fffeRP6bDXlApNBFvY' });

    expect(idIn('/work/a')).toMatch(OPENCODE_ID);
    expect(idIn('/work/a').slice(0, 16)).toBe('ses_ec4a5b73fffe');
    expect(idIn('/work/a')).not.toBe('ses_ec4a5b73fffeRP6bDXlApNBFvY');
    expect(idIn('/work/a')).toBe(idIn('/work/a'));
    expect(idIn('/work/b')).not.toBe(idIn('/work/a'));
  });

  it('encodes the creation time of another source the way OpenCode encodes a new session', () => {
    const id = deriveTargetSessionId({
      targetPlatform: 'opencode',
      idFormat: 'opencode',
      targetCwd: '/work/a',
      sourceSessionId: UUID_SOURCE,
      sourceCreatedAt: new Date(1791997135040).toISOString(),
    });

    expect(id).toMatch(OPENCODE_ID);
    expect(id.slice(0, 16)).toBe('ses_ec4a5b73fffe');
  });

  it('gives messages ids that encode their time the way OpenCode does and sort in order, even within one millisecond', () => {
    const ids = deriveOpencodeMessageIds('ses_ec4a5b73fffeAAAAAAAAAAAAAA', [1791997135149, 1791997135149, 1791997135150]);

    expect(ids.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id))).toBe(true);
    expect(ids[0].slice(0, 16)).toBe('msg_13b5a492d001');
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    expect(deriveOpencodeMessageIds('ses_ec4a5b73fffeBBBBBBBBBBBBBB', [1791997135149])[0]).not.toBe(ids[0]);
  });
});

function listFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}
