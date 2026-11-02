import { describe, expect, it } from 'vitest';

import { parseJson } from '../utils/json.js';

describe('parseJson', () => {
  it('keeps a __proto__ key as the own key the file holds, so a write-back keeps it', () => {
    const text = '{"env":{"__proto__":{"x":1},"A":"1"},"theme":"dark"}';

    expect(JSON.stringify(parseJson(text))).toBe(text);
  });
});
