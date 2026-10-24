import { describe, expect, it } from 'vitest';
import { requiredIsolation } from '../scorers/isolation.js';
import { LocalConfigSchema } from '../types.js';

const team = 'scorers/scoring.yaml isolation';
const scorer = 'scorers/q.md isolation';
const machine = 'config.yaml scoring.isolation';

describe('requiredIsolation', () => {
  it.each([
    [[], { level: 'best-effort', setBy: [], unknown: [] }],
    [[{ source: team, value: undefined }], { level: 'best-effort', setBy: [], unknown: [] }],
    [[{ source: team, value: 'verified' }], { level: 'verified', setBy: [team], unknown: [] }],
    [[{ source: team, value: 'best-effort' }, { source: machine, value: 'verified' }], { level: 'verified', setBy: [machine], unknown: [] }],
    [[{ source: team, value: 'best-effort' }, { source: scorer, value: 'best-effort' }], { level: 'best-effort', setBy: [team, scorer], unknown: [] }],
    [[{ source: team, value: 'verified' }, { source: scorer, value: 'verified' }, { source: machine, value: 'best-effort' }], { level: 'verified', setBy: [team, scorer], unknown: [] }],
    [[{ source: machine, value: 'strict' }], { level: 'verified', setBy: [machine], unknown: [{ source: machine, value: 'strict' }] }],
  ])('the strictest of %o wins, best-effort by default, an unknown value as verified', (settings, required) => {
    expect(requiredIsolation(settings)).toEqual(required);
  });
});

describe('scoring.isolation in config.yaml', () => {
  const config = { repo: { localPath: '/team', remote: 'local' }, username: 'tester' };

  it.each([['verified', 'verified'], ['strict', 'strict'], [3, '3']])('keeps %o as text, so a value teamai does not know can count as verified', (value, read) => {
    expect(LocalConfigSchema.parse({ ...config, scoring: { isolation: value } }).scoring?.isolation).toBe(read);
  });
});
