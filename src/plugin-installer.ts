import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Where an npm plugin package comes from. Exactly one source is used:
 * a tarball (already downloaded to `tarballPath`) or a registry package name
 * (`package`, optionally pinned to `version`).
 */
export interface NpmInstallSpec {
  package?: string;
  version?: string;
  tarballPath?: string;
}

/**
 * Build the argv for a global npm install. Tarball path takes precedence; a
 * registry package is pinned to `@version` when a version is given. Pure and
 * deterministic so the argument logic can be unit-tested without spawning npm.
 */
export function buildNpmInstallArgs(spec: NpmInstallSpec): string[] {
  if (spec.tarballPath) {
    return ['install', '--global', spec.tarballPath];
  }
  if (!spec.package) {
    throw new Error('Plugin install requires a package name or a tarball path');
  }
  const target = spec.version ? `${spec.package}@${spec.version}` : spec.package;
  return ['install', '--global', target];
}

/** Build the argv for a global npm uninstall of a package by name. */
export function buildNpmUninstallArgs(pkg: string): string[] {
  return ['uninstall', '--global', pkg];
}

/** Install a plugin package globally via npm (registry or tarball source). */
export async function installPluginPackage(spec: NpmInstallSpec): Promise<void> {
  await runNpm(buildNpmInstallArgs(spec));
}

/** Uninstall a globally-installed plugin package by npm package name. */
export async function uninstallPluginPackage(pkg: string): Promise<void> {
  await runNpm(buildNpmUninstallArgs(pkg));
}

/**
 * Return the version of a globally-installed package, or undefined if it is not
 * installed. Used to decide idempotency against the real on-disk state rather
 * than trusting the manifest (which can go stale if a package is removed out of
 * band). `npm ls` exits non-zero when the package is absent but still prints the
 * (empty) JSON tree to stdout, so that stdout is parsed on the error path too.
 */
export async function getInstalledPluginVersion(pkg: string): Promise<string | undefined> {
  const args = ['ls', '--global', '--depth=0', '--json', pkg];
  const extractVersion = (stdout: string): string | undefined => {
    try {
      const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
      return parsed.dependencies?.[pkg]?.version;
    } catch {
      return undefined;
    }
  };
  try {
    const { stdout } = await execFileAsync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return extractVersion(stdout);
  } catch (e) {
    const err = e as { code?: string; stdout?: string };
    if (err.code === 'ENOENT') {
      throw new Error('npm not found on PATH; cannot manage plugins');
    }
    // Absent package → npm ls exits non-zero with the tree still on stdout.
    return err.stdout ? extractVersion(err.stdout) : undefined;
  }
}

/**
 * Run npm with the given arguments, mapping failures to readable errors. npm
 * output can be large, so the stdout/stderr buffer is raised well above the
 * 1 MB default. A missing npm binary (ENOENT) is reported explicitly.
 */
async function runNpm(args: string[]): Promise<void> {
  try {
    await execFileAsync('npm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const err = e as { code?: string; stderr?: string; message: string };
    if (err.code === 'ENOENT') {
      throw new Error('npm not found on PATH; cannot manage plugins');
    }
    const detail = (err.stderr ?? '').trim() || err.message;
    throw new Error(`npm ${args.join(' ')} failed: ${detail}`);
  }
}
