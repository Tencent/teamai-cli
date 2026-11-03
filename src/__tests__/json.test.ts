import { describe, expect, it } from 'vitest';

import { editJsonText, parseJson, parseJsonAs } from '../utils/json.js';

describe('parseJson', () => {
  it('keeps a __proto__ key as the own key the file holds, so a write-back keeps it', () => {
    const text = '{"env":{"__proto__":{"x":1},"A":"1"},"theme":"dark"}';

    expect(JSON.stringify(parseJson(text))).toBe(text);
  });
});

describe('parseJsonAs', () => {
  const commented = '{\n  // the member\'s note\n  "a": 1, /* inline */\n  "b": [1, 2,],\n}\n';

  it('reads comments and trailing commas as JSON with comments', () => {
    expect(parseJsonAs(commented, 'jsonc')).toEqual({ a: 1, b: [1, 2] });
  });

  it('reads comments but refuses a trailing comma where the tool strips comments only', () => {
    expect(parseJsonAs('{\n  // note\n  "a": 1 /* inline */\n}', 'json-comments')).toEqual({ a: 1 });
    expect(() => parseJsonAs(commented, 'json-comments')).toThrow(/trailing comma|at offset/i);
  });

  it('refuses a comment in strict JSON', () => {
    expect(() => parseJsonAs(commented, 'json')).toThrow();
  });

  it('keeps a __proto__ key as an own key in a commented file too', () => {
    expect(JSON.stringify(parseJsonAs('{\n  // note\n  "env": { "__proto__": { "x": 1 }, "A": "1" },\n}', 'jsonc'))).toBe('{"env":{"__proto__":{"x":1},"A":"1"}}');
  });

  it('throws on text that is not JSON with comments either', () => {
    expect(() => parseJsonAs('{ "a": }', 'jsonc')).toThrow(/at offset \d+/);
    expect(() => parseJsonAs('', 'jsonc')).toThrow();
  });
});

describe('editJsonText', () => {
  const settings = [
    '{',
    '  // theme the member picked',
    '  "theme": "dark",',
    '  "hooks": {',
    '    /* the member\'s own hook */',
    '    "Stop": [{ "command": "mine" }],',
    '  },',
    '  "stale": true,',
    '}',
    '',
  ].join('\n');

  it('reaches the next value and keeps the comments outside the changed paths', () => {
    const next = { theme: 'dark', hooks: { Stop: [{ command: 'mine' }], SessionStart: [{ command: 'team' }] }, stale: true };
    const edited = editJsonText(settings, next);

    expect(parseJsonAs(edited, 'jsonc')).toEqual(next);
    expect(edited).toContain('// theme the member picked');
    expect(edited).toContain('/* the member\'s own hook */');
  });

  it('removes a key the next value drops', () => {
    const edited = editJsonText(settings, { theme: 'dark', hooks: { Stop: [{ command: 'mine' }] } });

    expect(parseJsonAs(edited, 'jsonc')).toEqual({ theme: 'dark', hooks: { Stop: [{ command: 'mine' }] } });
    expect(edited).not.toContain('stale');
  });

  it('removes the comment just before a removed key with it, and keeps the others', () => {
    const edited = editJsonText('{\n  // keep\n  "a": 1,\n  // about b\n  "b": 2\n}\n', { a: 1 });

    expect(edited).toContain('// keep');
    expect(edited).not.toContain('about b');
    expect(parseJsonAs(edited, 'jsonc')).toEqual({ a: 1 });
  });

  it('creates nested objects the original does not hold', () => {
    const next = { theme: 'dark', hooks: { Stop: [{ command: 'mine' }] }, stale: true, mcp: { servers: { team: { url: 'https://x' } } } };

    expect(parseJsonAs(editJsonText(settings, next), 'jsonc')).toEqual(next);
  });

  it('replaces an array whole and changes a scalar in place', () => {
    const next = { theme: 'light', hooks: { Stop: [{ command: 'other' }] }, stale: true };
    const edited = editJsonText(settings, next);

    expect(parseJsonAs(edited, 'jsonc')).toEqual(next);
    expect(edited).toContain('// theme the member picked');
  });

  it('keeps the original indentation and line endings for what it adds', () => {
    const tabbed = '{\r\n\t// note\r\n\t"a": 1\r\n}\r\n';
    const edited = editJsonText(tabbed, { a: 1, b: { c: 2 } });

    expect(parseJsonAs(edited, 'jsonc')).toEqual({ a: 1, b: { c: 2 } });
    expect(edited).toContain('\r\n\t"b": {\r\n\t\t"c": 2\r\n\t}');
    expect(edited.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('leaves the text as it is when the value has not changed', () => {
    expect(editJsonText(settings, parseJsonAs(settings, 'jsonc'))).toBe(settings);
  });
});
