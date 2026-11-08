import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutKey } from '../pull.js';

let home: string;

afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('a checkout key does not depend on how its path is spelled (#1743)', () => {
  // A hook may launch teamai with the same HOME spelled with a trailing separator or a `.` segment. One directory
  // has one record in state.json, so both spellings must find it; otherwise a pull writes a second record and the
  // delivery record under the first is lost, which `pull` then reads as the member's own file.
  it('gives one directory one key however its path is spelled', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-checkout-key-'));
    const key = await checkoutKey(home);

    expect(await checkoutKey(`${home}${path.sep}`)).toBe(key);
    expect(await checkoutKey(`${home}${path.sep}.`)).toBe(key);
    expect(await checkoutKey(path.join(home, 'nested', '..'))).toBe(key);
  });
});
