import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseYaml } from '../utils/yaml.js';

describe('parseYaml', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads YAML 1.1 tagged values as the JSON they are written as', () => {
    const text = [
      'set: !!set {a: null}',
      'binary: !!binary aGk=',
      'stamp: !!timestamp 2001-12-14',
      'omap: !!omap [{x: 1}]',
    ].join('\n');

    expect(parseYaml(text)).toEqual({ set: { a: null }, binary: 'aGk=', stamp: '2001-12-14', omap: [{ x: 1 }] });
  });

  it('warns about a tag it cannot resolve, and not about the YAML 1.1 tags it reads on purpose', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

    parseYaml('set: !!set {a: null}\nsecret: !vault token\n');

    expect(warn.mock.calls.map(([warning]) => String(warning))).toEqual([expect.stringContaining('Unresolved tag: !vault')]);
  });

  it('reads an empty document as null', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('# only a comment\n')).toBeNull();
  });
});
