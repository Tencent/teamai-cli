import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDetectProjectConfig, mockLoadLocalConfig } = vi.hoisted(() => ({
  mockDetectProjectConfig: vi.fn(),
  mockLoadLocalConfig: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: mockDetectProjectConfig,
  loadLocalConfig: mockLoadLocalConfig,
}));

vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn() },
}));

import {
  claimPackageHintOutput,
  computePackageHintOutput,
  packageManifestHashForCwd,
  stashPackageHintAfterPull,
  takePendingPackageHint,
} from '../pkg/pkg-hint.js';
import {
  loadPackageManifest,
  packageDeclarationHash,
  packageProjectKey,
  projectNpmDeclarationHash,
  savePackageLock,
  sharedPackageDeclarationHash,
} from '../pkg/manifest.js';

describe('package SessionStart hint', () => {
  let cwd: string;
  let teamRepo: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-hint-cwd-'));
    teamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-hint-repo-'));
    previousHome = process.env.HOME;
    process.env.HOME = cwd;
    mockDetectProjectConfig.mockResolvedValue({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'project',
      projectRoot: cwd,
    });
    mockLoadLocalConfig.mockResolvedValue(null);
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      packages: {
        npm: [{ name: 'typescript', version: '*' }],
      },
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(teamRepo, { recursive: true, force: true });
  });

  it('hints when the local lock is missing or stale', async () => {
    const output = await computePackageHintOutput(cwd);
    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('teamai packages');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('never installs');
  });

  it('stays silent after install records the current declaration hash', async () => {
    const manifest = await loadPackageManifest(teamRepo);
    await savePackageLock(path.join(cwd, '.teamai'), {
      version: 1,
      declarationHash: packageDeclarationHash(manifest),
      packages: { npm: [{ name: 'typescript', version: '5.9.2', source: 'npm' }] },
    });

    expect(await computePackageHintOutput(cwd)).toBeNull();
  });

  it('requires user-scope local npm declarations to be acknowledged per project', async () => {
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-hint-other-'));
    mockDetectProjectConfig.mockResolvedValue(null);
    mockLoadLocalConfig.mockResolvedValue({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'user',
    });
    const manifest = await loadPackageManifest(teamRepo);
    await savePackageLock(path.join(cwd, '.teamai'), {
      version: 1,
      declarationHash: sharedPackageDeclarationHash(manifest),
      projectDeclarationHashes: {
        [packageProjectKey(cwd)]: projectNpmDeclarationHash(manifest)!,
      },
      packages: {},
    });

    try {
      expect(await computePackageHintOutput(cwd)).toBeNull();
      expect(await computePackageHintOutput(otherProject)).toContain('teamai packages');
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it('stashes a changed declaration from background pull for one prompt delivery', async () => {
    const manifest = await loadPackageManifest(teamRepo);
    await savePackageLock(path.join(cwd, '.teamai'), {
      version: 1,
      declarationHash: packageDeclarationHash(manifest),
      packages: {},
    });
    const beforeHash = await packageManifestHashForCwd(cwd);
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      packages: {
        npm: [{ name: 'typescript', version: '^6.0.0' }],
      },
    }));

    await stashPackageHintAfterPull(cwd, 'session-1', beforeHash);

    expect(await claimPackageHintOutput(cwd, 'session-1')).toBeNull();
    expect(await takePendingPackageHint('session-1')).toContain('teamai packages');
    expect(await takePendingPackageHint('session-1')).toBeNull();
  });
});
