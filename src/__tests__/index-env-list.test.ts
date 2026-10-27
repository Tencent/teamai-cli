import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { loadCommandTable } from './helpers/command-table.js';
import type { LocalConfig } from '../types.js';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

describe('env listing command options (#1432)', () => {
  let tmpDir: string;
  let output: ReturnType<typeof vi.spyOn>;
  let warnings: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-list-options-'));
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'),
      'variables:\n  - key: DEMO_URI\n    value: plain-default-value\n    description: Demo endpoint\n');
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'),
      'secrets:\n  - key: DEMO_SECRET\n');
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.example.com/team/t.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    const { requireInit } = await import('../config.js');
    vi.mocked(requireInit).mockResolvedValue({
      localConfig,
      teamConfig: {
        team: 'test', description: '', repo: localConfig.repo.remote, provider: 'git', reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: {},
      },
    });
    const { getTeamSecretsPath, writeSecretStore } = await import('../secret-store.js');
    await writeSecretStore(getTeamSecretsPath(localConfig), {
      DEMO_SECRET: { value: 'fixture-secret-value', kind: 'secret' },
    });
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnings = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it.each([
    { args: ['env'], reveal: false, positional: false },
    { args: ['env', 'list'], reveal: false, positional: false },
    { args: ['env', '--reveal'], reveal: true, positional: false },
    { args: ['env', 'list', '--reveal'], reveal: true, positional: false },
    { args: ['env', '--reveal', 'list'], reveal: true, positional: false },
    { args: ['env', 'list', '--reveal'], reveal: true, positional: true },
  ])('$args (positional options: $positional) reveals variables: $reveal', async ({ args, reveal, positional }) => {
    const program = await loadCommandTable();
    if (positional) {
      program.enablePositionalOptions();
      program.commands.find((command) => command.name() === 'env')!.enablePositionalOptions();
    }
    await program.parseAsync(['node', 'teamai', '--verbose', ...args]);

    const text = output.mock.calls.map(([line]) => String(line)).join('\n');
    expect(text).toContain(`DEMO_URI=${reveal ? 'plain-default-value' : 'pl****'}  env.yaml  (root)`);
    expect(text).toContain('Demo endpoint');
    expect(text).toContain('DEMO_SECRET  team  (root)');
    expect(text).not.toContain('fixture-secret-value');
    if (!reveal) expect(text).not.toContain('plain-default-value');
    const stderr = warnings.mock.calls.map(([line]) => String(line)).join('');
    expect(stderr.includes('Env values will be shown in plaintext')).toBe(reveal);
  });
});
