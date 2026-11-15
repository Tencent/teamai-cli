import path from 'node:path';
import { readRegularFile } from '@teamai/shared/regular-file';

/**
 * How a family reads a tool's version: the argv the host runs and how its output reads,
 * or the macOS app bundles, in order, whose Info.plist holds it.
 */
export type VersionDetector =
  | { readonly probe: readonly [command: string, ...args: string[]]; readonly read: (output: string) => string }
  | { readonly apps: readonly string[] };

/** Runs `command` with `args` and gives its output, or '' when it cannot run or fails. */
export type VersionProbe = (command: string, args: string[]) => Promise<string>;

/** The version `detector` reads, running its argv through `probe`, or '' when it reads none. */
export async function readVersion(detector: VersionDetector, probe: VersionProbe): Promise<string> {
  if ('apps' in detector) {
    for (const app of detector.apps) {
      const version = await readPlistVersion(app);

      if (version) return version;
    }

    return '';
  }

  const [command, ...args] = detector.probe;

  return detector.read(await probe(command, args));
}

/** The version in a macOS app bundle's Info.plist, or '' when it has none. */
export async function readPlistVersion(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');

  try {
    const content = await readRegularFile(plistPath, 'utf-8');

    const match = content.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );

    return match?.[1] ?? '';
  } catch {
    return '';
  }
}
