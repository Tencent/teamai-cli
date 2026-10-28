import { describe, expect, it } from 'vitest';
import { envValueAdvice } from '../env-advice.js';
import { negotiate, type Allow, type DriverCan, type EnvFacts, type Offer } from '../workflow/requirements.js';

/**
 * The advice a member gets about an env key a step requires and this machine
 * has no value for (#1513). `teamai env set` refuses a key the team does not
 * declare, so the command is named only for the keys it works for.
 */
describe('env value advice', () => {
  it('names the command for a key the team declares, and the environment as what always works', () => {
    expect(envValueAdvice(['SIGNING_KEY'], new Set(['SIGNING_KEY']))).toBe(
      'Run teamai env set SIGNING_KEY, or set it in the environment',
    );
    expect(envValueAdvice(['FOO', 'BAR'], new Set(['FOO', 'BAR']))).toBe(
      'Run teamai env set FOO, teamai env set BAR, or set them in the environment',
    );
  });

  it('names the environment, not the command, for a key the team does not declare', () => {
    const advice = envValueAdvice(['SIGNING_KEY'], new Set());
    expect(advice).not.toContain('teamai env set');
    expect(advice).toBe(
      'Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret)',
    );
  });

  it('names the environment for several keys the team does not declare', () => {
    const advice = envValueAdvice(['FOO', 'BAR'], new Set());
    expect(advice).toBe(
      'Set them in the environment, or declare them in the team repo (teamai env add FOO --secret, teamai env add BAR --secret)',
    );
  });

  it('names the command for the key the team declares and the environment for the one it does not', () => {
    const advice = envValueAdvice(['FOO', 'BAR'], new Set(['FOO']));
    expect(advice).toBe(
      'Run teamai env set FOO, or set BAR in the environment, or declare BAR in the team repo (teamai env add BAR --secret)',
    );
  });
});

describe('the missing_env failure', () => {
  const offer: Offer = {
    step: 'sign',
    executor: 'command',
    requires: { env: ['SIGNING_KEY'] },
    interactive: false,
    hasContract: false,
    envKeys: [],
    runEnvKeys: new Set(),
    budgeted: false,
  };
  const can: DriverCan = { env: true };
  const allow: Allow = {};
  const facts = (declared: readonly string[]): EnvFacts => ({
    declared: new Set(declared),
    secrets: new Set(),
    present: new Set(),
  });

  it('tells the member to set a key the team does not declare in the environment, and names no command that fails', () => {
    const result = negotiate(offer, can, allow, facts([]));
    expect(result).toMatchObject({
      kind: 'fail',
      failure: {
        code: 'missing_env',
        message: 'Step "sign" requires env SIGNING_KEY, which has no value on this machine. '
          + 'Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret), then retry the step.',
      },
    });
    expect(result.kind === 'fail' && result.failure.message).not.toContain('teamai env set SIGNING_KEY');
  });

  it('names the command for a key the team declares', () => {
    const result = negotiate(offer, can, allow, facts(['SIGNING_KEY']));
    expect(result).toMatchObject({
      kind: 'fail',
      failure: {
        code: 'missing_env',
        message: 'Step "sign" requires env SIGNING_KEY, which has no value on this machine. '
          + 'Run teamai env set SIGNING_KEY, or set it in the environment, then retry the step.',
      },
    });
  });
});
