import { describe, expect, it } from 'vitest';
import { outdatedBenchmarkPlan } from '../scorers/engine-hooks.js';
import type { RunState } from '../workflow/types.js';

describe('the benchmark checks the engine loads on call', () => {
  it('answers every call made while they first load, as the parallel leases of a run make them', async () => {
    // A run that admitted an output, so each call reaches the benchmark checks, and holds no plan, so each answers none.
    const run = { id: 'r0123456789abcdef', admitted: {}, steps: [], definition: { name: 'review', steps: [] } } as unknown as RunState;
    const loaded = { isDone: false };
    const first = outdatedBenchmarkPlan(run).finally(() => { loaded.isDone = true; });
    const later: Promise<unknown>[] = [];

    while (!loaded.isDone) {
      later.push(outdatedBenchmarkPlan(run));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const answers = await Promise.allSettled([first, ...later]);
    expect(answers.flatMap((answer) => (answer.status === 'rejected' ? [String(answer.reason)] : []))).toEqual([]);
  });
});
