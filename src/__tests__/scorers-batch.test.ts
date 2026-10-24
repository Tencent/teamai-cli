import { describe, expect, it } from 'vitest';
import { batchesScorers } from '../scorers/batch.js';

describe('batchesScorers', () => {
  it.each([
    [{ step: true, workflow: false, team: false }, true],
    [{ step: false, workflow: true, team: true }, false],
    [{ workflow: true, team: false }, true],
    [{ workflow: false, team: true }, false],
    [{ team: true }, true],
    [{}, false],
  ])('step > workflow > team > off: %o gives %s', (layers, batched) => {
    expect(batchesScorers(layers)).toBe(batched);
  });
});
