import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  screenText,
  findHitLines,
  looksBinary,
  screenPushItems,
  formatSecretHits,
  MAX_REPORTED_LINES,
  MAX_REPORTED_FILES,
} from '../utils/secret-screen.js';

const CLEAN = 'Use the deploy helper to roll out the staging cluster on Tuesdays.\n';
const GH_PAT = 'github_pat_A1B2C3D4E5F6G7H8I9J0K1L2M3';
const GH_PAT_TEXT = `Before you ship, rotate the token:\nGITHUB_TOKEN=${GH_PAT}\nAnd carry on.\n`;
const ENV = { GITHUB_TOKEN: 'ghsup3rs3cretvalue99' };
const ENV_TEXT = 'export GITHUB_TOKEN=ghsup3rs3cretvalue99\n';
// The docs case the verdict tiers exist for (#2023 review): a placeholder in
// honest documentation must not block a push.
const KV_DOCS = 'Use `token: example-abcdef-123456` as the placeholder value.\n';

describe('screenText tiers', () => {
  it('passes clean prose through', () => {
    expect(screenText(CLEAN, ENV)).toBeNull();
    expect(screenText('', ENV)).toBeNull();
  });

  it('refuses precise secret shapes', () => {
    expect(screenText(`token: ${GH_PAT}`, {})).toBe('refuse');
    expect(screenText('Bearer A1b2C3d4E5f6G7h8I9j0K1l2', {})).toBe('refuse');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAbC\n123\n-----END RSA PRIVATE KEY-----\n';
    expect(screenText(pem, {})).toBe('refuse');
  });

  it('warns on key=value pairs, including the docs placeholder case', () => {
    expect(screenText('password = "AbCdEf1234567890123"', {})).toBe('warn');
    expect(screenText(KV_DOCS, {})).toBe('warn');
  });

  it('warns on a literal environment value', () => {
    expect(screenText(ENV_TEXT, ENV)).toBe('warn');
  });
});

describe('review-bot cases: passedOver and prose (#2071)', () => {
  it('a bare JWT header without segments is not a secret', () => {
    expect(screenText('see eyJhbGciOiJIUzI1NiJ9 in the docs', {})).toBeNull();
  });

  it('a lone BEGIN line without its END is not a secret', () => {
    expect(screenText('the block starts with -----BEGIN RSA PRIVATE KEY----- and nothing else', {})).toBeNull();
  });

  it('bearer prose is not a secret', () => {
    expect(screenText('Bearer authentication-scheme is standard here', {})).toBeNull();
  });

  it('bearer prose in front does not hide a real token behind it (#2071 review)', () => {
    expect(screenText('Bearer authentication-scheme is standard\n\nAuthorization: Bearer A1b2C3d4E5f6G7h8I9j0K1l2', {})).toBe('refuse');
  });

  it('a PEM block longer than any window still gets its BEGIN line reported (#2071 review)', () => {
    const lines = [
      'Some prose about the key file.',
      'More prose.',
      '-----BEGIN RSA PRIVATE KEY-----',
      ...Array.from({ length: 38 }, (_, i) => `MII${i}${'AbC123+/='.repeat(30)}`),
      '-----END RSA PRIVATE KEY-----',
      'Trailing prose.',
    ];
    const pem = `${lines.join('\n')}\n`;

    expect(screenText(pem, {})).toBe('refuse');
    expect(findHitLines(pem, {}, 'refuse')).toEqual([3]);
  });

  it('a real three-segment JWT still refuses', () => {
    expect(screenText('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', {})).toBe('refuse');
  });

  it('the report cap never hides a refusal behind warnings', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-cap-scan-'));
    const skillDir = path.join(base, 'many-warnings');
    await fs.mkdir(path.join(skillDir, 'zzz'), { recursive: true });

    for (let i = 0; i < 22; i++) {
      await fs.writeFile(path.join(skillDir, `doc-${String(i).padStart(2, '0')}.md`), KV_DOCS);
    }

    await fs.writeFile(path.join(skillDir, 'zzz', 'rotate.md'), GH_PAT_TEXT);

    const result = await screenPushItems(
      [{ type: 'skills', relativePath: 'skills/many-warnings', sourcePath: skillDir }],
      {},
    );

    // The refusal sits behind 22 warnings in scan order and must still decide the verdict.
    expect(result.refusalCount).toBe(1);
    expect(result.warnCount).toBe(22);
    expect(result.hits.some((hit) => hit.tier === 'refuse')).toBe(true);
    expect(result.hits.filter((hit) => hit.tier === 'warn')).toHaveLength(MAX_REPORTED_FILES);
    await fs.rm(base, { recursive: true, force: true });
  });
});

describe('findHitLines', () => {
  it('reports 1-based line numbers for single-line hits', () => {
    expect(findHitLines(GH_PAT_TEXT, {}, 'refuse')).toEqual([2]);
  });

  it('caps the report length', () => {
    const many = Array.from({ length: 20 }, (_, i) => `password = "AbCdEf1234567890${i}12345"`).join('\n');
    expect(findHitLines(many, {}, 'warn')).toHaveLength(MAX_REPORTED_LINES);
  });

  it('points at the first line of a multi-line block when no single line hits', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nAbC\n123\n-----END RSA PRIVATE KEY-----\n';
    const lines = findHitLines(pem, {}, 'refuse');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toBe(1);
  });

  it('returns nothing for clean text', () => {
    expect(findHitLines(CLEAN, ENV, 'refuse')).toEqual([]);
  });
});

describe('review-bot round three: report localization (#2071)', () => {
  it('a warning line never hides where the refusal sits', () => {
    const mixed = `Use token: example-abcdef-123456 as the placeholder.\n\n${Array.from({ length: 7 }, (_, i) => `filler line ${i}`).join('\n')}\n\n-----BEGIN RSA PRIVATE KEY-----\nAbC\n123\n-----END RSA PRIVATE KEY-----\n`;

    expect(screenText(mixed, {})).toBe('refuse');
    expect(findHitLines(mixed, {}, 'refuse')).toEqual([11]);
    expect(findHitLines(mixed, {}, 'warn')).toEqual([1]);
  });

  it('the probe budget does not starve larger windows in long files', () => {
    const lines = [
      'prose',
      'prose',
      '-----BEGIN RSA PRIVATE KEY-----',
      ...Array.from({ length: 38 }, (_, i) => `MII${i}${'AbC123+/='.repeat(30)}`),
      '-----END RSA PRIVATE KEY-----',
      ...Array.from({ length: 455 }, (_, i) => `plain line ${i}`),
    ];
    const text = `${lines.join('\n')}\n`;

    expect(screenText(text, {})).toBe('refuse');
    expect(findHitLines(text, {}, 'refuse')).toEqual([3]);
  });
});

describe('looksBinary', () => {
  it('sniffs NUL bytes', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x0d]))).toBe(true);
    expect(looksBinary(Buffer.from('# just markdown\n'))).toBe(false);
  });
});

describe('screenPushItems', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-secret-screen-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('screens every text file of a skill directory and reports team-relative paths', async () => {
    const skillDir = path.join(tmp, 'deploy-helper');
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), CLEAN);
    await fs.writeFile(path.join(skillDir, 'references', 'rotate.md'), GH_PAT_TEXT);

    const result = await screenPushItems(
      [{ type: 'skills', relativePath: 'skills/deploy-helper', sourcePath: skillDir }],
      {},
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].file).toBe('skills/deploy-helper/references/rotate.md');
    expect(result.hits[0].lines).toEqual([2]);
    expect(result.hits[0].tier).toBe('refuse');
    expect(result.hits[0].labels).toContain('gh_pat');
    expect(result.refusalCount).toBe(1);
    expect(result.warnCount).toBe(0);
  });

  it('skips binary files and reports them nowhere', async () => {
    const skillDir = path.join(tmp, 'logo-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x0d]));
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), CLEAN);

    expect(await screenPushItems(
      [{ type: 'skills', relativePath: 'skills/logo-skill', sourcePath: skillDir }],
      {},
    ).then((result) => result.hits)).toEqual([]);
  });

  it('never screens env resources: they are credential-bearing by design', async () => {
    const envFile = path.join(tmp, 'prod.env');
    await fs.writeFile(envFile, ENV_TEXT);

    expect(await screenPushItems(
      [{ type: 'env', relativePath: 'env/prod.env', sourcePath: envFile }],
      {},
    ).then((result) => result.hits)).toEqual([]);
  });

  it('tiers a token-carrying rule as refuse and a docs placeholder as warn', async () => {
    const tokenRule = path.join(tmp, 'rotate.md');
    await fs.writeFile(tokenRule, GH_PAT_TEXT);
    const docsRule = path.join(tmp, 'docs.md');
    await fs.writeFile(docsRule, KV_DOCS);

    const result = await screenPushItems(
      [
        { type: 'rules', relativePath: 'rules/rotate.md', sourcePath: tokenRule },
        { type: 'rules', relativePath: 'rules/docs.md', sourcePath: docsRule },
      ],
      {},
    );

    expect(result.hits.find((hit) => hit.file === 'rules/rotate.md')?.tier).toBe('refuse');
    expect(result.hits.find((hit) => hit.file === 'rules/docs.md')?.tier).toBe('warn');
  });

  it('returns no hits when everything is clean', async () => {
    const skillDir = path.join(tmp, 'clean-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), CLEAN);

    expect(await screenPushItems(
      [{ type: 'skills', relativePath: 'skills/clean-skill', sourcePath: skillDir }],
      {},
    ).then((result) => result.hits)).toEqual([]);
  });
});

describe('formatSecretHits', () => {
  it('renders refuse lines with the matched labels', () => {
    const lines = formatSecretHits([{ file: 'skills/x/bad.md', lines: [2, 9], tier: 'refuse', labels: ['gh_pat'] }]);
    expect(lines).toEqual([
      { line: '  skills/x/bad.md: secret shape (gh_pat) at line 2, 9', tier: 'refuse' },
    ]);
  });

  it('renders warn lines as possible secrets', () => {
    const lines = formatSecretHits([{ file: 'rules/docs.md', lines: [1], tier: 'warn', labels: ['kv'] }]);
    expect(lines).toEqual([
      { line: '  rules/docs.md: possible secret (kv) at line 1', tier: 'warn' },
    ]);
  });
});
