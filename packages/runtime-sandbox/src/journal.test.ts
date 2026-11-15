import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journal } from './journal.js';

describe.skipIf(process.platform === 'win32')('the sandbox journal', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sandbox-journal-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses a place record replaced with a FIFO, naming the file, without waiting for a writer', () => {
    const record = path.join(root, 'places', 'h-1.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    execFileSync('mkfifo', [record]);

    expect(() => journal(root).place('h-1')).toThrow(`Its record ${record} cannot be read`);
  });
});
