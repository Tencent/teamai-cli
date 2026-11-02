import { describe, expect, it } from 'vitest';

import { parseYaml } from '../utils/yaml.js';

describe('parseYaml', () => {
  it('reads YAML 1.1 tagged values as the JSON they are written as', () => {
    const text = [
      'set: !!set {a: null}',
      'binary: !!binary aGk=',
      'stamp: !!timestamp 2001-12-14',
      'omap: !!omap [{x: 1}]',
    ].join('\n');

    expect(parseYaml(text)).toEqual({ set: { a: null }, binary: 'aGk=', stamp: '2001-12-14', omap: [{ x: 1 }] });
  });

  it('reads an empty document as null', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('# only a comment\n')).toBeNull();
  });
});
