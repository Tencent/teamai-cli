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

/** The shape of one project entry `npm list --json` / `pnpm list --json` emits. */
interface ListProject {
  path?: string;
  dependencies?: Record<string, LockPackage>;
  devDependencies?: Record<string, LockPackage>;
  optionalDependencies?: Record<string, LockPackage>;
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

/**
 * The nearest directory at or above `cwd` that signals a pnpm project, or null
 * for a plain npm project.
 *
 * A pnpm workspace member usually carries its own `package.json` while the
 * markers — `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packageManager` and the
 * `node_modules/.pnpm` store — live at the workspace root, so a check limited
 * to `cwd` would classify the member as npm and run `npm install` into pnpm's
 * symlinked tree (the #1102 crash). Walking the ancestors finds the root.
 */
async function pnpmProjectDir(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await pathExists(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (await pathExists(path.join(dir, 'pnpm-lock.yaml'))) return dir;
    if (await pathExists(path.join(dir, 'node_modules', '.pnpm'))) return dir;
    const pkg = await readJson<{ packageManager?: unknown }>(path.join(dir, 'package.json'));
    if (typeof pkg?.packageManager === 'string') {
      // An explicit pin decides: pnpm keeps this directory, and any other
      // manager (a nested `npm@…` project inside a pnpm repo) must win over the
      // pnpm markers that may sit further up, so stop here rather than walking
      // on and misclassifying it as pnpm.
      return pkg.packageManager.startsWith('pnpm') ? dir : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project `pnpm list --json` reports for `cwd`.
 *
 * `pnpm list` prints an array covering every project in the workspace even when
 * run inside one of them, so the member's own entry is matched by path.
 */
function pnpmProjectEntry(list: ListProject | ListProject[], cwd: string): ListProject | null {
  const projects = Array.isArray(list) ? list : [list];
  const resolved = path.resolve(cwd);
  return projects.find((project) => project.path !== undefined && path.resolve(project.path) === resolved)
    ?? (projects.length === 1 ? projects[0] : null);
}

/** Every installed dependency of one project entry, across dependency kinds. */
function installedDependencies(project: ListProject): Record<string, LockPackage> {
  return {
    ...project.dependencies,
    ...project.devDependencies,
    ...project.optionalDependencies,
  };
}

function extractPnpmEntries(project: ListProject, declared: NpmSpec[]): NpmLockEntry[] {
  const installed = installedDependencies(project);
  const entries: NpmLockEntry[] = [];
  for (const spec of declared) {
    const value = installed[spec.name];
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

/** The installed dependencies from a global `npm list --json` / `pnpm list --json`. */
function globalListDependencies(listed: ListProject | ListProject[]): Record<string, LockPackage> {
  const projects = Array.isArray(listed) ? listed : [listed];
  const merged: Record<string, LockPackage> = {};
  for (const project of projects) Object.assign(merged, project.dependencies);
  return merged;
}

export class NpmAdapter extends PackageAdapter<NpmSpec[], NpmLockEntry[]> {
  readonly ecosystem = 'npm' as const;

  constructor(executor?: CommandExecutor) {
    super(executor);
  }

  async detect(cwd: string): Promise<boolean> {
    return pathExists(path.join(cwd, 'package.json'));
  }

  /** The package manager `cwd` sits in: pnpm when a pnpm marker is at or above it. */
  private async packageManager(cwd: string): Promise<'pnpm' | 'npm'> {
    return await pnpmProjectDir(cwd) === null ? 'npm' : 'pnpm';
  }

  private async snapshotLocal(cwd: string, declaration: NpmSpec[]): Promise<NpmLockEntry[]> {
    const local = declaration.filter((spec) => !spec.global);
    if (local.length === 0) return [];
    if (await this.packageManager(cwd) === 'pnpm') {
      try {
        const result = await this.execute('pnpm', ['list', '--json', '--depth=0'], { cwd, timeoutMs: 30_000 });
        if (!result.stdout.trim()) return [];
        const project = pnpmProjectEntry(JSON.parse(result.stdout) as ListProject | ListProject[], cwd);
        return project ? extractPnpmEntries(project, local) : [];
      } catch {
        return [];
      }
    }
    const lock = await readJson<NpmPackageLock>(path.join(cwd, 'package-lock.json'));
    return lock ? extractNpmLockEntries(lock, local) : [];
  }

  private async snapshotGlobal(cwd: string, declaration: NpmSpec[]): Promise<NpmLockEntry[]> {
    const global = declaration.filter((spec) => spec.global);
    if (global.length === 0) return [];
    try {
      const result = await this.packageManager(cwd) === 'pnpm'
        ? await this.execute('pnpm', ['list', '--global', '--json', '--depth=0'], { timeoutMs: 30_000 })
        : await this.execute('npm', ['list', '--global', '--depth=0', '--json'], { timeoutMs: 30_000 });
      if (!result.stdout.trim()) return [];
      const listed = globalListDependencies(JSON.parse(result.stdout) as ListProject | ListProject[]);
      return global.flatMap((spec) => {
        const actual = listed[spec.name];
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
      this.snapshotGlobal(cwd, declaration),
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

    const manager = await this.packageManager(context.cwd);
    // A `pnpm add` at a workspace root is rejected with ERR_PNPM_ADDING_TO_ROOT
    // unless the root is named explicitly; a member's own cwd is a normal add.
    const workspaceRoot = manager === 'pnpm'
      && await pathExists(path.join(context.cwd, 'pnpm-workspace.yaml'));
    const commandFor = (group: NpmSpec[]): { command: string; args: string[] } => {
      const first = group[0];
      const packages = group.map(packageArgument);
      if (manager === 'pnpm') {
        return {
          command: 'pnpm',
          args: [
            'add',
            ...(first.global ? ['--global'] : workspaceRoot ? ['--workspace-root'] : []),
            ...packages,
            ...(first.registry ? ['--registry', first.registry] : []),
          ],
        };
      }
      return {
        command: 'npm',
        args: [
          'install',
          ...(first.global ? ['--global'] : []),
          ...packages,
          ...(first.registry ? ['--registry', first.registry] : []),
        ],
      };
    };

    const groups = new Map<string, NpmSpec[]>();
    for (const spec of declaration) {
      const key = `${spec.global === true ? 'global' : 'project'}\0${spec.registry ?? ''}`;
      const group = groups.get(key) ?? [];
      group.push(spec);
      groups.set(key, group);
    }

    if (context.dryRun) {
      for (const group of groups.values()) {
        const { command, args } = commandFor(group);
        log.info(`[dry-run] Would run: ${formatCommand(command, args)}`);
      }
      // A pnpm snapshot reads `pnpm list`, which dry-run must not spawn; npm
      // reads package-lock.json, a side-effect-free file read.
      return manager === 'pnpm' ? [] : this.snapshotLocal(context.cwd, declaration);
    }

    for (const group of groups.values()) {
      const { command, args } = commandFor(group);
      const result = await this.execute(command, args, {
        cwd: context.cwd,
        timeoutMs: 10 * 60_000,
        stream: true,
      });
      if (result.code !== 0) {
        const verb = manager === 'pnpm' ? 'add' : 'install';
        throw new Error(`${command} ${verb} failed (exit ${result.code}): ${result.stderr.trim()}`);
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
    const notInstalledDetail = await this.packageManager(context.cwd) === 'pnpm'
      ? 'declared but not present in pnpm list'
      : 'declared but not present in package-lock.json';
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
            : notInstalledDetail,
        } : !versionMatches ? {
          detail: `declared ${spec.version}, installed ${entry.version}`,
        } : {}),
      };
    });
  }
}
