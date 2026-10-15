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

    if (context.dryRun) {
      for (const group of groups.values()) {
        const first = group[0];
        const args = [
          'install',
          ...(first.global ? ['--global'] : []),
          ...group.map(packageArgument),
          ...(first.registry ? ['--registry', first.registry] : []),
        ];
        log.info(`[dry-run] Would run: ${formatCommand('npm', args)}`);
      }
      return this.snapshotLocal(context.cwd, declaration);
    }

    for (const group of groups.values()) {
      const first = group[0];
      const args = [
        'install',
        ...(first.global ? ['--global'] : []),
        ...group.map(packageArgument),
        ...(first.registry ? ['--registry', first.registry] : []),
      ];
      const result = await this.execute('npm', args, {
        cwd: context.cwd,
        timeoutMs: 10 * 60_000,
        stream: true,
      });
      if (result.code !== 0) {
        throw new Error(`npm install failed (exit ${result.code}): ${result.stderr.trim()}`);
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
