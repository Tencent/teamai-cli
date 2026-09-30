import { getTeamaiHome, type GlobalOptions, type LocalConfig } from '../types.js';
import { autoDetectInit } from '../config.js';
import { assertNotReadOnly } from '../read-only.js';
import { pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import {
  ClaudePluginAdapter,
  marketplaceSourceLocation,
} from './adapters/claude-plugin.js';
import { NpmAdapter } from './adapters/npm.js';
import type { PackageInstallContext } from './adapters/base.js';
import { detectPackageEnvironment } from './env-detect.js';
import {
  ensurePackageLockIgnored,
  hasPackageDeclarations,
  loadPackageLock,
  loadPackageManifest,
  packageDeclarationHash,
  packageManifestPath,
  packageProjectKey,
  projectNpmDeclarationHash,
  savePackageLock,
  savePackageManifest,
  sharedPackageDeclarationHash,
} from './manifest.js';
import type {
  ClaudeMarketplace,
  NpmSpec,
  PackageLock,
  PackageManifest,
} from './types.js';
import { PackageManifestSchema } from './types.js';

const OFFICIAL_MARKETPLACES: Record<string, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
};

interface ParsedNpmTarget {
  name: string;
  version?: string;
}

function parseNpmTarget(target: string): ParsedNpmTarget {
  if (target.startsWith('@')) {
    const slash = target.indexOf('/');
    const separator = target.lastIndexOf('@');
    if (slash < 0) throw new Error(`Invalid scoped npm package: "${target}"`);
    const version = separator > slash ? target.slice(separator + 1) : '';
    return separator > slash
      ? { name: target.slice(0, separator), ...(version ? { version } : {}) }
      : { name: target };
  }
  const separator = target.lastIndexOf('@');
  const version = separator > 0 ? target.slice(separator + 1) : '';
  return separator > 0
    ? { name: target.slice(0, separator), ...(version ? { version } : {}) }
    : { name: target };
}

function pluginMarketplace(target: string): string | null {
  if (target.startsWith('@')) return null;
  const separator = target.lastIndexOf('@');
  if (separator <= 0 || separator === target.length - 1) return null;
  return target.slice(separator + 1);
}

function upsertNpm(
  manifest: PackageManifest,
  spec: ParsedNpmTarget & Pick<NpmSpec, 'global' | 'registry'>,
): NpmSpec {
  const declarations = manifest.packages.npm ?? [];
  const existing = declarations.find((item) => item.name === spec.name);
  if (existing) {
    if (spec.version !== undefined) existing.version = spec.version;
    if (spec.global !== undefined) existing.global = spec.global;
    if (spec.registry !== undefined) existing.registry = spec.registry;
  } else {
    declarations.push({ ...spec, version: spec.version ?? '*' });
  }
  manifest.packages.npm = declarations;
  return existing ?? declarations[declarations.length - 1];
}

function ensureClaudeManifest(manifest: PackageManifest): NonNullable<PackageManifest['packages']['claude']> {
  manifest.packages.claude ??= { marketplaces: [], plugins: [] };
  return manifest.packages.claude;
}

async function resolveClaudeTarget(
  target: string,
  manifest: PackageManifest,
  adapter: ClaudePluginAdapter,
): Promise<{ marketplace: string; declaration: ClaudeMarketplace } | null> {
  const marketplace = pluginMarketplace(target);
  if (!marketplace) return null;

  const declared = manifest.packages.claude?.marketplaces.find(
    (item) => item.name === marketplace,
  );
  if (declared) return { marketplace, declaration: declared };

  const officialRepo = OFFICIAL_MARKETPLACES[marketplace];
  if (officialRepo) {
    return { marketplace, declaration: { name: marketplace, repo: officialRepo } };
  }

  const registered = (await adapter.registeredMarketplaces()).find(
    (item) => item.name === marketplace,
  );
  if (!registered) return null;
  const repo = marketplaceSourceLocation(registered);
  if (!repo) {
    throw new Error(
      `Claude marketplace "${marketplace}" is registered but its repository could not be determined`,
    );
  }
  return { marketplace, declaration: { name: marketplace, repo } };
}

interface AddedTarget {
  ecosystem: 'npm' | 'claude';
  npm?: NpmSpec;
  marketplace?: ClaudeMarketplace;
  pluginName?: string;
}

async function addTarget(
  target: string,
  manifest: PackageManifest,
  claude: ClaudePluginAdapter,
  options: Pick<GlobalOptions, 'global' | 'registry' | 'npm' | 'claude'>,
): Promise<AddedTarget> {
  const addNpm = (): AddedTarget => {
    const spec = upsertNpm(manifest, {
      ...parseNpmTarget(target),
      ...(options.global ? { global: true } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
    });
    return { ecosystem: 'npm', npm: spec };
  };

  const marketplace = pluginMarketplace(target);
  if (options.claude && !marketplace) {
    throw new Error('Claude plugin targets must use the plugin@marketplace format');
  }
  if (options.npm || options.global || options.registry || !marketplace) return addNpm();

  const claudeTarget = await resolveClaudeTarget(target, manifest, claude);
  if (!claudeTarget) {
    if (options.claude) {
      throw new Error(
        `Claude marketplace "${marketplace}" is not declared or registered. `
        + 'Register it with Claude Code first, then retry.',
      );
    }
    throw new Error(
      `Ambiguous target "${target}": "${marketplace}" is not a known Claude marketplace. `
      + 'Use --npm for an npm version/tag, or --claude after registering the marketplace.',
    );
  }

  const ecosystem = ensureClaudeManifest(manifest);
  if (!ecosystem.marketplaces.some((item) => item.name === claudeTarget.marketplace)) {
    ecosystem.marketplaces.push(claudeTarget.declaration);
  }
  if (!ecosystem.plugins.some((item) => item.name === target)) {
    ecosystem.plugins.push({ name: target });
  }
  return {
    ecosystem: 'claude',
    marketplace: claudeTarget.declaration,
    pluginName: target,
  };
}

function validateOrThrow(manifest: PackageManifest): void {
  const result = PackageManifestSchema.safeParse(manifest);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => issue.message);
    throw new Error(`Invalid package declarations:\n- ${errors.join('\n- ')}`);
  }
}

export async function pkgInstall(
  target: string | undefined,
  options: GlobalOptions,
): Promise<void> {
  const { localConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  const manifest = await loadPackageManifest(localConfig.repo.localPath);
  const cwd = process.cwd();
  const lockDir = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
  const npm = new NpmAdapter();
  const claude = new ClaudePluginAdapter();

  if (options.npm && options.claude) {
    throw new Error('--npm and --claude are mutually exclusive');
  }
  if (options.claude && (options.global || options.registry)) {
    throw new Error('--global and --registry only apply to npm package targets');
  }
  if (!target && (options.global || options.registry || options.npm || options.claude)) {
    throw new Error('--global, --registry, --npm, and --claude require a package target');
  }
  if (target) assertNotReadOnly(localConfig, 'teamai packages install <target>');
  const added = target ? await addTarget(target, manifest, claude, options) : undefined;
  if (!hasPackageDeclarations(manifest)) {
    log.info('No packages are declared in teamai.yaml');
    return;
  }
  validateOrThrow(manifest);

  const previousLock = await loadPackageLock(lockDir);
  const context: PackageInstallContext = {
    cwd,
    scope: localConfig.scope,
    dryRun: options.dryRun,
    previousPackages: previousLock?.packages,
  };
  const lock: PackageLock = {
    version: 1,
    ...(previousLock?.declarationHash
      ? { declarationHash: previousLock.declarationHash }
      : {}),
    ...(previousLock?.projectDeclarationHashes
      ? { projectDeclarationHashes: previousLock.projectDeclarationHashes }
      : {}),
    packages: previousLock?.packages ?? {},
  };
  if (!target) {
    if (localConfig.scope === 'user') {
      lock.declarationHash = sharedPackageDeclarationHash(manifest);
      const projectHash = projectNpmDeclarationHash(manifest);
      if (projectHash) {
        lock.projectDeclarationHashes = {
          ...lock.projectDeclarationHashes,
          [packageProjectKey(cwd)]: projectHash,
        };
      }
    } else {
      lock.declarationHash = packageDeclarationHash(manifest);
    }
  }

  if ((manifest.packages.npm?.length ?? 0) > 0 && (!added || added.ecosystem === 'npm')) {
    if (added?.npm) {
      await npm.install([added.npm], context);
      if (!options.dryRun) {
        lock.packages.npm = await npm.snapshot(cwd, manifest.packages.npm ?? []);
      }
    } else {
      lock.packages.npm = await npm.install(manifest.packages.npm ?? [], context);
    }
  }
  if (manifest.packages.claude && (!added || added.ecosystem === 'claude')) {
    if (added?.marketplace && added.pluginName) {
      await claude.install({
        marketplaces: [added.marketplace],
        plugins: [{ name: added.pluginName }],
      }, context);
      if (!options.dryRun) {
        lock.packages.claude = await claude.snapshot(manifest.packages.claude);
      }
    } else {
      lock.packages.claude = await claude.install(manifest.packages.claude, context);
    }
  }

  if (options.dryRun) {
    log.info('Dry run — no manifest or lockfile changes made');
    return;
  }
  if (target) {
    await savePackageManifest(localConfig.repo.localPath, manifest);
    log.success(`Declared ${target} in teamai.yaml (${added?.ecosystem})`);
  }
  if (localConfig.scope === 'project') await ensurePackageLockIgnored(lockDir);
  await savePackageLock(lockDir, lock);
  log.success('TeamAI packages installed; wrote teamai.lock');
}

export interface PackageDoctorReport {
  lines: string[];
  allPassed: boolean;
}

export async function pkgDoctorReport(
  localConfig: LocalConfig,
  cwd: string,
): Promise<PackageDoctorReport | null> {
  if (!await pathExists(packageManifestPath(localConfig.repo.localPath))) return null;
  let manifest: PackageManifest;
  try {
    manifest = await loadPackageManifest(localConfig.repo.localPath);
  } catch (error) {
    return {
      lines: [
        '',
        '  Packages',
        `  ✖ Package manifest is invalid: ${(error as Error).message}`,
      ],
      allPassed: false,
    };
  }
  if (!hasPackageDeclarations(manifest)) return null;

  const npm = new NpmAdapter();
  const claude = new ClaudePluginAdapter();
  const previousLock = await loadPackageLock(
    getTeamaiHome(localConfig.scope, localConfig.projectRoot),
  );
  const context: PackageInstallContext = {
    cwd,
    scope: localConfig.scope,
    previousPackages: previousLock?.packages,
  };
  const environment = await detectPackageEnvironment();
  const needsNpm = (manifest.packages.npm?.length ?? 0) > 0;
  const needsClaudeMarketplaces = (manifest.packages.claude?.marketplaces.length ?? 0) > 0;
  const needsClaudePlugins = (manifest.packages.claude?.plugins.length ?? 0) > 0;
  const needsClaude = needsClaudeMarketplaces || needsClaudePlugins;
  const requiredEnvironment = environment.filter((item) =>
    (needsNpm && (item.name === 'Node' || item.name === 'npm'))
    || (needsClaude && item.name === 'Claude Code'));

  const lines = ['', '  Environment'];
  let allPassed = true;
  for (const item of requiredEnvironment) {
    lines.push(`  ${item.available ? '✔' : '✖'} ${item.name.padEnd(14)} ${item.version || 'not found'}`);
    if (!item.available) allPassed = false;
  }

  if (needsNpm) {
    lines.push('', '  Packages (npm)');
    for (const status of await npm.status(manifest.packages.npm ?? [], context)) {
      lines.push(`  ${status.installed ? '✔' : '✖'} ${status.name.padEnd(28)} ${status.detail ?? status.version ?? ''}`.trimEnd());
      if (!status.installed) allPassed = false;
    }
  }
  if (needsClaudeMarketplaces) {
    lines.push('', '  Claude marketplaces');
    for (const status of await claude.marketplaceStatus(manifest.packages.claude!, context)) {
      lines.push(`  ${status.installed ? '✔' : '✖'} ${status.name.padEnd(42)} ${status.detail ?? ''}`.trimEnd());
      if (!status.installed) allPassed = false;
    }
  }
  if (needsClaudePlugins) {
    lines.push('', '  Packages (claude plugins)');
    for (const status of await claude.status(manifest.packages.claude!, context)) {
      const ok = status.installed && status.enabled !== false;
      const suffix = status.installed
        ? `${status.version ?? 'unknown'} (${status.enabled === false ? 'disabled' : 'enabled'})`
        : status.detail ?? 'declared but not installed';
      lines.push(`  ${ok ? '✔' : '✖'} ${status.name.padEnd(42)} ${suffix}`);
      if (status.detail && status.installed) lines.push(`    → ${status.detail}`);
      if (!ok) allPassed = false;
    }
  }
  if (!allPassed) lines.push('    → Run `teamai packages`');
  return { lines, allPassed };
}
