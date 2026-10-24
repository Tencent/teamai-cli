import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  StepCheckpointSchema, StepStateSchema, cancellable, inProgress, type StepCheckpoint, type StepState,
} from '../workflow/step-state.js';

function statusesOf(schema: typeof StepStateSchema | typeof StepCheckpointSchema): string[] {
  return schema.options.map((option) => option.shape.status.value).sort();
}

const step = (status: StepState['status']): StepState => StepStateSchema.parse({
  id: 'work', status,
  ...(status === 'leased' ? { attempt: 'a1', lease: { attempt: 'a1', revision: 1, driver: { kind: 'local', machine: 'm', workspace: 'w' } } } : {}),
  ...(status === 'cancelled' ? { failure: { code: 'cancelled', message: 'Cancelled' } } : {}),
  ...(status === 'delivering' ? { delivery: { branch: 'teamai/r1/work/p1', head: 'c'.repeat(40) } } : {}),
});

describe('step statuses', () => {
  it('a handed-over run carries every status a local run has', () => {
    expectTypeOf<StepCheckpoint['status']>().toEqualTypeOf<StepState['status']>();
    expect(statusesOf(StepCheckpointSchema)).toEqual(statusesOf(StepStateSchema));
  });

  it.each([
    ['pending', false, true], ['waiting', true, true], ['leased', true, true], ['running', true, true],
    ['delivering', true, true], ['succeeded', false, false], ['failed', false, false], ['skipped', false, false],
    ['cancelled', false, false],
  ] as const)('a %s step is in progress: %s, and can be cancelled: %s', (status, open, stoppable) => {
    expect(inProgress(step(status))).toBe(open);
    expect(cancellable(step(status))).toBe(stoppable);
  });
});
