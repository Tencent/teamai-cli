import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  autoDetectInit: vi.fn(),
  npmInstall: vi.fn(),
  npmSnapshot: vi.fn(),
  npmStatus: vi.fn(),
  claudeInstall: vi.fn(),
  claudeSnapshot: vi.fn(),
  claudeStatus: vi.fn(),
  claudeMarketplaceStatus: vi.fn(),
  detectPackageEnvironment: vi.fn(),
  registeredMarketplaces: vi.fn(),
  assertNotReadOnly: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: mocks.autoDetectInit,
}));

vi.mock('../read-only.js', () => ({
  assertNotReadOnly: mocks.assertNotReadOnly,
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../pkg/adapters/npm.js', () => ({
  NpmAdapter: class {
    validate = vi.fn().mockResolvedValue({ valid: true, errors: [] });
    install = mocks.npmInstall;
    snapshot = mocks.npmSnapshot;
    status = mocks.npmStatus;
  },
}));

vi.mock('../pkg/adapters/claude-plugin.js', () => ({
  marketplaceSourceLocation: (item: { repo?: string; url?: string; path?: string }) =>
    item.repo ?? item.url ?? item.path,
  ClaudePluginAdapter: class {
    validate = vi.fn().mockResolvedValue({ valid: true, errors: [] });
    registeredMarketplaces = mocks.registeredMarketplaces;
    install = mocks.claudeInstall;
    snapshot = mocks.claudeSnapshot;
    status = mocks.claudeStatus;
    marketplaceStatus = mocks.claudeMarketplaceStatus;
  },
}));

vi.mock('../pkg/env-detect.js', () => ({
  detectPackageEnvironment: mocks.detectPackageEnvironment,
}));

import { pkgDoctorReport, pkgInstall } from '../pkg/commands.js';
import {
  loadPackageLock,
  loadPackageManifest,
  packageDeclarationHash,
  packageProjectKey,
  projectNpmDeclarationHash,
  sharedPackageDeclarationHash,
} from '../pkg/manifest.js';
import { LocalConfigSchema } from '../types.js';

describe('pkgInstall npm target options', () => {
  let teamRepo: string;
  let projectRoot: string;
  let userHome: string;
  let previousCwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    teamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-command-repo-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-command-project-'));
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-command-home-'));
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    process.env.HOME = userHome;
    process.chdir(projectRoot);
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
    }));
    mocks.autoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
        username: 'alice',
        scope: 'project',
        projectRoot,
      },
      teamConfig: {},
    });
    mocks.npmInstall.mockResolvedValue([{
      name: '@tencent/tokenlint',
      version: '1.3.3',
      source: 'npm',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }]);
    mocks.npmSnapshot.mockResolvedValue([{
      name: '@tencent/tokenlint',
      version: '1.3.3',
      source: 'npm',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }]);
    mocks.claudeInstall.mockResolvedValue({ marketplaces: [], plugins: [] });
    mocks.claudeSnapshot.mockResolvedValue({ marketplaces: [], plugins: [] });
    mocks.npmStatus.mockResolvedValue([]);
    mocks.claudeStatus.mockResolvedValue([]);
    mocks.claudeMarketplaceStatus.mockResolvedValue([]);
    mocks.detectPackageEnvironment.mockResolvedValue([
      { name: 'Node', version: '22.0.0', available: true },
      { name: 'npm', version: '10.0.0', available: true },
      { name: 'Claude Code', version: '2.1.0', available: true },
    ]);
    mocks.registeredMarketplaces.mockResolvedValue([]);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    vi.clearAllMocks();
    fs.rmSync(teamRepo, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it('installs a global target and persists global/registry in teamai.yaml', async () => {
    await pkgInstall('@tencent/tokenlint@latest', {
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    });

    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{
        name: '@tencent/tokenlint',
        version: 'latest',
        global: true,
        registry: 'https://mirrors.tencent.com/npm/',
      }],
      expect.objectContaining({
        cwd: expect.stringContaining(path.basename(projectRoot)),
        scope: 'project',
      }),
    );
    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages.npm).toEqual([{
      name: '@tencent/tokenlint',
      version: 'latest',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }]);
    expect((await loadPackageLock(path.join(projectRoot, '.teamai')))
      ?.packages.npm?.[0]).toMatchObject({
      name: '@tencent/tokenlint',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    });
    expect((await loadPackageLock(path.join(projectRoot, '.teamai')))
      ?.declarationHash).toBeUndefined();
    expect(fs.readFileSync(path.join(projectRoot, '.teamai', '.gitignore'), 'utf8'))
      .toContain('teamai.lock');
    expect(mocks.assertNotReadOnly).toHaveBeenCalled();
  });

  it('preserves an existing version when the target omits one', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [{ name: 'typescript', version: '5.7.3' }],
      },
    }));

    await pkgInstall('typescript', {});

    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{ name: 'typescript', version: '5.7.3' }],
      expect.objectContaining({ scope: 'project' }),
    );
    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages.npm).toEqual([{ name: 'typescript', version: '5.7.3' }]);
  });

  it('updates an existing version when the target specifies one', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [{ name: 'typescript', version: '5.7.3' }],
      },
    }));

    await pkgInstall('typescript@latest', { npm: true });

    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{ name: 'typescript', version: 'latest' }],
      expect.objectContaining({ scope: 'project' }),
    );
    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages.npm).toEqual([{ name: 'typescript', version: 'latest' }]);
  });

  it('restores a declared global tool when teammates run install without a target', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [{
          name: '@tencent/tokenlint',
          version: 'latest',
          global: true,
          registry: 'https://mirrors.tencent.com/npm/',
        }],
      },
    }));

    await pkgInstall(undefined, {});

    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{
        name: '@tencent/tokenlint',
        version: 'latest',
        global: true,
        registry: 'https://mirrors.tencent.com/npm/',
      }],
      expect.objectContaining({ scope: 'project' }),
    );
    const manifest = await loadPackageManifest(teamRepo);
    expect((await loadPackageLock(path.join(projectRoot, '.teamai')))
      ?.declarationHash).toBe(packageDeclarationHash(manifest));
  });

  it('rejects target-only npm flags when no target is provided', async () => {
    await expect(pkgInstall(undefined, { global: true }))
      .rejects.toThrow('require a package target');
    expect(mocks.npmInstall).not.toHaveBeenCalled();
  });

  it('fails closed for an ambiguous unregistered plugin-or-npm target', async () => {
    await expect(pkgInstall('deploy-tools@acme-tools', {}))
      .rejects.toThrow('Ambiguous target');
    expect(mocks.npmInstall).not.toHaveBeenCalled();
    expect(mocks.claudeInstall).not.toHaveBeenCalled();
  });

  it('uses --npm to resolve a versioned npm target without querying Claude', async () => {
    await pkgInstall('typescript@latest', { npm: true, dryRun: true });

    expect(mocks.registeredMarketplaces).not.toHaveBeenCalled();
    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{ name: 'typescript', version: 'latest' }],
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('requires plugin@marketplace syntax when --claude is explicit', async () => {
    await expect(pkgInstall('deploy-tools', { claude: true }))
      .rejects.toThrow('plugin@marketplace');
    expect(mocks.npmInstall).not.toHaveBeenCalled();
    expect(mocks.claudeInstall).not.toHaveBeenCalled();
  });

  it('records git marketplace URLs rather than their source kind', async () => {
    mocks.registeredMarketplaces.mockResolvedValue([{
      name: 'acme-tools',
      source: 'git',
      url: 'https://github.com/acme/plugins.git',
    }]);

    await pkgInstall('deploy-tools@acme-tools', { claude: true });

    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages.claude.marketplaces).toEqual([{
      name: 'acme-tools',
      repo: 'https://github.com/acme/plugins.git',
    }]);
  });

  it('tracks user-scope local npm acknowledgement per project', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [
          { name: 'typescript', version: '^5.9.0' },
          { name: 'eslint', version: 'latest', global: true },
        ],
      },
    }));
    mocks.autoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
        username: 'alice',
        scope: 'user',
      },
      teamConfig: {},
    });

    await pkgInstall(undefined, {});

    const manifest = await loadPackageManifest(teamRepo);
    const lock = await loadPackageLock(path.join(process.env.HOME!, '.teamai'));
    expect(lock?.declarationHash).toBe(sharedPackageDeclarationHash(manifest));
    expect(lock?.projectDeclarationHashes?.[packageProjectKey(projectRoot)])
      .toBe(projectNpmDeclarationHash(manifest));
    expect(lock?.declarationHash).not.toBe(packageDeclarationHash(manifest));
  });

  it('does not snapshot or write files for a global npm target in dry-run mode', async () => {
    await pkgInstall('typescript@latest', { global: true, dryRun: true });

    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [{ name: 'typescript', version: 'latest', global: true }],
      expect.objectContaining({ dryRun: true }),
    );
    expect(mocks.npmSnapshot).not.toHaveBeenCalled();
    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages).toBeUndefined();
    expect(await loadPackageLock(path.join(projectRoot, '.teamai'))).toBeNull();
  });

  it('does not snapshot or write files for a Claude target in dry-run mode', async () => {
    await pkgInstall('code-review@claude-plugins-official', { dryRun: true });

    expect(mocks.claudeInstall).toHaveBeenCalledWith(
      {
        marketplaces: [{
          name: 'claude-plugins-official',
          repo: 'anthropics/claude-plugins-official',
        }],
        plugins: [{ name: 'code-review@claude-plugins-official' }],
      },
      expect.objectContaining({ dryRun: true }),
    );
    expect(mocks.claudeSnapshot).not.toHaveBeenCalled();
    const raw = YAML.parse(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8'));
    expect(raw.packages).toBeUndefined();
    expect(await loadPackageLock(path.join(projectRoot, '.teamai'))).toBeNull();
  });

  it('does not add a package failure when teamai.yaml is absent', async () => {
    fs.rmSync(path.join(teamRepo, 'teamai.yaml'));
    const report = await pkgDoctorReport(LocalConfigSchema.parse({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'project',
      projectRoot,
    }), projectRoot);
    expect(report).toBeNull();
  });

  it('shows the declared and installed npm versions when doctor finds a mismatch', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      packages: { npm: [{ name: 'typescript', version: '^5.9.0' }] },
    }));
    mocks.npmStatus.mockResolvedValue([{
      name: 'typescript',
      installed: false,
      version: '4.9.5',
      detail: 'declared ^5.9.0, installed 4.9.5',
    }]);

    const report = await pkgDoctorReport(LocalConfigSchema.parse({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'project',
      projectRoot,
    }), projectRoot);

    expect(report?.allPassed).toBe(false);
    expect(report?.lines.join('\n')).toContain('declared ^5.9.0, installed 4.9.5');
  });

  it('fails doctor when a marketplace-only declaration is not registered', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      packages: {
        claude: {
          marketplaces: [{ name: 'acme', repo: 'acme/plugins' }],
          plugins: [],
        },
      },
    }));
    mocks.detectPackageEnvironment.mockResolvedValue([
      { name: 'Node', version: '22.0.0', available: true },
      { name: 'npm', version: '10.0.0', available: true },
      { name: 'Claude Code', version: '', available: false },
    ]);
    mocks.claudeMarketplaceStatus.mockResolvedValue([{
      name: 'acme',
      installed: false,
      detail: 'declared but not registered',
    }]);

    const report = await pkgDoctorReport(LocalConfigSchema.parse({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'project',
      projectRoot,
    }), projectRoot);

    expect(report?.allPassed).toBe(false);
    expect(report?.lines.join('\n')).toContain('Claude Code');
    expect(report?.lines.join('\n')).toContain('Claude marketplaces');
    expect(report?.lines.join('\n')).toContain('declared but not registered');
  });

  it('fails doctor when an installed Claude plugin has the wrong version', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      packages: {
        claude: {
          marketplaces: [{ name: 'acme', repo: 'acme/plugins' }],
          plugins: [{ name: 'lint@acme', version: '2.0.0' }],
        },
      },
    }));
    mocks.claudeMarketplaceStatus.mockResolvedValue([{
      name: 'acme',
      installed: true,
      detail: 'acme/plugins',
    }]);
    mocks.claudeStatus.mockResolvedValue([{
      name: 'lint@acme',
      installed: false,
      version: '1.0.0',
      enabled: true,
      detail: 'declared 2.0.0, installed 1.0.0',
    }]);

    const report = await pkgDoctorReport(LocalConfigSchema.parse({
      repo: { localPath: teamRepo, remote: 'x', kind: 'git' },
      username: 'alice',
      scope: 'project',
      projectRoot,
    }), projectRoot);

    expect(report?.allPassed).toBe(false);
    expect(report?.lines.join('\n')).toContain('✖ lint@acme');
    expect(report?.lines.join('\n')).toContain('declared 2.0.0, installed 1.0.0');
  });
});
