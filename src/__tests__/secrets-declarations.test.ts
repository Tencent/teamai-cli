import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { describeEntryFailure } from '../namespaced-entries.js';
import { resolveSecretDeclarations } from '../resources/secrets.js';
import type { LocalConfig } from '../types.js';

/**
 * `env/secrets.yaml` and `env/<ns>/secrets.yaml` (#875): declared keys, no
 * values, resolved like env.yaml, with absent, valid and failed kept apart.
 */
describe('team secret declarations', () => {
  let repoPath: string;

  const config = (projects?: string[]): LocalConfig => ({
    repo: { localPath: repoPath, remote: 'owner/repo' }, username: 't', scope: 'user', additionalRoles: [],
    ...(projects ? { projects } : {}),
  });
  const write = (relativePath: string, content: string): Promise<void> =>
    fse.outputFile(path.join(repoPath, ...relativePath.split('/')), content);

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-secrets-'));
  });
  afterEach(async () => {
    await fse.remove(repoPath);
  });

  it('resolves the root file and the namespaces resources.env activates, a namespace entry replacing the root one', async () => {
    await write('manifest/projects.yaml', [
      'version: 1',
      'projects:',
      '  - { id: checkout, resources: { env: [checkout], mcp: [billing] } }',
      '  - { id: billing, resources: { env: [billing] } }',
      '',
    ].join('\n'));
    await write('env/secrets.yaml', [
      'secrets:',
      '  - { key: GITHUB_TOKEN, description: root token, url: https://github.com/settings/tokens }',
      '  - { key: NPM_TOKEN }',
      '',
    ].join('\n'));
    await write('env/checkout/secrets.yaml', 'secrets:\n  - { key: GITHUB_TOKEN, description: checkout token }\n');
    await write('env/billing/secrets.yaml', 'secrets:\n  - { key: BILLING_TOKEN }\n');

    const declarations = await resolveSecretDeclarations(config(['checkout']));

    expect(declarations.kind).toBe('resolved');
    if (declarations.kind !== 'resolved') return;
    expect(declarations.entries.map(({ name, entry, source, replaces }) => ({ name, entry, source, replaces }))).toEqual([
      { name: 'GITHUB_TOKEN', entry: { key: 'GITHUB_TOKEN', description: 'checkout token' }, source: 'env/checkout/secrets.yaml', replaces: 'env/secrets.yaml' },
      { name: 'NPM_TOKEN', entry: { key: 'NPM_TOKEN' }, source: 'env/secrets.yaml', replaces: null },
    ]);
  });

  it('uses the active namespaces it is given, as pull passes env\'s', async () => {
    await write('env/secrets.yaml', 'secrets:\n  - { key: A }\n');
    await write('env/billing/secrets.yaml', 'secrets:\n  - { key: B }\n');

    const declarations = await resolveSecretDeclarations(config(), { active: ['billing'] });

    expect(declarations.kind === 'resolved' && declarations.entries.map((entry) => entry.name)).toEqual(['A', 'B']);
  });

  it('is absent when no file it reads exists, and valid when a file declares none', async () => {
    await write('env/env.yaml', 'variables:\n  - { key: PLAIN, value: x }\n');
    expect(await resolveSecretDeclarations(config())).toEqual({ kind: 'absent' });

    // A file in a namespace that is not active here is not read.
    await write('env/billing/secrets.yaml', 'secrets:\n  - { key: B }\n');
    expect(await resolveSecretDeclarations(config())).toEqual({ kind: 'absent' });

    for (const content of ['', 'secrets: []\n']) {
      await write('env/secrets.yaml', content);
      const declarations = await resolveSecretDeclarations(config());
      expect(declarations.kind === 'resolved' && declarations.entries).toEqual([]);
    }
  });

  it.each([
    ['not YAML', 'secrets: [\n', 'env/secrets.yaml is not valid YAML'],
    ['no secrets: key', 'secret:\n  - { key: A }\n', 'env/secrets.yaml declares no secrets: it has no top-level `secrets:` key, only `secret`'],
    ['an entry without a key', 'secrets:\n  - { description: x }\n', 'env/secrets.yaml does not match the secrets.yaml schema: secrets.0.key: Required'],
    ['a key that is no variable name', 'secrets:\n  - { key: MY-TOKEN }\n', 'secrets.0.key: must be a shell variable name'],
    ['secrets: not a list', 'secrets: GITHUB_TOKEN\n', 'env/secrets.yaml does not match the secrets.yaml schema: secrets: Expected array'],
  ])('fails, in secret wording, on %s', async (_label, content, reason) => {
    await write('env/secrets.yaml', content);

    const declarations = await resolveSecretDeclarations(config());

    expect(declarations.kind).toBe('failed');
    if (declarations.kind !== 'failed') return;
    const message = describeEntryFailure(declarations.failure);
    expect(message).toContain(reason);
    expect(message).toContain('Team secrets were not resolved this run; env variables and MCP servers stay as they are. Fix the file in the team repo and push.');
  });

  it('fails when a namespace file repeats a key, naming it a secret', async () => {
    await write('env/secrets.yaml', 'secrets:\n  - { key: A }\n  - { key: A }\n');

    const declarations = await resolveSecretDeclarations(config(), { active: [] });

    expect(declarations.kind === 'failed' && describeEntryFailure(declarations.failure)).toBe(
      'env/secrets.yaml defines secret "A" more than once. Team secrets were not resolved this run; env variables and MCP servers stay as they are. '
        + 'Keep one of them in the team repo and push.',
    );
  });

  it('does not declare a secret written with a value, and says why', async () => {
    await write('env/secrets.yaml', 'secrets:\n  - { key: A, value: committed }\n  - { key: B }\n');

    const declarations = await resolveSecretDeclarations(config());

    expect(declarations.kind).toBe('resolved');
    if (declarations.kind !== 'resolved') return;
    expect(declarations.entries.map((entry) => entry.name)).toEqual(['B']);
    expect(declarations.notices.map((notice) => notice.message)).toEqual([
      'env/secrets.yaml: secret "A" has unknown key `value:`, so this entry is not delivered. Correct the key or remove it.',
    ]);
  });
});
