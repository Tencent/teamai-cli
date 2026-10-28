import { describe, expect, it } from 'vitest';

import { stepEnvironment } from '../env-exec.js';
import type { EnvFacts } from '../workflow/requirements.js';

/**
 * The `missing_env` a step gets for a provided key with no value names the fix for that key: `teamai
 * env set` only takes a key the team declares, so an undeclared key is told to declare it first (#1513).
 */
const envOf = (declared: string[], values: Record<string, string>): { values: Map<string, string>; facts: EnvFacts } => ({
  values: new Map(Object.entries(values)),
  facts: { declared: new Set(declared), secrets: new Set(), present: new Set(Object.keys(values)) },
});

describe('stepEnvironment missing_env advice', () => {
  it('offers teamai env set for a key the team declares', async () => {
    const result = await stepEnvironment(envOf(['API_KEY'], {}), { provide: ['API_KEY'], withhold: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('missing_env');
      expect(result.failure.message).toContain('teamai env set API_KEY');
      expect(result.failure.message).not.toContain('teamai env add');
    }
  });

  it('offers teamai env add --secret first for a key the team does not declare', async () => {
    const result = await stepEnvironment(envOf([], {}), { provide: ['API_KEY'], withhold: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain('teamai env add API_KEY --secret');
      expect(result.failure.message).toContain('teamai env set API_KEY');
    }
  });

  it('still hands a present value to the step env', async () => {
    const result = await stepEnvironment(envOf(['API_KEY'], { API_KEY: 'v' }), { provide: ['API_KEY'], withhold: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.API_KEY).toBe('v');
  });
});
