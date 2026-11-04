import { describe, expect, it } from 'vitest';
import { expandEnvArgs } from '../utils/env-args.js';

describe('environment arguments', () => {
  it('leaves ordinary invocations unchanged', () => {
    expect(expandEnvArgs(['score', '@SUBJECT'], { SUBJECT: 'value' })).toEqual(['score', '@SUBJECT']);
  });
  it('expands whole tokens once without interpreting their contents', () => {
    const value = '{"answer":"quoted words & echo injected | %PATH% $HOME"}';
    expect(expandEnvArgs(['--env-args', 'score', '@JSON', '@EMPTY', '@NEXT', '@scope/pkg'],
      { JSON: value, EMPTY: '', NEXT: '@JSON' })).toEqual(['score', value, '', '@JSON', '@scope/pkg']);
  });
  it('rejects missing variables without disclosing values', () => {
    expect(() => expandEnvArgs(['--env-args', '@MISSING'], {})).toThrow('Environment variable MISSING is not set');
  });
});
