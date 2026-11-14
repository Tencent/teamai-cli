import path from 'node:path';

/**
 * Where the step runtimes outside teamai's process keep their state for the member whose home is `home`, a folder each.
 * `teamai uninstall` removes it with the last install on that home, once no place a runtime keeps is open.
 */
export function runtimeStateRoot(home: string): string {
  return path.join(home, '.teamai', 'runtime-state');
}
