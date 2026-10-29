import { describe, expect, it } from 'vitest';
import { envAdvice } from '../workflow/requirements.js';

describe('envAdvice', () => {
  it('offers env set alone for a key the team declares', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment');
  });

  it('names the declare step and the value step for a key the team does not declare', () => {
    expect(envAdvice(['SIGNING_KEY'], new Set()))
      .toBe('set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY');
  });

  it('keeps a mixed list to both remedies, each for its own keys', () => {
    expect(envAdvice(['SIGNING_KEY', 'API_TOKEN'], new Set(['SIGNING_KEY'])))
      .toBe('run teamai env set SIGNING_KEY, or set it in the environment; set API_TOKEN in the environment, or declare it in the team repo with teamai env add API_TOKEN --secret and give it a value with teamai env set API_TOKEN');
  });
});
