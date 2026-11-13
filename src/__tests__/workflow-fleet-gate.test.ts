import { describe, expect, it } from 'vitest';
import { gateQuestions } from '../workflow/fleet/gate.js';
import type { ExecQuestion } from '@teamai/runtime-protocol/step-runtime';

const GO_ON: ExecQuestion = { step: 'confirm', kind: 'approve', message: 'Go on?', options: ['yes', 'no'], required: false };
const SHIP: ExecQuestion = { step: 'ship', kind: 'approve', message: 'Ship it?', options: ['yes', 'no'], required: false };

/** Whether `promise` settled by the time every pending callback ran. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | 'pending'> {
  return Promise.race([promise.then((value) => ({ value })), new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);
}

describe('the gates a fleet member asks its owner', () => {
  it('hands an answer read late, after the same question was asked again, to neither question twice', async () => {
    const gates = gateQuestions();
    const first = gates.ask(GO_ON);
    const answeredFirst = { write: 'w2', question: GO_ON, answer: { choice: 'yes' } };

    // Two reads of the record saw the owner's first answer: one hands it, the other acts on it late.
    expect(gates.take(answeredFirst)).toBe(true);
    expect(await first).toEqual({ choice: 'yes' });
    const second = gates.ask(GO_ON);

    expect(gates.take(answeredFirst)).toBe(false);
    expect(await settled(second)).toBe('pending');
    expect(gates.take({ write: 'w4', question: GO_ON, answer: { choice: 'no' } })).toBe(true);
    expect(await second).toEqual({ choice: 'no' });
  });

  it('hands no answer to a question it does not answer', async () => {
    const gates = gateQuestions();
    const asked = gates.ask(SHIP);

    expect(gates.take({ write: 'w2', question: GO_ON, answer: { choice: 'yes' } })).toBe(false);
    expect(await settled(asked)).toBe('pending');
    expect(gates.asking).toEqual(SHIP);
  });

  it('hands nothing when no question waits, and ends a question it refuses with why', async () => {
    const gates = gateQuestions();

    expect(gates.take({ write: 'w2', question: GO_ON, answer: { choice: 'yes' } })).toBe(false);
    const asked = gates.ask(GO_ON);
    gates.refuse('The question holds a secret.');

    expect(await asked).toEqual({ refused: 'The question holds a secret.' });
    expect(gates.asking).toBeUndefined();
  });

  it('ends a question still waiting when another is asked, so no ask waits on an answer that never comes', async () => {
    const gates = gateQuestions();
    const first = gates.ask(GO_ON);
    const second = gates.ask(SHIP);

    expect(await settled(first)).toEqual({ value: { refused: 'Another question of the nested run replaced it before the owner answered.' } });
    expect(gates.asking).toEqual(SHIP);
    expect(gates.take({ write: 'w2', question: SHIP, answer: { choice: 'yes' } })).toBe(true);
    expect(await second).toEqual({ choice: 'yes' });
  });
});
