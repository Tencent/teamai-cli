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

  it('removes a key and keeps the member\'s comment above it, since teamai writes no comment', () => {
    const mcp = '{\n  "mcpServers": {\n    // my own servers below\n    "teamai-x": { "url": "https://t" },\n    "mine": { "url": "https://m" }\n  }\n}\n';

    expect(editJsonText(mcp, { mcpServers: { mine: { url: 'https://m' } } }))
      .toBe('{\n  "mcpServers": {\n    // my own servers below\n    "mine": { "url": "https://m" }\n  }\n}\n');
  });

  it('creates nested objects the original does not hold', () => {
    const next = { theme: 'dark', hooks: { Stop: [{ command: 'mine' }] }, stale: true, mcp: { servers: { team: { url: 'https://x' } } } };

    expect(parseJsonAs(editJsonText(settings, next), 'jsonc')).toEqual(next);
  });

  it('edits a changed array element and a scalar in place', () => {
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

  it('adds a key after the member\'s, leaving their text and trailing comments as written', () => {
    const opencode = [
      '{',
      '  "mcp": {',
      '    "notes": { "type": "local", "command": ["echo", "notes"], "enabled": false }, // off for now',
      '  },',
      '}',
      '',
    ].join('\n');
    const team = { type: 'local', command: ['npx', '-y', '@acme/formatter-mcp'], enabled: true };
    const edited = editJsonText(opencode, { mcp: { notes: { type: 'local', command: ['echo', 'notes'], enabled: false }, 'local-formatter': team } });

    expect(edited).toBe([
      '{',
      '  "mcp": {',
      '    "notes": { "type": "local", "command": ["echo", "notes"], "enabled": false }, // off for now',
      '    "local-formatter": {',
      '      "type": "local",',
      '      "command": [',
      '        "npx",',
      '        "-y",',
      '        "@acme/formatter-mcp"',
      '      ],',
      '      "enabled": true',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'));
  });

  it('appends after every comment on the member\'s line, so removing the added key keeps them', () => {
    const trailingComma = '{\n  "mine": 1, /* explanation */ // keep\n}\n';
    const appended = editJsonText(trailingComma, { mine: 1, team: 2 });

    expect(appended).toBe('{\n  "mine": 1, /* explanation */ // keep\n  "team": 2,\n}\n');
    expect(editJsonText(appended, { mine: 1 })).toBe(trailingComma);

    const sameLine = '{\n  "mine": 1 /* explanation */ // keep\n}\n';
    const withTeam = editJsonText(sameLine, { mine: 1, team: 2 });

    expect(withTeam).toBe('{\n  "mine": 1, /* explanation */ // keep\n  "team": 2\n}\n');
    expect(editJsonText(withTeam, { mine: 1 })).toBe(sameLine);
  });

  it('removes the last key, keeping the comment of the key before it, and leaves no trailing comma', () => {
    const hooks = '{\n  "hooks": {\n    "stop": [{ "command": "mine" }], // my own\n    "sessionStart": [{ "command": "teamai" }]\n  }\n}\n';
    const edited = editJsonText(hooks, { hooks: { stop: [{ command: 'mine' }] } });

    expect(edited).toBe('{\n  "hooks": {\n    "stop": [{ "command": "mine" }] // my own\n  }\n}\n');
    expect(parseJsonAs(edited, 'json-comments')).toEqual({ hooks: { stop: [{ command: 'mine' }] } });
  });

  it('removes the first key and keeps the comment above the key after it', () => {
    const mcp = '{\n  "mcpServers": {\n    "team": { "url": "https://x" },\n    // personal, keep\n    "notes": { "url": "https://n" }\n  }\n}\n';

    expect(editJsonText(mcp, { mcpServers: { notes: { url: 'https://n' } } }))
      .toBe('{\n  "mcpServers": {\n    // personal, keep\n    "notes": { "url": "https://n" }\n  }\n}\n');
  });

  it('adds an element to an array and keeps the comments on the member\'s elements', () => {
    const linted = '{\n  "hooks": {\n    "Stop": [\n      // runs my linter\n      { "command": "lint" },\n    ],\n  },\n}\n';
    const edited = editJsonText(linted, { hooks: { Stop: [{ command: 'lint' }, { command: 'teamai' }] } });

    expect(edited).toBe('{\n  "hooks": {\n    "Stop": [\n      // runs my linter\n      { "command": "lint" },\n      {\n        "command": "teamai"\n      },\n    ],\n  },\n}\n');
  });

  it('removes an array element and keeps the comments on the others', () => {
    const stale = '{\n  "Stop": [\n    { "command": "teamai-old" },\n    // runs my linter\n    { "command": "lint" }\n  ]\n}\n';

    expect(editJsonText(stale, { Stop: [{ command: 'lint' }] })).toBe('{\n  "Stop": [\n    // runs my linter\n    { "command": "lint" }\n  ]\n}\n');
  });

  it('finds a comma written after a comment, when it removes or appends next to a key', () => {
    const noted = '{"a": 1 /* note */, "b": 2}';

    expect(editJsonText(noted, { b: 2 })).toBe('{"b": 2}');
    expect(parseJsonAs(editJsonText(noted, { a: 1 }), 'json-comments')).toEqual({ a: 1 });
    expect(parseJsonAs(editJsonText('{\n  "a": 1 /* note */,\n}\n', { a: 1, b: 2 }), 'jsonc')).toEqual({ a: 1, b: 2 });
  });

  it('edits a changed array element in place and keeps the comments inside it', () => {
    const hooks = '{"Stop": [{ "command": "old", /* keep */ "timeout": 30 }]}';

    expect(editJsonText(hooks, { Stop: [{ command: 'new', timeout: 30 }] })).toBe('{"Stop": [{ "command": "new", /* keep */ "timeout": 30 }]}');
  });

  it('leaves the text as it is when the value has not changed', () => {
    expect(editJsonText(settings, parseJsonAs(settings, 'jsonc'))).toBe(settings);
  });
});
