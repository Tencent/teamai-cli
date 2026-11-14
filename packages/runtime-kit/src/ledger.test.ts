import { describe, expect, it } from 'vitest';
import { RuntimeMessageSchema, type OpId, type RuntimeMessage } from '@teamai/runtime-protocol';
import { opLedger, type OpEnd } from './ledger.js';

const OP = 'op-0123abcd' as OpId;

const FINISHED: OpEnd = { op: OP, state: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } };

function ledgerWritten() {
  const written: RuntimeMessage[] = [];

  return { written, ledger: opLedger({ name: 'fake', write: (message) => { written.push(RuntimeMessageSchema.parse(message)); } }) };
}

describe('an operation that ends', () => {
  it('is answered with its end once its record is kept, and nothing stands in for that record', async () => {
    const { written, ledger } = ledgerWritten();
    const kept: OpEnd[] = [];

    await ledger.settle(FINISHED, () => { kept.push(FINISHED); });

    expect(kept).toEqual([FINISHED]);
    expect(written).toEqual([{ op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } }]);
    expect(ledger.unkept(OP)).toBeUndefined();
    expect(ledger.endsOf(OP)).toBe(1);
  });

  it('is answered before settle returns when its record is kept at once, so what the runtime does next follows the end', () => {
    const { written, ledger } = ledgerWritten();

    void ledger.settle(FINISHED, () => {});
    void ledger.settle({ op: 'op-0123abce' as OpId, state: 'cancelled' }, () => { throw new Error('read-only'); });

    expect(written).toMatchObject([{ op: OP, event: 'finished' }, { op: 'op-0123abce', event: 'notice' }, { op: 'op-0123abce', event: 'cancelled' }]);
    expect(ledger.unkept('op-0123abce' as OpId)).toEqual({ op: 'op-0123abce', state: 'cancelled' });
  });

  it('is answered with its true end when its record cannot be kept, says so in a notice, and remembers that end until forgotten', async () => {
    const { written, ledger } = ledgerWritten();

    await ledger.settle(FINISHED, () => { throw new Error('EACCES: permission denied'); });

    expect(written).toEqual([
      { event: 'notice', op: OP, message: `Runtime fake could not record how ${OP} ended (EACCES: permission denied), so only this runtime process remembers that end, until the place closes.` },
      { op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } } },
    ]);
    expect(ledger.unkept(OP)).toEqual(FINISHED);

    ledger.forget(OP);

    expect(ledger.unkept(OP)).toBeUndefined();
  });

  it('stops standing in for the record once a later end of the op is kept', async () => {
    const { ledger } = ledgerWritten();

    await ledger.settle(FINISHED, () => { throw new Error('read-only'); });
    await ledger.settle({ op: OP, state: 'cancelled' }, () => {});

    expect(ledger.unkept(OP)).toBeUndefined();
  });
});

describe('an exec that ends', () => {
  it('carries the last 64 KiB of its stdout after a marker when it printed more', () => {
    const { written, ledger } = ledgerWritten();

    ledger.end({ op: OP, state: 'exited', code: 0, stdout: `early${'x'.repeat(65_536)}` });

    expect(written).toEqual([{ op: OP, event: 'exited', code: 0, stdout: `[teamai: only the last 64 KiB of stdout follow]\n${'x'.repeat(65_536)}` }]);
  });
});

describe('a prompt that ends', () => {
  it('says the limit the runtime stopped its tool at, with what else it finished with', () => {
    const { written, ledger } = ledgerWritten();

    ledger.end({ ...FINISHED, usage: { input: 10, output: 5 }, resumed: true, stopped: 'timeout' });

    expect(written).toEqual([{ op: OP, event: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { verdict: 'approve' } }, usage: { input: 10, output: 5 }, resumed: true, stopped: 'timeout' }]);
  });
});

describe('an operation this process runs', () => {
  it('ends once, with the first end any of its sources gives, and is no longer running then', async () => {
    const { written, ledger } = ledgerWritten();
    const run = { title: 'review' };
    ledger.begin(OP, run);

    expect(ledger.running(OP)).toBe(run);
    await Promise.all([
      ledger.finish({ op: OP, run, ended: { op: OP, state: 'cancelled' }, keep: () => {} }),
      ledger.finish({ op: OP, run, ended: FINISHED, keep: () => {} }),
    ]);

    expect(written).toEqual([{ op: OP, event: 'cancelled' }]);
    expect(ledger.running(OP)).toBeUndefined();
  });

  it('is ended by no source of an earlier run of it, once it runs again', async () => {
    const { written, ledger } = ledgerWritten();
    const before = { title: 'first' };
    const after = { title: 'retried' };
    ledger.begin(OP, before);
    await ledger.finish({ op: OP, run: before, ended: { op: OP, state: 'failed', failure: { code: 'cancel_failed', message: 'still runs' } }, keep: () => {} });
    ledger.begin(OP, after);

    await ledger.finish({ op: OP, run: before, ended: FINISHED, keep: () => {} });

    expect(ledger.running(OP)).toBe(after);
    expect(written.map((line) => 'event' in line && line.event)).toEqual(['failed']);
  });

  it('is let go with no end, so a later request runs it again', () => {
    const { written, ledger } = ledgerWritten();
    const run = { title: 'review' };
    ledger.begin(OP, run);

    ledger.abandon(OP, run);

    expect(ledger.running(OP)).toBeUndefined();
    expect(ledger.knows(OP)).toBe(true);
    expect(written).toEqual([]);
  });
});

describe('what a runtime process knows of an operation', () => {
  it('takes the place of an op from the acceptance that named it', () => {
    const { ledger } = ledgerWritten();

    ledger.write({ op: OP, event: 'accepted', handle: 't3-r1-a1' });

    expect(ledger.handleOf(OP)).toBe('t3-r1-a1');
    expect(ledger.knows(OP)).toBe(true);
    expect(ledger.knows('op-00000000' as OpId)).toBe(false);
  });

  it('keeps why a cancel came before its op ran here, until the op takes it', () => {
    const { ledger } = ledgerWritten();

    ledger.mark(OP, 'cancelled-unseen');

    expect(ledger.knows(OP)).toBe(true);
    expect(ledger.takeMark(OP)).toBe('cancelled-unseen');
    expect(ledger.takeMark(OP)).toBeUndefined();
  });
});
