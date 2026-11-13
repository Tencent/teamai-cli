import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';

/**
 * teamai's own package directory. This file sits one level below it, in src/ and in the bundle in dist/ alike, as
 * `default-workflows.ts` does.
 */
export function teamaiPackageDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..');
}

/** The file of the driver definition teamai ships as `name`, under `drivers/` in the package root. */
export function shippedDriverFile(name: string): string {
  return path.join(teamaiPackageDir(), 'drivers', `${name}.yaml`);
}

/** The `bin` map of teamai's package manifest. */
const PackageSchema = z.object({ bin: z.record(z.string(), z.string()).optional() });

/**
 * The built file of `name`, a `bin` entry of teamai's own package manifest, in `packageDir`: what teamai's own runtimes
 * name with `entry: { bin }`. Undefined when the package has none, or one that leaves the package. Found here, a stray
 * executable of that name on PATH never stands in for it.
 */
export function teamaiBin(name: string, packageDir = teamaiPackageDir()): string | undefined {
  let manifest: z.infer<typeof PackageSchema>;

  try {
    manifest = PackageSchema.parse(JSON.parse(readRegularFileSync(path.join(packageDir, 'package.json'), 'utf8')));
  } catch {
    return undefined;
  }

  const entry = manifest.bin?.[name];

  if (entry === undefined) return undefined;
  const file = path.resolve(packageDir, entry);

  if (path.relative(packageDir, file).startsWith('..') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;

  return file;
}
