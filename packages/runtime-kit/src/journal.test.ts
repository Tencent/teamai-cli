import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hold, recordStore } from './journal.js';

const PlaceSchema = z.object({ handle: z.string(), run: z.string() });

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-kit-journal-'));
});

afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a record store', () => {
  it('reads back what it wrote, by key, and lists its keys', () => {
    const store = recordStore(path.join(dir, 'places'), PlaceSchema);

    store.write('t3-r1/a 1', { handle: 't3-r1/a 1', run: 'r1' });
    store.write('t3-r2', { handle: 't3-r2', run: 'r2' });

    expect(store.read('t3-r1/a 1')).toEqual({ kind: 'found', record: { handle: 't3-r1/a 1', run: 'r1' } });
    expect(store.keys()).toEqual(['t3-r1/a 1', 't3-r2']);
  });

  it('answers missing for a key it holds no record of, and once the record is removed', () => {
    const store = recordStore(path.join(dir, 'places'), PlaceSchema);

    expect(store.read('t3-r1')).toEqual({ kind: 'missing' });
    store.write('t3-r1', { handle: 't3-r1', run: 'r1' });
    store.remove('t3-r1');

    expect(store.read('t3-r1')).toEqual({ kind: 'missing' });
    expect(store.keys()).toEqual([]);
  });

  it.each([
    ['is not JSON', '{"handle":'],
    ['does not match its schema', '{"handle":"t3-r1"}'],
  ])('answers unreadable, naming the file, for a record that %s', (_, text) => {
    const store = recordStore(dir, PlaceSchema);
    fs.writeFileSync(store.file('t3-r1'), text);

    expect(store.read('t3-r1')).toEqual({ kind: 'unreadable', file: path.join(dir, 't3-r1.json'), why: expect.any(String) });
  });

  it('leaves the previous record and no temporary file when a write fails', () => {
    const store = recordStore(dir, PlaceSchema);
    store.write('t3-r1', { handle: 't3-r1', run: 'r1' });
    fs.chmodSync(dir, 0o500);

    expect(() => store.write('t3-r1', { handle: 't3-r1', run: 'r2' })).toThrow();
    expect(store.read('t3-r1')).toEqual({ kind: 'found', record: { handle: 't3-r1', run: 'r1' } });
    expect(fs.readdirSync(dir)).toEqual(['t3-r1.json']);
  });
});

describe('an update of a record', () => {
  const CountSchema = z.object({ count: z.number() });

  it('keeps every write of callers that update one record at once, each from the record it read', async () => {
    const store = recordStore(dir, CountSchema);

    await Promise.all(Array.from({ length: 20 }, () => store.update('op-1', (record) => ({ count: (record?.count ?? 0) + 1 }))));

    expect(store.read('op-1')).toEqual({ kind: 'found', record: { count: 20 } });
    expect(store.keys()).toEqual(['op-1']);
  });

  it('writes nothing over a record it cannot read, and names its file', async () => {
    const store = recordStore(dir, CountSchema);
    fs.writeFileSync(store.file('op-1'), '{broken');

    await expect(store.update('op-1', () => ({ count: 1 }))).rejects.toThrow(`${store.file('op-1')} cannot be read`);
    expect(fs.readFileSync(store.file('op-1'), 'utf8')).toBe('{broken');
  });
});

describe('a hold on a key', () => {
  it('keeps a second caller waiting until the first releases it', async () => {
    const order: string[] = [];
    const first = await hold(dir, 'settings');
    const second = hold(dir, 'settings').then((release) => { order.push('second'); release(); });

    await new Promise((resolve) => setTimeout(resolve, 100));
    order.push('first released');
    first();
    await second;

    expect(order).toEqual(['first released', 'second']);
  });

  it('takes over a hold whose process is gone', async () => {
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    const release = await hold(dir, 'settings');
    const held = fs.readdirSync(dir).find((name) => !name.startsWith('.'));
    release();
    fs.writeFileSync(path.join(dir, held ?? 'missing'), `${gone} stale`);

    const taken = await hold(dir, 'settings');
    taken();

    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
