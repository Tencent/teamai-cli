import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeOpencode } from '@teamai/tool-opencode/testing';
import { opencodeMajorVersion } from '../opencode-version.js';

const made: string[] = [];

/** A fake `opencode` in a directory of its own that prints `version`, and its path: the probe caches by binary. */
function opencodePrinting(version: string): string {
  const dir = installFakeOpencode({ version });
  made.push(dir);

  return path.join(dir, 'opencode');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('opencodeMajorVersion', () => {
  it('reads the major version OpenCode V1 and V2 print', async () => {
    expect(await opencodeMajorVersion(opencodePrinting('1.18.35'))).toBe(1);
    expect(await opencodeMajorVersion(opencodePrinting('opencode v2.0.24'))).toBe(2);
  });

  it('takes OpenCode as V2 when the binary prints no version', async () => {
    expect(await opencodeMajorVersion(opencodePrinting(''))).toBe(2);
  });

  it("leaves nothing in the member's home, though OpenCode makes its data, cache and state folders on every start", async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-opencode-start-')));
    made.push(dir);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    for (const name of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(name, undefined);
    const opencode = path.join(dir, 'opencode');
    fs.writeFileSync(opencode, `#!${process.execPath}
const fs=require('fs'); const path=require('path');
for (const [name, fallback] of [['XDG_DATA_HOME', '.local/share'], ['XDG_CACHE_HOME', '.cache'], ['XDG_STATE_HOME', '.local/state']]) fs.mkdirSync(path.join(process.env[name] || path.join(process.env.HOME, fallback), 'opencode'), { recursive: true });
console.log('opencode v2.0.24');\n`, { mode: 0o755 });

    expect(await opencodeMajorVersion(opencode)).toBe(2);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('takes OpenCode as V2 when there is no binary to ask', async () => {
    expect(await opencodeMajorVersion(path.join(os.tmpdir(), 'teamai-no-such-dir', 'opencode'))).toBe(2);
  });
});
