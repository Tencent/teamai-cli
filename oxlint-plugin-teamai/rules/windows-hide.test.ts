import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/windows-hide', { filename: 'src/run.ts' });

rule.valid('allows a named import call that hides its window', `
import { spawn } from 'node:child_process';
spawn('git', ['status'], { cwd: '.', windowsHide: true });
`);

rule.invalid('rejects a named import call without windowsHide', `
import { spawnSync } from 'node:child_process';
spawnSync('git', ['status'], { encoding: 'utf8' });
`, (output) => {
  expect(output).toContain('windowsHide: true');
});

rule.invalid('rejects a call with no options at all', `
import { execFileSync } from 'child_process';
execFileSync('where', ['git']);
`);

rule.invalid('rejects windowsHide: false', `
import { exec } from 'node:child_process';
exec('ls', { windowsHide: false });
`);

rule.valid('allows options built elsewhere when the call site writes windowsHide', `
import { execSync } from 'node:child_process';
const options = { encoding: 'utf8' as const };
execSync('ls', { ...options, windowsHide: true });
`);

rule.invalid('rejects windowsHide: true that a later spread, property or computed key may override', `
import { execSync } from 'node:child_process';
const options = { windowsHide: false };
execSync('ls', { windowsHide: true, ...options });
execSync('ls', { windowsHide: true, windowsHide: false });
execSync('ls', { windowsHide: true, ['windowsHide']: false });
const key = 'detached';
execSync('ls', { [key]: true });
`, (output) => {
  expect(output).toContain('4 errors');
});

rule.invalid('rejects options passed as a variable, even one that may set windowsHide', `
import { execSync } from 'node:child_process';
const options = { encoding: 'utf8' as const, windowsHide: true };
execSync('ls', options);
`);

rule.valid('allows the callback form with windowsHide before the callback', `
import { execFile } from 'node:child_process';
execFile('taskkill', ['/pid', '1'], { windowsHide: true }, () => {});
`);

rule.invalid('rejects the callback form without options', `
import { execFile } from 'node:child_process';
execFile('taskkill', ['/pid', '1'], () => {});
`);

rule.valid('allows a namespace import call that hides its window', `
import * as cp from 'node:child_process';
cp.fork('worker.js', [], { windowsHide: true });
`);

rule.invalid('rejects a namespace import call without windowsHide', `
import cp from 'node:child_process';
cp.spawn('git', []);
`);

rule.valid('allows a dynamic import that hides its window', `
export async function run() {
  const { spawn } = await import('node:child_process');
  spawn('git', [], { windowsHide: true });
}
`);

rule.invalid('rejects a dynamic import without windowsHide', `
export async function run() {
  const { spawn: launch } = await import('node:child_process');
  launch('git', []);
}
`);

rule.invalid('rejects a require without windowsHide', `
const childProcess = require('child_process');
childProcess.execSync('ls');
`);

rule.valid('allows a promisified launcher that hides its window', `
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
await execFileAsync('git', ['status'], { windowsHide: true });
await promisify(execFile)('git', ['status'], { windowsHide: true });
`);

rule.invalid('rejects a promisified launcher without windowsHide, bound or inline', `
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
await run('git', ['status']);
await promisify(execFile)('git', ['status'], { cwd: '.' });
const run = promisify(execFile);
`, (output) => {
  expect(output).toContain('2 errors');
});

rule.valid('ignores functions of the same name from other modules and type-only imports', `
import type { SpawnOptions } from 'node:child_process';
import { spawn } from './my-spawn.js';
const options: SpawnOptions = {};
spawn('git', options);
`);

rule.valid('does not check test files', `
import { spawnSync } from 'node:child_process';
spawnSync('git', ['status']);
`, { filename: 'src/__tests__/run.test.ts' });

rule.valid('does not check scripts outside src/', `
import { spawnSync } from 'node:child_process';
spawnSync('git', ['status']);
`, { filename: 'scripts/check.ts' });
