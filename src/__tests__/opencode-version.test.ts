import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('takes OpenCode as V2 when there is no binary to ask', async () => {
    expect(await opencodeMajorVersion(path.join(os.tmpdir(), 'teamai-no-such-dir', 'opencode'))).toBe(2);
  });
});
