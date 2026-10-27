import fs from 'node:fs';
import path from 'node:path';

/** Track detached children before their parent exits, so a fixture can join them. */
export function trackDetachedProcesses(root: string): { preload: string; nodeOptions: string; running: () => number[]; waitForExit: () => Promise<void> } {
  const children = path.join(root, 'detached-children');
  fs.mkdirSync(children);
  const preload = path.join(root, 'track-detached.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const child = spawn.apply(this, args);
  if (args[2]?.detached && child.pid) {
    fs.writeFileSync(path.join(${JSON.stringify(children)}, String(child.pid)), '');
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  /** The tracked pids still running; each exited one is forgotten. */
  function running(): number[] {
    return fs.readdirSync(children).map(Number).filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
        fs.unlinkSync(path.join(children, String(pid)));
        return false;
      }
    });
  }
  return {
    preload,
    nodeOptions: `--require ${JSON.stringify(preload)}`,
    running,
    async waitForExit() {
      const deadline = Date.now() + 60_000;
      while (running().length > 0) {
        if (Date.now() >= deadline) throw new Error(`Detached fixture processes did not exit: ${running().join(', ')}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    },
  };
}
