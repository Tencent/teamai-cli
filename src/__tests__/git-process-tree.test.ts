import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { endProcessTree } from '../utils/git.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

describe('endProcessTree', () => {
  // The shape of a stalled pull: git, a git fetch it started, an ssh under that.
  it('ends a process and every process under it', async () => {
    const grandchild = 'setInterval(() => {}, 1000)';
    const child = `const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
console.log(grandchild.pid);
setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', (pid) => console.log(child.pid + ' ' + String(pid).trim()));
setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });

    const [line] = await once(parent.stdout, 'data');
    const tree = [parent.pid!, ...String(line).trim().split(' ').map(Number)];
    expect(tree.filter(alive)).toEqual(tree);

    const exited = once(parent, 'exit');
    endProcessTree(parent.pid!);
    await exited;
    await vi.waitFor(() => expect(tree.filter(alive)).toEqual([]), { timeout: 5_000, interval: 50 });
  }, 15_000);
});
