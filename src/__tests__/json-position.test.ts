import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { jsonSyntaxErrorOffset, lineAndColumn } from '../utils/json-position.js';

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe('jsonSyntaxErrorOffset', () => {
  it('accepts exactly what JSON.parse accepts', () => {
    const jsonish = fc.oneof(
      fc.json(),
      fc.string({ unit: fc.constantFrom('{', '}', '[', ']', '"', ':', ',', ' ', '\n', '\\', 'u', '0', '1', '-', '.', 'e', 't', 'r', 'n', 'x') }),
      fc.tuple(fc.json(), fc.nat(), fc.string({ maxLength: 2 })).map(([text, at, insert]) => {
        const i = at % (text.length + 1);
        return text.slice(0, i) + insert + text.slice(i);
      }),
    );
    fc.assert(fc.property(jsonish, (text) => {
      expect(jsonSyntaxErrorOffset(text) === null).toBe(parses(text));
    }), { numRuns: 2000 });
  });

  it('points at the first character that breaks the text', () => {
    const text = '{\n  "GITHUB_TOKEN": { "value": ghp_fixture }\n}\n';
    const offset = jsonSyntaxErrorOffset(text);
    expect(offset).toBe(text.indexOf('ghp_fixture'));
    expect(lineAndColumn(text, offset ?? -1)).toEqual({ line: 2, column: 30 });
  });
});
