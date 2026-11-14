import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, stop, type BuildOptions } from 'esbuild';

/** Builds of this module still running: esbuild's service, which they share, stops once none is. */
let building = 0;

/**
 * Builds the runtime whose entry is `entry` into `outfile`, as tsup bundles it into teamai-cli, and returns its path:
 * one ESM file with its packages inside, which `require` still works in. What a test swaps in: `alias` replaces a
 * package with a stand-in, and `plugins` a module of the runtime's own, which an alias cannot name. It leaves no
 * process running: esbuild keeps its service for the next build, which would outlive the test that bundled.
 */
export async function bundleRuntime({ entry, outfile, alias, plugins }: { entry: string; outfile: string } & Pick<BuildOptions, 'alias' | 'plugins'>): Promise<string> {
  building += 1;

  try {
    await build({
      entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
      ...(alias && { alias }), ...(plugins && { plugins }),
      banner: { js: "import { createRequire as __teamaiCreateRequire } from 'node:module';\nconst require = __teamaiCreateRequire(import.meta.url);" },
    });
  } finally {
    building -= 1;

    if (building === 0) await stop();
  }

  return outfile;
}

/** The bundles this module instance built with `bundleOnce`, by entry. */
const bundledOnce = new Map<string, Promise<string>>();

/**
 * Bundles `entry` as `bundleRuntime` does, once per module instance, and returns the file's path: a fake app that
 * both a runtime package's tests and the scenario suite start is built once for every test of a file, since Vitest
 * loads this module afresh for each test file it isolates. The file sits in a
 * directory of its own under the temporary directory, named after the entry (`fake-t3.mjs` for `fake-t3.mjs`), which
 * is removed when the process exits. A build that failed is not kept, so the next call builds again.
 */
export function bundleOnce(entry: string): Promise<string> {
  const known = bundledOnce.get(entry);

  if (known) return known;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bundle-'));
  process.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); });
  const built = bundleRuntime({ entry, outfile: path.join(dir, `${path.basename(entry).replace(/\.[cm]?[jt]s$/u, '')}.mjs`) });

  bundledOnce.set(entry, built);
  built.catch(() => { bundledOnce.delete(entry); });

  return built;
}
