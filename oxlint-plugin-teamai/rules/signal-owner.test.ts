import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';
import { NOT_A_CHILD, OWNER, RUN_AS_IS, SCRIPT_TEXT } from './signal-owner.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/signal-owner', { filename: 'src/__tests__/helpers/stop.ts' });

const reports = (output: string): number => output.match(/signalPid or signalGroup from @teamai\/shared\/process-group, not process\.kill/g)?.length ?? 0;

rule.invalid('rejects process.kill in a test helper, as a group of 0 its pid can be', `export function stop(pid: number): void {
  process.kill(-pid, 'SIGKILL');
}`, (output) => {
  expect(reports(output)).toBe(1);
});

rule.invalid('rejects a probe in production source', `export const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };`, undefined, { filename: 'packages/runtime-kit/src/alive.ts' });

rule.invalid('rejects process.kill reached through an alias of process or of kill', `const { kill } = process;
const { kill: end } = globalThis.process;
const node = process;
let other: { kill?: unknown } = {};
({ kill: other.kill } = process);
kill(2, 0);
end(2, 0);
node.kill(2, 0);
process['kill'](2, 0);
Reflect.apply(process.kill, process, [2, 0]);
export const bound = process.kill.bind(process);
export const read = Reflect.get(process, 'kill');`, (output) => {
  expect(reports(output)).toBe(8);
});

rule.invalid('rejects process.kill read through a computed global, a fallback, or a kill executable named by path or with a pid filled in', `import { execSync, spawn } from 'node:child_process';
globalThis['process'].kill(2, 0);
const maybe = globalThis.process ?? null;
maybe?.kill(2, 0);
const pid = 2;
execSync(\`kill -9 \${pid}\`);
spawn('/bin/kill', ['-KILL', String(pid)]);`, (output) => {
  expect(reports(output)).toBe(4);
});

rule.invalid('rejects process.kill reached through a parameter, a later assignment, a nested pattern, a renamed default, a re-export, createRequire, a key it cannot read, or a call given process and its key', `import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { default as proc } from 'node:process';
export { kill } from 'node:process';
export function stop(target = process): void { target.kill(2, 0); }
export const end = ({ kill: ended } = process): boolean => ended(2, 0);
let later;
later = process;
later.kill(2, 0);
const { process: { kill: nested } } = globalThis;
proc.kill(2, 0);
createRequire(import.meta.url)('node:process').kill(2, 0);
spawn('kill -9 2', { shell: true });
execFile('/usr/bin/env', ['kill', '-9', '2']);
const name = 'kill';
process[name](2, 0);
Object.getOwnPropertyDescriptor(process, 'kill');
export { nested };`, (output) => {
  expect(reports(output)).toBe(11);
});

rule.invalid('rejects kill of the process module, imported or required', `import { kill as end } from 'node:process';
import proc from 'process';
import * as nodeProcess from 'node:process';
const required = require('node:process');
proc.kill(2, 0);
nodeProcess.kill(2, 0);
required.kill(2, 0);
(await import('node:process')).default.kill(2, 0);
end(2, 0);`, (output) => {
  expect(reports(output)).toBe(5);
});

rule.invalid('rejects the kill executables, which signal the pid they are given', `import { execFile, execSync, spawnSync } from 'node:child_process';
spawnSync('kill', ['-KILL', '2']);
execFile('pkill', ['-f', 'node']);
execSync('kill -9 2');`, (output) => {
  expect(reports(output)).toBe(3);
});

rule.invalid('rejects process.kill in the text of a program a test runs, in a file not named for it', `import { spawnSync } from 'node:child_process';
spawnSync(process.execPath, ['-e', "process.kill(process.ppid, 'SIGKILL')"]);
spawnSync(process.execPath, ['-e', \`process.kill(\${2}, 0)\`]);`, (output) => {
  expect(output.match(/This text calls process\.kill in a program a test runs/g)).toHaveLength(2);
});

rule.invalid('rejects one in a folder and package no rule names, with no rule edit', `export const stop = (pid: number): boolean => process.kill(pid, 'SIGTERM');`, undefined, { filename: 'packages/runtime-new/src/testing/stop.ts' });

rule.invalid('rejects one in a program node runs as it is, unless the rule names it', `process.kill(-Number(process.argv[2]), 'SIGKILL');`, undefined, { filename: 'src/__tests__/fixtures/runtime-new/runtime.mjs' });

rule.valid('allows the owner, which every signal goes through', `export const signal = (pid: number): boolean => process.kill(pid, 0);`, { filename: 'packages/shared/src/process-group.ts' });

rule.valid('allows the program node runs as it is that the rule names, which keeps the check inline', `process.kill(-Number(process.argv[2]), 'SIGKILL');`, { filename: 'packages/runtime-sandbox/src/testing/fake-engine.mjs' });

rule.invalid('rejects a child\'s kill in the program node runs as it is, which the rule lets off only its process.kill', `import { spawn } from 'node:child_process';
process.kill(-Number(process.argv[2]), 'SIGKILL');
spawn('sleep', ['9']).kill('SIGKILL');`, (output) => {
  expect(output.match(/Signal a child process through signalChild/g)).toHaveLength(1);
  expect(reports(output)).toBe(0);
}, { filename: 'packages/runtime-sandbox/src/testing/fake-engine.mjs' });

rule.valid('allows the text of a program in a file the rule names for it', `export const script = "process.kill(process.ppid, 'SIGKILL')";`, { filename: 'src/__tests__/env-exec.test.ts' });

rule.valid('allows the owner\'s calls, a spy on process.kill, a child\'s kill, and a process of its own', `import { spawn } from 'node:child_process';
import { signalGroup, signalPid } from '@teamai/shared/process-group';
import { vi } from 'vitest';
const spy = vi.spyOn(process, 'kill').mockReturnValue(true);
const child = spawn('true');
child.kill('SIGTERM');
signalPid(2, 0);
signalGroup(2, 'SIGKILL');
const local = { kill: (pid: number) => pid };
local.kill(2);
function stop(process: { kill(): void }): void { process.kill(); }
export { spy, stop };`);

const childReports = (output: string): number => output.match(/Signal a child process through signalChild/g)?.length ?? 0;

rule.invalid('rejects a child\'s own kill in production source, which on a failed spawn signals the caller\'s whole group', `import { spawn } from 'node:child_process';
const child = spawn('git', ['fetch']);
const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
const kill = child.kill.bind(child);
const { kill: end } = child;
child?.kill();
child['kill']('SIGTERM');
export { end, kill, timer };`, (output) => {
  expect(childReports(output)).toBe(5);
}, { filename: 'src/utils/fetch.ts' });

rule.invalid('rejects a child\'s kill with no pid check in the text of a program production code writes for another tool to run', `export const plugin = \`
const timer = setTimeout(() => { try { child.kill(); } catch {} }, 1000);
const other = setTimeout(() => { if (child.pid !== undefined) child.kill(); }, 1000);
\`;`, (output) => {
  expect(output.match(/This text kills a child with no check that it spawned/g)).toHaveLength(1);
}, { filename: 'src/tool-hooks.ts' });

rule.valid('allows signalChild in production source, and a kill of its own put on a child', `import { spawn } from 'node:child_process';
import { signalChild } from '@teamai/shared/process-group';
const child = spawn('git', ['fetch']);
child.kill = (signal) => signalChild(child, signal) === 'sent';
signalChild(child, 'SIGTERM');`, { filename: 'packages/runtime-new/src/fetch.ts' });

rule.valid('allows the kill of a remote sandbox\'s command, by the name the rule gives for its file', `export const stop = (command: { kill(signal: string): Promise<void> }) => command.kill('SIGTERM');`, { filename: 'packages/runtime-sandbox/src/providers/vercel.ts' });

rule.invalid('rejects a child\'s kill in that file under any other name', `import { spawn } from 'node:child_process';
const child = spawn('tar', ['-cf', '-']);
child.kill('SIGKILL');`, undefined, { filename: 'packages/runtime-sandbox/src/providers/vercel.ts' });

const Config = z.object({
  ignorePatterns: z.array(z.string()),
  rules: z.record(z.string(), z.unknown()),
  overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })),
});

const config = Config.parse(JSON.parse(fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')));

it('is an error in this checkout, with no file let off', () => {
  expect(config.rules['teamai/signal-owner']).toBe('error');
  expect(config.overrides.filter((override) => 'teamai/signal-owner' in override.rules)).toEqual([]);
});

it('names only files that still need what the rule lets them do', () => {
  const read = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');

  expect(OWNER).toEqual(['packages/shared/src/process-group.ts']);

  for (const file of [...OWNER, ...RUN_AS_IS, ...SCRIPT_TEXT]) expect(read(file), file).toMatch(/\bprocess\.kill\(/);

  for (const [file, name] of NOT_A_CHILD) expect(read(file), file).toContain(`${name}.kill(`);
});

it('holds every source file lint reads in this checkout, the packages\' and the scripts\' included', () => {
  // Each ignore pattern is a folder and all under it, so a file is linted unless it sits under one of those folders.
  const ignored = config.ignorePatterns.map((pattern) => /^(.+)\/\*\*$/.exec(pattern)?.[1]);
  expect(ignored).not.toContain(undefined);
  const files = execFileSync('git', ['ls-files', '*.ts', '*.js', '*.mjs', '*.cjs'], { cwd: REPO, encoding: 'utf8' }).split('\n')
    .filter((file) => file !== '' && !ignored.some((folder) => file.startsWith(`${folder}/`)));

  expect(files.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(1000);
  expect(files.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(300);
  expect(files.filter((file) => file.startsWith('scripts/')).length).toBeGreaterThan(20);
  expect(files.filter((file) => file.endsWith('.mjs')).length).toBeGreaterThan(5);
});
