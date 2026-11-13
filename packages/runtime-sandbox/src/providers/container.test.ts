import { describe, expect, it } from 'vitest';
import { containerNamed } from './container.js';

describe('containerNamed', () => {
  const key = { run: 'r0123abcd', attempt: 'a0123abcd' };

  it.each([
    { name: 'teamai-r0123abcd-a0123abcd', named: { kind: 'place', key } },
    { name: 'teamai-r0123abcd-a0123abcd-proxy', named: { kind: 'filter', key } },
    { name: 'teamai-r0123abcd-a0123abcd-net', named: { kind: 'network', key } },
  ])('names what $name is of its attempt', ({ name, named }) => {
    expect(containerNamed(name)).toEqual(named);
  });

  it.each(['my-container', 'teamai-r0123abcd-a0123abcd-other', 'teamai-r0123abcd-proxy', 'xteamai-r0123abcd-a0123abcd-net'])('names nothing of %s, a name teamai does not give', (name) => {
    expect(containerNamed(name)).toBeUndefined();
  });
});
