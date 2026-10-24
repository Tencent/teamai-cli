import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonl, readJsonlHead } from '../session-flow/fs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function file(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-jsonl-'));
  dirs.push(dir);
  const target = path.join(dir, 'session.jsonl');
  fs.writeFileSync(target, text);
  return target;
}

describe('session JSONL', () => {
  it('reads a file whose last line a running tool is still writing', () => {
    expect([...readJsonl(file('{"n":1}\n{"n":2}\n{"n":'))]).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('still refuses a broken line before the last one', () => {
    expect(() => [...readJsonl(file('{"n":1}\n{"n":\n{"n":3}\n'))]).toThrow(SyntaxError);
  });

  it('reads the first lines of a file larger than one read', () => {
    const lines = Array.from({ length: 3000 }, (_, n) => JSON.stringify({ n, pad: 'x'.repeat(40) }));
    expect([...readJsonlHead(file(`${lines.join('\n')}\n{"torn":`), 2)]).toEqual([{ n: 0, pad: 'x'.repeat(40) }, { n: 1, pad: 'x'.repeat(40) }]);
    expect([...readJsonlHead(file('{"n":1}\n{"n":'), 5)]).toEqual([{ n: 1 }]);
  });
});
