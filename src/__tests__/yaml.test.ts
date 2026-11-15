import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseYaml } from '@teamai/shared/yaml';
import { mergeTeamConfig } from '../utils/yaml.js';

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
describe('mergeTeamConfig', () => {
  const base = 'autoUpdate: false\nusageReport: false\n';
  const pending = 'autoUpdate: true\nusageReport: false\n';
  const destination = 'autoUpdate: false\nusageReport: true\n';
  const invalid = 'broken: [\n';

  it.each([
    ['the pending edit deletes a key', 'usageReport: false\n', destination, { usageReport: true }],
    ['the destination deletes a key', pending, 'autoUpdate: false\n', { autoUpdate: true }],
  ])('merges an independent edit when %s', (_name, edit, target, expected) => {
    expect(parseYaml(mergeTeamConfig(base, edit, target))).toEqual(expected);
  });

  it.each([
    ['base', invalid, pending, destination],
    ['pending', base, invalid, destination],
    ['destination', base, pending, invalid],
    ['pending with a matching destination', base, invalid, base],
    ['base and destination when identical', invalid, pending, invalid],
  ])('refuses invalid YAML in %s', (_name, original, edit, target) => {
    expect(() => mergeTeamConfig(original, edit, target)).toThrow(/flow sequence/i);
  });

  it('names a key changed differently on both sides', () => {
    expect(() => mergeTeamConfig('setting: base\n', 'setting: pending\n', 'setting: destination\n'))
      .toThrow('Conflicting keys: setting.');
  });

  it('treats nested changes under the same top-level key as a conflict', () => {
    expect(() => mergeTeamConfig('sharing: {hooks: false, rules: false}\n',
      'sharing: {hooks: true, rules: false}\n', 'sharing: {hooks: false, rules: true}\n'))
      .toThrow('Conflicting keys: sharing.');
  });

  it('keeps CRLF in a merged destination', () => {
    expect(mergeTeamConfig(base, pending, destination.replaceAll('\n', '\r\n')))
      .toBe('autoUpdate: true\r\nusageReport: true\r\n');
  });

  it('returns the pending text byte for byte when the base and destination match', () => {
    const formatted = '# Keep this comment\r\nautoUpdate: true\r\nusageReport: false\r\n';

    expect(mergeTeamConfig(base, formatted, base)).toBe(formatted);
  });
});
