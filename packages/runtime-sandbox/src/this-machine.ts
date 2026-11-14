// What the runtime asks of the machine it runs on. The runtime's test bundle swaps this module for
// `testing/this-machine.ts`, which answers as the machine a test names.

/**
 * Where macOS keeps `sandbox-exec` and `sw_vers`. They run from there by absolute path, never from PATH, where a planted
 * `sandbox-exec` (a repository's `node_modules/.bin`, `~/.local/bin`) would run the step unconfined.
 */
export const SYSTEM_BIN = '/usr/bin';

/** The operating system the runtime runs on. */
export const PLATFORM: NodeJS.Platform = process.platform;

/** Where Linux names its distribution, the first that exists. */
export const OS_RELEASE = ['/etc/os-release', '/usr/lib/os-release'];
