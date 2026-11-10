import fs from 'node:fs';
import path from 'node:path';
import { getCurrentPackageName } from './package-info.js';

/**
 * Derive the npm install target from an entry-script path. Two npm-managed
 * layouts are recognized:
 * - POSIX global: `<prefix>/lib/node_modules/<pkg>` — npm -g re-adds the lib/
 *   component itself, so the prefix it expects is the slice above it.
 * - Flat/vendored: `<prefix>/node_modules/<pkg>` (bundled runtimes). POSIX npm
 *   -g CANNOT reinstall into this layout (it always nests under lib/), so the
 *   caller must install non-globally with --prefix — hence the `global` flag.
 * Returns null when the entry cannot be attributed to an npm-managed install
 * (e.g. a linked checkout). Exported for testing — split out from
 * resolveInstallPrefix.
 */
export function prefixFromEntryPath(entry: string, posix: boolean): { prefix: string; global: boolean } | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = entry.lastIndexOf(marker);

  if (idx <= 0) return null;
  const root = entry.slice(0, idx);
  const pkgDir = getCurrentPackageName();

  // POSIX global layout: npm re-adds the lib/ component, so hand it the slice
  // above and let it nest back down to where the running package sits.
  if (posix && path.basename(root) === 'lib') {
    const prefix = path.dirname(root);

    return fs.existsSync(path.join(prefix, 'lib', 'node_modules', pkgDir))
      ? { prefix, global: true }
      : null;
  }

  // Flat layout (<root>/node_modules/<pkg>): the sanity check verifies the
  // layout that was actually matched, not the one npm would have created.
  return fs.existsSync(path.join(root, 'node_modules', pkgDir))
    ? { prefix: root, global: !posix }
    : null;
}

/** `$VOLTA_HOME/tools/image/packages/<name>`, including the default `~/.volta` and `%LOCALAPPDATA%\\Volta` homes. */
const VOLTA_PACKAGE_IMAGE = /(?:^|\/)\.?volta\/tools\/image\/packages\//i;

/**
 * A Volta package image is not an npm prefix. `npm install -g --prefix` there
 * removes the current executable before the new one is in place.
 * `voltaHome` defaults to `VOLTA_HOME`; pass `''` to ignore a custom home.
 */
export function isVoltaPackageImage(filePath: string, voltaHome = process.env.VOLTA_HOME): boolean {
  if (voltaHome) {
    const root = path.resolve(voltaHome, 'tools', 'image', 'packages');
    const resolved = path.resolve(filePath);
    const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const file = fold(resolved);
    const dir = fold(root);

    if (file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return true;
  }

  return VOLTA_PACKAGE_IMAGE.test(filePath.replace(/\\/g, '/'));
}
