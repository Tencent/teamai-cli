import { describe, expect, it } from 'vitest';
import { expandItems } from '../workflow/fan-out.js';

function deepChain(): Array<{ id: string; after: string[] }> {
  const length = 12_000;

  return Array.from({ length }, (_, index) => ({
    id: `item-${index}`,
    after: index + 1 < length ? [`item-${index + 1}`] : [],
  }));
}

describe('fan-out dependency validation', () => {
  it('accepts an acyclic chain of item dependencies', () => {
    const items = deepChain();

    expect(expandItems('build', items)).toBe(items);
  });

  it('reports the cycle at the end of a deep chain', () => {
    const items = deepChain();
    items.at(-1)!.after = ['item-11998'];

    expect(expandItems('build', items)).toEqual({
      code: 'item_cycle',
      message: 'step "build" has items that run after each other in a cycle: item-11998 -> item-11999 -> item-11998',
    });
  });
});
