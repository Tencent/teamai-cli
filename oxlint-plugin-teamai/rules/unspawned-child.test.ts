import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/unspawned-child', { filename: 'packages/shared/src/stop.test.ts' });

const MESSAGE = 'its kill() signals pid 0';

rule.invalid('rejects a ChildProcess built with new in a test, as a fake child', `import { ChildProcess } from 'node:child_process';
const child = new ChildProcess();
Object.defineProperty(child, 'pid', { value: 2147483647 });`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects one imported under another name, or read off the module', `import cp, { ChildProcess as Child } from 'child_process';
import * as childProcess from 'node:child_process';
export const fakes = [new Child(), new cp.ChildProcess(), new childProcess.ChildProcess()];`, (output) => {
  expect(output.match(/its kill\(\) signals pid 0/g)).toHaveLength(3);
});

rule.invalid('rejects a class that extends it, whose super() builds the same handle', `import { ChildProcess } from 'node:child_process';
class FakeChild extends ChildProcess {}
export const Fake = class extends ChildProcess {};
export const child = new FakeChild();`, (output) => {
  expect(output.match(/its kill\(\) signals pid 0/g)).toHaveLength(2);
});

rule.invalid('rejects it called as a function on an object, which installs the same handle with no new', `import { ChildProcess } from 'node:child_process';
const child: ChildProcess = Object.create(ChildProcess.prototype);
ChildProcess.call(child);
ChildProcess.apply(child, []);
Reflect.apply(ChildProcess, child, []);
export const built = Reflect.construct(ChildProcess, []);`, (output) => {
  expect(output.match(/its kill\(\) signals pid 0/g)).toHaveLength(4);
});

rule.invalid('rejects one in production source', `import { ChildProcess } from 'node:child_process';
export const placeholder = new ChildProcess();`, undefined, { filename: 'src/launch.ts' });

rule.invalid('rejects one in a folder and package no rule names, with no rule edit', `import { ChildProcess } from 'node:child_process';
export const child = new ChildProcess();`, undefined, { filename: 'packages/runtime-new/src/testing/fake.ts' });

rule.valid('allows a fake with no handle, built off the prototype', `import { ChildProcess } from 'node:child_process';
const child: ChildProcess = Object.create(ChildProcess.prototype);
export { child };`);

rule.valid('allows a spawned child, and a class of its own named ChildProcess', `import { spawn } from 'node:child_process';
class ChildProcess {}
export const children = [spawn('true'), new ChildProcess()];`);

const Config = z.object({
  ignorePatterns: z.array(z.string()),
  rules: z.record(z.string(), z.unknown()),
  overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })),
});

const config = Config.parse(JSON.parse(fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')));

it('is an error in this checkout, with no file let off', () => {
  expect(config.rules['teamai/unspawned-child']).toBe('error');
  expect(config.overrides.filter((override) => 'teamai/unspawned-child' in override.rules)).toEqual([]);
});

it('holds every test file lint reads in this checkout, the packages\' included', () => {
  // Each ignore pattern is a folder and all under it, so a file is linted unless it sits under one of those folders.
  const ignored = config.ignorePatterns.map((pattern) => /^(.+)\/\*\*$/.exec(pattern)?.[1]);
  expect(ignored).not.toContain(undefined);
  const tests = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: REPO, encoding: 'utf8' }).split('\n')
    .filter((file) => file !== '' && !ignored.some((folder) => file.startsWith(`${folder}/`)));

  expect(tests.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(500);
  expect(tests.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(50);
});
