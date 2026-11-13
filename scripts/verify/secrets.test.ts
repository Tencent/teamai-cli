import type { JsonObject } from '@teamai/shared/json';
import { describe, expect, it } from 'vitest';
import { declaredCredentialNames, judgeSandboxEnv, ledgerRedactor, lineRedactor, parseEnviron, passedKeys, splitPassOption, worldRedactor } from './secrets.js';

const TOKEN = 'tok-0123456789abcdef';

describe('--pass', () => {
  it('takes the names given right after the run id, in one word or two, and leaves the command alone', () => {
    expect(splitPassOption(['--pass', 'A_TOKEN,B', 'teamai', '--pass', 'x'])).toEqual({ names: ['A_TOKEN', 'B'], argv: ['teamai', '--pass', 'x'] });
    expect(splitPassOption(['--pass=A_TOKEN', 'git', 'status'])).toEqual({ names: ['A_TOKEN'], argv: ['git', 'status'] });
    expect(splitPassOption(['git', 'status'])).toEqual({ names: [], argv: ['git', 'status'] });
  });

  it('copies each named variable from the harness, and names the ones it does not have', () => {
    expect(passedKeys(['A_TOKEN', 'PLAIN'], { A_TOKEN: TOKEN, PLAIN: 'x', OTHER: 'y' })).toEqual({ ok: true, keys: new Map([['A_TOKEN', TOKEN], ['PLAIN', 'x']]) });
    expect(passedKeys(['A_TOKEN', 'GONE', 'EMPTY'], { A_TOKEN: TOKEN, EMPTY: '' })).toEqual({ ok: false, missing: ['GONE', 'EMPTY'] });
  });

  it('refuses a name that is not a variable name', () => {
    expect(passedKeys(['A-B'], { 'A-B': 'x' })).toEqual({ ok: false, missing: ['A-B'] });
  });
});

describe("a world's redaction", () => {
  it('masks every passed value, whatever its name, and every secret-looking value of the harness, by name', () => {
    const redact = worldRedactor({ passed: new Map([['GATEWAY_URL', 'https://gw.internal.example']]), harnessEnv: { ANTHROPIC_AUTH_TOKEN: TOKEN, HOME: '/Users/me' } });

    expect(redact(`calling https://gw.internal.example with ${TOKEN} from /Users/me`)).toBe('calling <REDACTED:GATEWAY_URL> with <REDACTED:ANTHROPIC_AUTH_TOKEN> from /Users/me');
  });

  it("masks in a ledger the value of every name the world's commands were given, whatever the name, and no other, and names those this shell lacks", () => {
    const { mask, unmasked } = ledgerRedactor({ passedNames: ['PLAIN_SETTING', 'GONE'], harnessEnv: { PLAIN_SETTING: 'plain-value-1234', OTHER: 'other-value-5678' } });

    expect(mask('process 42 (tool --flag plain-value-1234 other-value-5678)')).toBe('process 42 (tool --flag <REDACTED:PLAIN_SETTING> other-value-5678)');
    expect(unmasked).toEqual(['GONE']);
  });

  it('masks a value that arrives split across two chunks, line by line', () => {
    const lines = lineRedactor(worldRedactor({ passed: new Map([['A_TOKEN', TOKEN]]), harnessEnv: {} }));

    expect(`${lines.push(`one ${TOKEN.slice(0, 7)}`)}${lines.push(`${TOKEN.slice(7)} two\nthree `)}${lines.push(TOKEN)}${lines.end()}`).toBe('one <REDACTED:A_TOKEN> two\nthree <REDACTED:A_TOKEN>');
  });
});

describe("what a sandbox's environment may hold", () => {
  const canary = 'c4n4ry-0123456789abcdef';
  const secrets = new Map([['GATEWAY_TOKEN', 'tok-abcdef0123456789'], ['OTHER_API_KEY', 'key-9876543210fedcba']]);

  it('is ok with what a step may carry, a declared credential under its own name among it', () => {
    expect(judgeSandboxEnv({ env: new Map([['PATH', '/usr/bin'], ['GATEWAY_TOKEN', 'tok-abcdef0123456789']]), canary, secrets, declared: new Set(['GATEWAY_TOKEN']) })).toEqual({ kind: 'ok' });
  });

  it("names every variable that holds the world's canary, or a host secret the step's credentials did not declare, and never a value", () => {
    const judged = judgeSandboxEnv({
      env: new Map([['LEAKED', `x${canary}y`], ['VERIFY_WORLD_CANARY', canary], ['ANTHROPIC_API_KEY', 'tok-abcdef0123456789'], ['OTHER_API_KEY', 'key-9876543210fedcba']]),
      canary,
      secrets,
      declared: new Set(['ANTHROPIC_API_KEY']),
    });

    expect(judged).toEqual({ kind: 'leak', names: ['LEAKED', 'OTHER_API_KEY', 'VERIFY_WORLD_CANARY'] });
    expect(JSON.stringify(judged)).not.toContain('tok-');
  });

  it('takes a short value for a leak only under its own name: under another, a variable holds it by chance', () => {
    const short = new Map([['FEATURE_FLAG', 'on'], ['DISABLE_TELEMETRY', '1']]);

    expect(judgeSandboxEnv({ env: new Map([['COPIED', 'on'], ['ARGS', '--mode on'], ['SHLVL', '1']]), canary, secrets: short, declared: new Set() })).toEqual({ kind: 'ok' });
    expect(judgeSandboxEnv({ env: new Map([['FEATURE_FLAG', 'on'], ['DISABLE_TELEMETRY', '1']]), canary, secrets: short, declared: new Set(['FEATURE_FLAG']) })).toEqual({ kind: 'leak', names: ['DISABLE_TELEMETRY'] });
  });

  it("takes the credential names a driver definition's runtime options or a member's driver settings declare", () => {
    const definition: JsonObject = { name: 'containers', runtimes: [{ use: 'sandbox', options: { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'env:CLAUDE_CODE_OAUTH_TOKEN', NPM_TOKEN: 'env:ACME_NPM_TOKEN' } } }, { use: 'tools' }] };
    const settings = { workflows: { drivers: { containers: { runtimes: { sandbox: { credentials: { GH_TOKEN: 'env:MY_GH_TOKEN' } } } } } } };

    expect(declaredCredentialNames(definition)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'NPM_TOKEN']);
    expect(declaredCredentialNames(settings)).toEqual(['GH_TOKEN']);
    expect(declaredCredentialNames({ runtimes: [{ use: 'tools' }], credentials: 'not a mapping' })).toEqual([]);
  });

  it("reads a process's environment as /proc gives it, NUL-separated", () => {
    expect(parseEnviron('A=1\0B=x=y\0\0junk\0')).toEqual(new Map([['A', '1'], ['B', 'x=y']]));
  });
});
