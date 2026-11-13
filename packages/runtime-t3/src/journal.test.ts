import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpId } from '@teamai/runtime-protocol';
import { bundleRuntime } from '@teamai/runtime-testing/bundle';
import { journal, type PlaceRecord } from './journal.js';

const PLACE: PlaceRecord = { kind: 'confined', handle: 't3-r0123abcd-a0123abcd', run: 'r0123abcd', attempt: 'a0123abcd', ops: {}, threads: {}, launches: {} };
const FIRST = 'op-00000001' as OpId;
const SECOND = 'op-00000002' as OpId;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-journal-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A runtime process that bumps the launch time of `op`'s record `times` times, each from the record it reads. */
async function bumper(at: string): Promise<string> {
  const entry = path.join(at, 'bump.ts');
  fs.writeFileSync(entry, `import { journal } from ${JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), 'journal.ts'))};
const [dir, handle, op, times] = process.argv.slice(2);
const places = journal(dir);
for (let i = 0; i < Number(times); i++) {
  await places.update({ handle, op }, (record) => record && { ...record, launch: record.launch && { ...record.launch, launchedAt: record.launch.launchedAt + 1 } });
}
`);

  return bundleRuntime({ entry, outfile: path.join(at, 'bump.mjs') });
}

/** Runs `executable` with `args` and resolves once it exits 0. */
function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`))));
  });
}

describe('the T3 journal', () => {
  it('keeps every write two runtime processes make to the same operation, each from the record it read', async () => {
    const places = journal(dir);
    places.open(PLACE);
    const launch = { title: 'review · teamai r0123abcd', runtimeMode: 'auto' as const, tool: 'claude', launchedAt: 0, signIn: 'sign-in-1' };
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' }, launch }));
    const executable = await bumper(fs.mkdtempSync(path.join(dir, '..', 'teamai-runtime-t3-bumper-')));

    try {
      await Promise.all([1, 2].map(() => run(executable, [dir, PLACE.handle, FIRST, '150'])));
    } finally {
      fs.rmSync(path.dirname(executable), { recursive: true, force: true });
    }

    expect(journal(dir).read(PLACE.handle)).toMatchObject({ kind: 'found', place: { launches: { [FIRST]: { launchedAt: 300 } } } });
  }, 60_000);

  it('finds the place of an operation from that operation\'s record alone, whatever another place\'s record holds', async () => {
    const places = journal(dir);
    const other = { ...PLACE, handle: 't3-rother-a0000000' };
    places.open(PLACE);
    places.open(other);
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' } }));
    fs.writeFileSync(places.file(other.handle), '{broken');

    expect(places.placeOf(FIRST)).toMatchObject({ kind: 'found', place: { handle: PLACE.handle } });
    expect(places.placeOf(SECOND)).toEqual({ kind: 'missing' });
  });

  it('reads an operation whose own record cannot be read as unreadable, naming that record', async () => {
    const places = journal(dir);
    places.open(PLACE);
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' } }));
    const record = places.opFile(FIRST);
    fs.writeFileSync(record, '{broken');

    expect(places.placeOf(FIRST)).toEqual({ kind: 'unreadable', file: record, why: expect.any(String) });
    expect(places.read(PLACE.handle)).toEqual({ kind: 'unreadable', handle: PLACE.handle, file: record, why: expect.any(String) });
  });

  it('finds a conversation by the op that launched it while its place is there, and forgets it with the place', async () => {
    const places = journal(dir);
    places.open(PLACE);
    const thread = { threadId: 'thread-1', title: 'review · teamai r0123abcd', model: 'claude-opus-5-5', tool: 'claude', launchedAt: 1 };
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'cancelled' }, thread }));

    expect(places.conversation(FIRST)).toEqual({ kind: 'found', record: { handle: PLACE.handle, state: { op: FIRST, state: 'cancelled' }, thread } });
    places.remove(PLACE.handle);

    expect(places.read(PLACE.handle)).toEqual({ kind: 'missing' });
    expect(places.conversation(FIRST)).toEqual({ kind: 'missing' });
  });

  it('keeps the ends two runtime processes write for different operations of one place, each from what it read before', async () => {
    const recovering = journal(dir);
    const launching = journal(dir);
    recovering.open(PLACE);
    expect(recovering.read(PLACE.handle)).toMatchObject({ kind: 'found' });
    expect(launching.read(PLACE.handle)).toMatchObject({ kind: 'found' });

    await Promise.all([
      recovering.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'cancelled' } })),
      launching.update({ handle: PLACE.handle, op: SECOND }, () => ({ state: { op: SECOND, state: 'exited', code: 0, stdout: '' } })),
    ]);

    expect(journal(dir).read(PLACE.handle)).toEqual({
      kind: 'found',
      place: { ...PLACE, ops: { [FIRST]: { op: FIRST, state: 'cancelled' }, [SECOND]: { op: SECOND, state: 'exited', code: 0, stdout: '' } } },
    });
  });

  it('reads a place that still holds its operations in its own record as unreadable, naming the file', () => {
    const places = journal(dir);
    fs.mkdirSync(path.dirname(places.file(PLACE.handle)), { recursive: true });
    fs.writeFileSync(places.file(PLACE.handle), JSON.stringify({ ...PLACE, ops: { [FIRST]: { op: FIRST, state: 'running' } } }));

    expect(places.read(PLACE.handle)).toEqual({ kind: 'unreadable', handle: PLACE.handle, file: places.file(PLACE.handle), why: expect.stringContaining('ops') });
  });

  it('reads a place whose operations cannot be listed as unreadable, naming their folder, and so does a lookup by op', async () => {
    const places = journal(dir);
    places.open(PLACE);
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' } }));
    const ops = path.join(dir, 'places', encodeURIComponent(PLACE.handle));
    fs.chmodSync(ops, 0o000);

    try {
      expect(places.read(PLACE.handle)).toEqual({ kind: 'unreadable', handle: PLACE.handle, file: ops, why: expect.stringContaining('EACCES') });
      expect(places.placeOf(FIRST)).toEqual({ kind: 'unreadable', handle: PLACE.handle, file: ops, why: expect.stringContaining('EACCES') });
    } finally {
      fs.chmodSync(ops, 0o700);
    }
  });

  it('forgets a place and every operation of it once removed', async () => {
    const places = journal(dir);
    places.open(PLACE);
    await places.update({ handle: PLACE.handle, op: FIRST }, () => ({ state: { op: FIRST, state: 'running' } }));

    places.remove(PLACE.handle);

    expect(places.read(PLACE.handle)).toEqual({ kind: 'missing' });
    expect(places.placeOf(FIRST)).toEqual({ kind: 'missing' });
    expect(fs.readdirSync(path.join(dir, 'places'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'ops'))).toEqual([]);
  });
});
