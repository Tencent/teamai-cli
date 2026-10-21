import path from 'node:path';

import { pathExists, readJson } from '../../utils/fs.js';
import { formatCommand, type CommandExecutor } from '../../utils/exec.js';
import { log } from '../../utils/logger.js';
import type { NpmLockEntry, NpmSpec, PackageStatus } from '../types.js';
import {
  PackageAdapter,
  type PackageInstallContext,
} from './base.js';

interface LockPackage {
  version?: string;
  integrity?: string;
  resolved?: string;
}

interface NpmPackageLock {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
  dependencies?: Record<string, LockPackage>;
}

interface NpmListOutput {
  dependencies?: Record<string, LockPackage>;
  devDependencies?: Record<string, LockPackage>;
  optionalDependencies?: Record<string, LockPackage>;
}

interface PackageJson {
  packageManager?: string;
}

type LocalPackageManager = 'npm' | 'pnpm';

interface LocalPackageManagerContext {
  manager: LocalPackageManager;
  /** Set when `cwd` is itself a pnpm workspace root: `pnpm add` there needs `--workspace-root`. */
  isWorkspaceRoot: boolean;
}

/**
 * Walks from `cwd` up to the filesystem root. A pnpm workspace member
 * typically carries none of pnpm's own markers — they live at the workspace
 * root — so checking only `cwd` would silently fall back to npm there.
 */
async function detectLocalPackageManager(cwd: string): Promise<LocalPackageManagerContext> {
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    if (await pathExists(path.join(at, 'pnpm-workspace.yaml'))) {
      return { manager: 'pnpm', isWorkspaceRoot: at === path.resolve(cwd) };
    }
    if (
      await pathExists(path.join(at, 'pnpm-lock.yaml'))
      || await pathExists(path.join(at, 'node_modules', '.pnpm'))
    ) {
      return { manager: 'pnpm', isWorkspaceRoot: false };
    }
    const packageJson = await readJson<PackageJson>(path.join(at, 'package.json'));
    const declaredManager = packageJson?.packageManager?.split('@', 1)[0];
    if (declaredManager === 'pnpm') {
      return { manager: 'pnpm', isWorkspaceRoot: false };
    }
    // An explicit npm declaration wins over any pnpm marker further up the
    // tree — otherwise a standalone npm project nested under an unrelated
    // pnpm workspace would get routed through pnpm, recreating the exact
    // mixed-package-manager bug this function exists to avoid.
    if (declaredManager === 'npm') {
      return { manager: 'npm', isWorkspaceRoot: false };
    }
    if (path.dirname(at) === at) return { manager: 'npm', isWorkspaceRoot: false };
  }
}

function satisfiesDeclaredVersion(semver: typeof import('semver'), declared: string, actual: string): boolean {
  // npm dist-tags such as latest/next cannot be checked without a registry
  // lookup. Exact versions and ranges can be verified entirely from the lock.
  const range = semver.validRange(declared);
  if (!range || !semver.valid(actual)) return true;
  return semver.satisfies(actual, range, { includePrerelease: true });
}

function packageArgument(spec: NpmSpec): string {
  return spec.version === '*' ? spec.name : `${spec.name}@${spec.version}`;
}

export function extractNpmLockEntries(
  lock: NpmPackageLock,
  declared: NpmSpec[],
): NpmLockEntry[] {
  const entries: NpmLockEntry[] = [];
  for (const spec of declared) {
    const value = lock.packages?.[`node_modules/${spec.name}`]
      ?? lock.dependencies?.[spec.name];
    if (!value?.version) continue;
    entries.push({
      name: spec.name,
      version: value.version,
      source: 'npm',
      ...(value.integrity ? { integrity: value.integrity } : {}),
      ...(value.resolved ? { resolved: value.resolved } : {}),
    });
  }
  return entries;
}

export class NpmAdapter extends PackageAdapter<NpmSpec[], NpmLockEntry[]> {
  readonly ecosystem = 'npm' as const;

  constructor(executor?: CommandExecutor) {
    super(executor);
  }

  async detect(cwd: string): Promise<boolean> {
    return pathExists(path.join(cwd, 'package.json'));
  }

  private async snapshotLocal(cwd: string, declaration: NpmSpec[]): Promise<NpmLockEntry[]> {
    const local = declaration.filter((spec) => !spec.global);
    if (local.length === 0) return [];
    if ((await detectLocalPackageManager(cwd)).manager === 'pnpm') {
      try {
        const result = await this.execute(
          'pnpm',
          ['list', '--depth=0', '--json'],
          { cwd, timeoutMs: 30_000 },
        );
        if (result.code !== 0 || !result.stdout.trim()) return [];
        const [listed] = JSON.parse(result.stdout) as NpmListOutput[];
        const dependencies = {
          ...listed?.dependencies,
          ...listed?.devDependencies,
          ...listed?.optionalDependencies,
        };
        return extractNpmLockEntries({ dependencies }, local);
      } catch {
        return [];
      }
    }
    const lock = await readJson<NpmPackageLock>(path.join(cwd, 'package-lock.json'));
    return lock ? extractNpmLockEntries(lock, local) : [];
  }

  private async snapshotGlobal(declaration: NpmSpec[]): Promise<NpmLockEntry[]> {
    const global = declaration.filter((spec) => spec.global);
    if (global.length === 0) return [];
    try {
      const result = await this.execute(
        'npm',
        ['list', '--global', '--depth=0', '--json'],
        { timeoutMs: 30_000 },
      );
      if (!result.stdout.trim()) return [];
      const listed = JSON.parse(result.stdout) as NpmListOutput;
      return global.flatMap((spec) => {
        const actual = listed.dependencies?.[spec.name];
        if (!actual?.version) return [];
        return [{
          name: spec.name,
          version: actual.version,
          source: 'npm' as const,
          global: true,
          ...(spec.registry ? { registry: spec.registry } : {}),
          ...(actual.integrity ? { integrity: actual.integrity } : {}),
          ...(actual.resolved ? { resolved: actual.resolved } : {}),
        }];
      });
    } catch {
      return [];
    }
  }

  async snapshot(cwd: string, declaration: NpmSpec[]): Promise<NpmLockEntry[]> {
    const [local, global] = await Promise.all([
      this.snapshotLocal(cwd, declaration),
      this.snapshotGlobal(declaration),
    ]);
    return [...local, ...global];
  }

  async install(
    declaration: NpmSpec[],
    context: PackageInstallContext,
  ): Promise<NpmLockEntry[]> {
    if (declaration.length === 0) return [];
    const local = declaration.filter((spec) => !spec.global);
    if (local.length > 0 && !await this.detect(context.cwd)) {
      throw new Error(`npm packages are declared, but package.json was not found in ${context.cwd}`);
    }

    const groups = new Map<string, NpmSpec[]>();
    for (const spec of declaration) {
      const key = `${spec.global === true ? 'global' : 'project'}\0${spec.registry ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(spec);
      groups.set(key, group);
    }

    const localManager = local.length > 0
      ? await detectLocalPackageManager(context.cwd)
      : { manager: 'npm' as const, isWorkspaceRoot: false };

    const commandFor = (first: NpmSpec): string => (first.global ? 'npm' : localManager.manager);
    const argsFor = (command: string, first: NpmSpec, group: NpmSpec[]): string[] => [
      command === 'pnpm' ? 'add' : 'install',
      ...(first.global ? ['--global'] : []),
      ...(!first.global && command === 'pnpm' && localManager.isWorkspaceRoot ? ['--workspace-root'] : []),
      ...group.map(packageArgument),
      ...(first.registry ? ['--registry', first.registry] : []),
    ];

    if (context.dryRun) {
      for (const group of groups.values()) {
        const first = group[0];
        const command = commandFor(first);
        log.info(`[dry-run] Would run: ${formatCommand(command, argsFor(command, first, group))}`);
      }
      return this.snapshotLocal(context.cwd, declaration);
    }

    for (const group of groups.values()) {
      const first = group[0];
      const command = commandFor(first);
      const args = argsFor(command, first, group);
      const result = await this.execute(command, args, {
        cwd: context.cwd,
        timeoutMs: 10 * 60_000,
        stream: true,
      });
      if (result.code !== 0) {
        throw new Error(`${command} ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`);
      }
    }
    return this.snapshot(context.cwd, declaration);
  }

  async status(
    declaration: NpmSpec[],
    context: PackageInstallContext,
  ): Promise<PackageStatus[]> {
    const installed = new Map(
      (await this.snapshot(context.cwd, declaration)).map((entry) => [entry.name, entry]),
    );
    // Loaded here, not at startup: only a package status check compares versions.
    const { default: semver } = await import('semver');
    return declaration.map((spec) => {
      const entry = installed.get(spec.name);
      const versionMatches = !entry?.version
        || satisfiesDeclaredVersion(semver, spec.version, entry.version);
      return {
        name: spec.name,
        installed: !!entry && versionMatches,
        ...(entry?.version ? { version: entry.version } : {}),
        ...(!entry ? {
          detail: spec.global
            ? 'declared but not installed globally'
            : 'declared but not present in package-lock.json',
        } : !versionMatches ? {
          detail: `declared ${spec.version}, installed ${entry.version}`,
        } : {}),
      };
    });
  }
}
