import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * The fields we read from the CLI's own package.json.
 * Both fields are guaranteed by npm to exist on a published package.
 */
const PackageJsonFieldsSchema = z.object({
  name: z.string(),
  version: z.string(),
});

type PackageJsonFields = z.infer<typeof PackageJsonFieldsSchema>;

/**
 * Load the CLI's package.json.
 *
 * The path `../package.json` is kept literal so it resolves both in source
 * form (src/package-info.ts → ../package.json) and when bundled by tsup
 * (dist/cli.js → ../package.json). Do not move this file into a nested
 * folder without adjusting the bundler banner/resolver.
 */
function loadPackageJson(): PackageJsonFields {
  const require = createRequire(import.meta.url);

  return PackageJsonFieldsSchema.parse(require('../package.json'));
}

/**
 * The root of the installed package, holding what it ships beside the code (`workflows/`, `hooks/`, `rules/`,
 * `scorers/`, `skills/`). This file sits one level below it, in src/ and in the bundle in dist/ alike. The module path
 * is resolved first: a global `npm i -g` install exposes the CLI through a symlinked bin, and without resolving it
 * `..` can land outside the package.
 */
export function packageRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..');
}

/**
 * Get the currently installed CLI version from package.json.
 */
export function getCurrentVersion(): string {
  return loadPackageJson().version;
}

/**
 * Get the currently installed CLI package name from package.json.
 *
 * Used to decide:
 *  - which npm registry to query (public npm vs tnpm)
 *  - the default git provider fallback when users pass a bare `owner/repo`
 *
 * At publish time the internal tnpm pipeline rewrites the name to
 * `@tencent/teamai-cli` (see `.coding-ci.yaml`), so reading it at runtime
 * is a reliable signal of which distribution channel the user installed from.
 */
export function getCurrentPackageName(): string {
  return loadPackageJson().name;
}
