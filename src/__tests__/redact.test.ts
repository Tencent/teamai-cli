import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, redactJson, collectEnvSecrets, redactWithEnv } from '../utils/redact.js';

describe('redact', () => {
  it('returns empty and non-secret text unchanged', () => {
    expect(redact('')).toBe('');
    expect(redact('just a normal sentence with no secrets')).toBe(
      'just a normal sentence with no secrets',
    );
  });

  describe('layer 1: literal env-value masking', () => {
    it('masks a known secret value with its label', () => {
      const out = redact('curl -H "auth: abcd1234efgh5678"', {
        envSecrets: { MY_TOKEN: 'abcd1234efgh5678' },
      });
      expect(out).toBe('curl -H "auth: <REDACTED:MY_TOKEN>"');
    });

    it('masks longer values before shorter overlapping ones', () => {
      const out = redact('value is abcdef123456789', {
        envSecrets: { SHORT: 'abcdef12', LONG: 'abcdef123456789' },
      });
      // The long value should win; no leftover fragment of the short one.
      expect(out).toBe('value is <REDACTED:LONG>');
    });

    it('replaces every occurrence of a value', () => {
      const out = redact('sekret9999 ... sekret9999', {
        envSecrets: { K: 'sekret9999' },
      });
      expect(out).toBe('<REDACTED:K> ... <REDACTED:K>');
    });
  });

  describe('layer 2: secret-shape patterns', () => {
    it('masks an Anthropic key without double-tagging as openai', () => {
      const out = redact('key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
      expect(out).toContain('<REDACTED:anthropic>');
      expect(out).not.toContain('sk-ant-');
      expect(out).not.toContain('<REDACTED:openai>');
    });

    it('masks an OpenAI key', () => {
      const out = redact('OPENAI=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX');
      expect(out).toContain('<REDACTED:openai>');
      expect(out).not.toContain('sk-proj-ABCDEFGH');
    });

    it('masks GitHub tokens and PATs', () => {
      expect(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toContain('<REDACTED:gh_tok>');
      expect(redact('github_pat_ABCDEFGHIJKLMNOPQRSTUV_wxyz0123456789')).toContain(
        '<REDACTED:gh_pat>',
      );
    });

    it('masks AWS access key ids', () => {
      expect(redact('id AKIAIOSFODNN7EXAMPLE done')).toBe('id <REDACTED:aws> done');
    });

    it('masks JWTs', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
      expect(redact(`token ${jwt}`)).toContain('<REDACTED:jwt>');
    });

    it('masks a PEM private-key block including its body', () => {
      const pem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----';
      const out = redact(`before\n${pem}\nafter`);
      expect(out).toBe('before\n<REDACTED:pem>\nafter');
    });

    it('masks Google API keys', () => {
      // AIza followed by exactly 35 chars.
      expect(redact('AIza' + 'B'.repeat(35))).toBe('<REDACTED:google>');
    });

    it('masks assorted vendor tokens via the provider pattern', () => {
      expect(redact('glpat-ABCDEFGHIJKLMNOPQRST')).toContain('<REDACTED:provider>');
      expect(redact('hf_ABCDEFGHIJKLMNOPQRSTUVWX')).toContain('<REDACTED:provider>');
    });

    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbody\n-----END RSA PRIVATE KEY-----';
    const jwtPrefixes = 'eyJ-'.repeat(25_000);
    const unendedPems = '-----BEGIN PRIVATE KEY-----\n'.repeat(40_000);

    it.each([
      ['JWT prefixes with no dot', `${jwtPrefixes} ${jwt}`, `${jwtPrefixes} <REDACTED:jwt>`],
      ['PEM headers with no END', `${pem}\n${unendedPems}`, `<REDACTED:pem>\n${unendedPems}`],
    ])('stays fast on %s and still masks a real one', (_shape, text, expected) => {
      const start = performance.now();
      const out = redact(text);
      const elapsed = performance.now() - start;

      expect(out).toBe(expected);
      // Linear work here is a few milliseconds; rescanning to the end from every prefix takes seconds.
      expect(elapsed).toBeLessThan(500);
    }, 30_000);
  });

  describe('layer 2: structural patterns keep surrounding context', () => {
    it('masks key=value but keeps the key', () => {
      const out = redact('password = hunter2SuperLongValue99');
      expect(out).toBe('password = <REDACTED:kv>');
    });

    it('masks bearer tokens but keeps the scheme', () => {
      const out = redact('Authorization: Bearer abcdefghijklmnopqrstuvwx');
      expect(out).toBe('Authorization: Bearer <REDACTED:authz>');
    });

    it('masks only the password in a connection string', () => {
      // Assemble the DSN from fragments at runtime so no contiguous
      // `user:password@host` shape ever appears in source. A repo secret-scanner
      // matches the DSN *shape* even in a test fixture (the `user:pass@host`
      // form tripped an internal mdb-client rule), so both the input and the
      // expected output are computed rather than written as string literals.
      const pw = ['pl', 'ace', 'holder', 'value'].join('');
      const dsn = ['redis://svc', pw].join(':') + '@' + 'cache.example.com:6379';
      const expected = dsn.replace(pw, '<REDACTED:conn>');
      expect(redact(dsn)).toBe(expected);
    });

    const pw = ['hun', 'ter2', 'pass'].join('');
    const dsn = ['postgres://user', pw].join(':') + '@' + 'db.example.com';

    it('masks a connection string whose scheme follows digits or punctuation', () => {
      for (const lead of ['', ' ', '1', '+', '9.x-']) {
        const text = `${lead}${dsn}`;
        expect(redact(text)).toBe(text.replace(pw, '<REDACTED:conn>'));
      }
    });

    it.each([
      ['a letter run', 'x'.repeat(100_000)],
      ['an alphanumeric run', 'a1'.repeat(50_000)],
    ])('stays fast on %s and still masks a connection string after it', (_shape, token) => {
      const text = `${token} ${dsn}`;

      const start = performance.now();
      const out = redact(text);
      const elapsed = performance.now() - start;

      expect(out).toBe(text.replace(pw, '<REDACTED:conn>'));
      // Linear work here is a few milliseconds; a per-offset rescan of the token takes seconds.
      expect(elapsed).toBeLessThan(500);
    }, 30_000);
  });

  it('can disable the pattern layer', () => {
    const out = redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', { patterns: false });
    expect(out).toBe('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('does not touch ordinary short values that merely look key-ish', () => {
    // Too short to trip the KV pattern's 16-char minimum.
    expect(redact('key=abc')).toBe('key=abc');
  });
});

describe('collectEnvSecrets', () => {
  it('selects secret-looking keys with long-enough values', () => {
    const secrets = collectEnvSecrets({
      MY_TOKEN: 'abcdefghij',
      DB_PASSWORD: 'longpassword',
      SERVICE_PAT: 'patvalue1234',
      PATH: '/usr/bin:/bin',
      HOME: '/root',
    });
    expect(secrets).toEqual({
      MY_TOKEN: 'abcdefghij',
      DB_PASSWORD: 'longpassword',
      SERVICE_PAT: 'patvalue1234',
    });
  });

  it('ignores secret-looking keys whose values are too short', () => {
    expect(collectEnvSecrets({ API_KEY: 'short' })).toEqual({});
  });

  it('ignores non-secret keys', () => {
    expect(collectEnvSecrets({ EDITOR: 'vim-with-a-long-config' })).toEqual({});
  });
});

describe('redactWithEnv on path-valued env vars', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-redact-'));
    fs.mkdirSync(path.join(dir, '.ssh'));
    for (const file of ['.ssh/id_ed25519', 'login.keychain-db', 'creds.json']) fs.writeFileSync(path.join(dir, file), '');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([
    ['SSH_KEY_PATH', false, () => path.join(dir, '.ssh', 'id_ed25519')],
    ['KEYCHAIN_PATH', false, () => path.join(dir, 'login.keychain-db')],
    ['GOOGLE_APPLICATION_CREDENTIALS', false, () => path.join(dir, 'creds.json')],
    ['SECRETS_DIR', false, () => dir],
    ['SIGNING_KEY_FILE', true, () => path.join(dir, 'missing.pem')],
    ['API_KEY', true, () => 'q1w2/e3r4+t5y6/u7i8o9p0=='],
    ['SESSION_SECRET', true, () => '/9j4AAQSkZJRgABAQ+a1b2c3=='],
  ])('%s value is masked: %s', (name, masked, value) => {
    const env = { [name]: value() };
    const text = `read ${value()} once`;
    expect(redactWithEnv(text, env)).toBe(masked ? `read <REDACTED:${name}> once` : text);
  });
});

describe('redactWithEnv', () => {
  it('composes env collection with pattern redaction', () => {
    const out = redactWithEnv('token=abcdefghij and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', {
      SOME_TOKEN: 'abcdefghij',
    } as NodeJS.ProcessEnv);
    expect(out).toContain('<REDACTED:SOME_TOKEN>');
    expect(out).toContain('<REDACTED:gh_tok>');
  });
});

describe('redactWithEnv on a fixed env', () => {
  // Fixtures are assembled at runtime so no token-shaped literal sits in source
  // for a repository secret scanner to flag.
  const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC';
  const ALPHA = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ';
  const HEX = '0f6c3e1a9b8d7c2e';
  const run = (chars: string, n: number): string => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);

  const env = {
    NODE_PATH: '/usr/local/lib/node_modules',
    GITHUB_PATH: '/home/runner/work/_temp/_runner_file_commands/add_path_0f6c3e1a',
    PKG_CONFIG_PATH: '/opt/homebrew/lib/pkgconfig',
    GITHUB_TOKEN: 'gh-actions-value-0001',
    SERVICE_PAT: 'pat-value-0002-abcd',
    OPENAI_API_KEY: 'api-key-value-0003',
  };

  it.each([
    ['a NODE_PATH value', `resolved from ${env.NODE_PATH}/teamai-cli`],
    ['a GITHUB_PATH value', `appended to ${env.GITHUB_PATH}`],
    ['a PKG_CONFIG_PATH value', `pkg-config searched ${env.PKG_CONFIG_PATH}`],
    ['an npm package env var name', 'set npm_package_devDependencies_typescript'],
    ['an hf_ directory name', 'cache in hf_transformers_cache_directory'],
    ['a Bearer scheme in prose', 'the Bearer authentication-scheme is required'],
    ['an sk- branch name', 'branch sk-feature-improve-retry-loop-x'],
    ['a 40-hex commit SHA', 'commit 3ef4e1884260306e2e733663d875096458f25503'],
    ['a sha256 integrity digest', 'integrity sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='],
    ['a plain base64 blob', 'dGhpcyBpcyBqdXN0IGJhc2U2NCBkYXRhIG5vdGhpbmcgc2VjcmV0'],
    ['a GitHub PR URL', 'https://github.com/Tencent/teamai-cli/pull/1084'],
  ])('leaves %s unchanged', (_name, text) => {
    expect(redactWithEnv(text, env)).toBe(text);
  });

  it.each([
    ['a PEM block', 'pem', ['-----BEGIN', 'PRIVATE KEY-----\n'].join(' ') + run(ALNUM, 64) + '\n' + ['-----END', 'PRIVATE KEY-----'].join(' ')],
    ['sk-ant-', 'anthropic', 'sk-ant-api03-' + run(ALNUM, 40) + '_' + run(ALNUM, 20)],
    ['sk-proj-', 'openai', 'sk-proj-' + run(ALNUM, 40) + '_' + run(ALNUM, 20) + '-' + run(ALNUM, 20)],
    ['sk-svcacct-', 'openai', 'sk-svcacct-' + run(ALNUM, 40) + '-' + run(ALNUM, 20)],
    ['sk-None-', 'openai', 'sk-None-' + run(ALNUM, 40) + '_' + run(ALNUM, 20)],
    ['sk-', 'openai', 'sk-' + run(ALNUM, 48)],
    ['github_pat_', 'gh_pat', 'github_pat_' + run(ALNUM, 22) + '_' + run(ALNUM, 59)],
    ['ghp_', 'gh_tok', 'ghp_' + run(ALNUM, 36)],
    ['AKIA', 'aws', 'AKIA' + run('Z7Q2X9W4', 16)],
    ['xoxb-', 'slack', 'xoxb-' + run('0123456789', 12) + '-' + run(ALNUM, 24)],
    ['a Slack webhook', 'slackhook', 'https://hooks.slack.com/services/' + ['T0A1B2C3D', 'B0A1B2C3D', run(ALNUM, 24)].join('/')],
    ['AIza', 'google', 'AIza' + run(ALNUM, 35)],
    ['ya29.', 'gcp_oauth', 'ya29.' + run(ALNUM, 40)],
    ['sk_live_', 'stripe', ['sk', 'live', run(ALNUM, 24)].join('_')],
    ['a JWT', 'jwt', ['eyJ' + run(ALNUM, 20), 'eyJ' + run(ALNUM, 20), run(ALNUM, 30)].join('.')],
    ['SG.', 'sendgrid', ['SG', run(ALNUM, 22), run(ALNUM, 43)].join('.')],
    ['xai-', 'provider', 'xai-' + run(ALNUM, 80)],
    ['gsk_', 'provider', 'gsk_' + run(ALNUM, 52)],
    ['pplx-', 'provider', 'pplx-' + run(ALNUM, 48)],
    ['sk-or-v1-', 'provider', 'sk-or-v1-' + run(HEX, 64)],
    ['hf_', 'provider', 'hf_' + run(ALPHA, 34)],
    ['dop_v1_', 'provider', 'dop_v1_' + run(HEX, 64)],
    ['glpat-', 'provider', 'glpat-' + run(ALNUM, 12) + '-' + run(ALNUM, 7)],
    ['npm_', 'provider', 'npm_' + run(ALNUM, 36)],
    ['shpat_', 'provider', 'shpat_' + run(HEX, 32)],
    ['tfp_', 'provider', 'tfp_' + run(ALNUM, 59)],
    ['nvapi-', 'provider', 'nvapi-' + run(ALNUM, 40) + '_' + run(ALNUM, 23)],
    ['r8_', 'provider', 'r8_' + run(ALNUM, 37)],
    ['a GITHUB_TOKEN value', 'GITHUB_TOKEN', env.GITHUB_TOKEN],
    ['a *_PAT value', 'SERVICE_PAT', env.SERVICE_PAT],
    ['an *_API_KEY value', 'OPENAI_API_KEY', env.OPENAI_API_KEY],
  ])('redacts a %s token as %s', (_name, label, secret) => {
    const text = `value ${secret} end`;
    expect(redactWithEnv(text, env)).toBe(`value <REDACTED:${label}> end`);
  });

  it('redacts an opaque Bearer token', () => {
    const text = `Authorization: Bearer ${run(ALNUM, 40)}`;
    expect(redactWithEnv(text, env)).toBe('Authorization: Bearer <REDACTED:authz>');
  });

  it('redacts a connection-string password', () => {
    const dsn = ['postgres://app', 'changeme'].join(':') + '@db:5432/app';
    expect(redactWithEnv(dsn, env)).toBe(dsn.replace('changeme', '<REDACTED:conn>'));
  });

  // A page cursor keyed by `nextPageToken` keeps being redacted: the kv rule
  // cannot tell it from `refreshToken: <value>` by key or by value shape.
  it('redacts a token-keyed value even when it is a page cursor', () => {
    expect(redactWithEnv('nextPageToken: CjQKEgoQbG9yZW0taXBzdW0tZG9sb3I', env)).toBe(
      'nextPageToken: <REDACTED:kv>',
    );
  });
});

describe('redactJson', () => {
  it('masks secrets in nested object keys and values', () => {
    const secret = 'known-private-value-1082';
    const value = { items: [{ [secret]: { value: secret } }] };
    expect(redactJson(value, { VALUE: secret })).toEqual({ items: [{ '<REDACTED:VALUE>': { value: '<REDACTED:VALUE>' } }] });
    expect(JSON.stringify(redactJson(value, { VALUE: secret }))).not.toContain(secret);
  });
});
