import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { entriesUnder } from '@teamai/shared/entries-under';

import { reachesSource, sourceModules } from '../imports.js';
import { lintWithOptions, ruleHarness } from '../test/harness.ts';
import { FAMILY, PROCESS_STARTERS } from '../utils.js';
import { familySource } from './tool-family-shape.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/tool-family-shape', { filename: 'packages/tool-claude/src/launch.ts' });

rule.valid('allows a family\'s launch profile that builds a step\'s argv', `export const launch = { claude: { step: { evidence: 'verified', unattended: 'none', args: (input: { prompt: string }) => ['-p', input.prompt] } } } as const;`);

rule.invalid('rejects a family spawning its tool', `import { spawn } from 'node:child_process';
export const run = () => spawn('codex', ['exec']);`, (output) => {
  expect(output).toContain('A tool family builds argv and reads output, and never starts a process: packages/tool-codex/src/launch.ts imports node:child_process');
}, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects every value of the shared exec module, and child_process loaded at run time', `import { execCommand } from '@teamai/shared/exec';
export const run = () => [execCommand('sqlite3', []), require('child_process')];`, (output) => {
  expect(output).toContain('imports @teamai/shared/exec');
  expect(output).toContain('imports child_process');
}, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects a workspace module that starts a process for its caller, and cross-spawn', `import { resolveCliPath } from '@teamai/shared/cli-path';
import spawn from 'cross-spawn';
export const where = () => resolveCliPath('zzz');
export const run = () => spawn('zzz');`, (output) => {
  expect(output).toContain('imports @teamai/shared/cli-path');
  expect(output).toContain('imports cross-spawn');
}, { filename: 'packages/tool-zzz/src/detect.ts' });

rule.valid('allows the types of the shared exec module', `import type { ExecResult } from '@teamai/shared/exec';
export const ok = (result: ExecResult) => result.code === 0;`, { filename: 'packages/tool-codex/src/launch.ts' });

rule.invalid('rejects an index.ts exporting more than family', `export const family = {} as const;
export { ClaudeCodeAdapter } from './session-adapter.js';`, (output) => {
  expect(output).toContain("A tool family's index.ts exports only `family`");
  expect(output).toContain('also exports ClaudeCodeAdapter');
}, { filename: 'packages/tool-claude/src/index.ts', files: { 'packages/tool-claude/src/session-adapter.ts': 'export class ClaudeCodeAdapter {}' } });

rule.valid('allows an index.ts that exports only family', `import { tools } from './definitions.js';
export const family = { tools } as const;
export type { Family } from './definitions.js';`, { filename: 'packages/tool-claude/src/index.ts', files: { 'packages/tool-claude/src/definitions.ts': 'export const tools = {}; export type Family = 1;' } });

rule.invalid('covers a family package added later, in a folder of its own, with no rule edit', `import { execFile } from 'node:child_process';
export const run = () => execFile('zzz');`, (output) => {
  expect(output).toContain('packages/tool-zzz/src/readers/run.ts imports node:child_process');
}, { filename: 'packages/tool-zzz/src/readers/run.ts' });

rule.valid('leaves the launch library alone', `import { spawn } from 'node:child_process';
export const run = () => spawn('x');`, { filename: 'packages/tool-launch/src/run-step-launch.ts' });

rule.valid('leaves a family\'s tests alone', `import { execFileSync } from 'node:child_process';
export const fifo = () => execFileSync('mkfifo', ['x']);`, { filename: 'packages/tool-claude/src/launch.test.ts' });

rule.valid('leaves a family\'s test support alone', `import { spawn } from 'node:child_process';
export const fake = () => spawn('claude');`, { filename: 'packages/tool-claude/src/testing/fake-claude.ts' });

rule.invalid('rejects a process start in any family file, with no list of exceptions', `import { spawnSync } from 'node:child_process';
export const read = () => spawnSync('sqlite3');`, (output) => {
  expect(output).toContain('packages/tool-codex/src/store.ts imports node:child_process');
}, { filename: 'packages/tool-codex/src/store.ts' });

it('takes no option, so no file can be listed as still starting a process', () => {
  const { status, output } = lintWithOptions('teamai/tool-family-shape', [{ stillSpawns: [] }]);

  expect(status, output).not.toBe(0);
  expect(output).toContain("Rule 'teamai/tool-family-shape' does not accept options");
});

it('matches every family\'s production source in this checkout, and no infrastructure package', () => {
  const files = entriesUnder(path.join(REPO, 'packages')).map(({ relative }) => relative)
    .filter((file) => !file.includes('node_modules'))
    .map((file) => `packages/${file.split(path.sep).join('/')}`);
  const matched = files.filter((file) => familySource(file) !== undefined);
  const families = new Set(matched.map((file) => file.split('/')[1]));

  expect(matched.length).toBeGreaterThan(50);
  expect(families).toContain('tool-claude');
  expect(families).toContain('tool-opencode');
  expect([...families].filter((folder) => /^tool-(?:core|testing|definitions|launch)$/.test(folder))).toEqual([]);
  expect(matched.filter((file) => /\.test\.ts$|\/src\/testing\//.test(file))).toEqual([]);
});

/**
 * The module names each workspace package but a family exports, with the source file behind each; a `*` export gives
 * one per file. Families are left out: only @teamai/tool-definitions may import one (teamai/package-boundaries).
 */
function workspaceModules(): Array<[string, string]> {
  const ManifestSchema = z.object({ name: z.string(), exports: z.record(z.string(), z.string()).optional() });

  return fs.readdirSync(path.join(REPO, 'packages')).flatMap((folder) => {
    const file = path.join(REPO, 'packages', folder, 'package.json');

    if (FAMILY.test(folder) || !fs.existsSync(file)) return [];
    const { name, exports = {} } = ManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

    return Object.entries(exports).filter(([, target]) => target.endsWith('.ts')).flatMap(([subpath, target]): Array<[string, string]> => {
      if (!target.includes('*')) return [[`${name}${subpath.slice(1)}`, path.join(REPO, 'packages', folder, target)]];
      const dir = path.join(REPO, 'packages', folder, path.dirname(target));

      return entriesUnder(dir).map(({ relative }) => relative).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
        .map((entry): [string, string] => [`${name}${subpath.slice(1).replace('*', entry.replace(/\.ts$/, '').split(path.sep).join('/'))}`, path.join(dir, entry)]);
    });
  });
}

it('lists exactly the workspace modules that start a process, so a new wrapper is caught and a stale entry goes', () => {
  const NODE_STARTERS = new Set(['child_process', 'node:child_process', 'cross-spawn']);
  const modules = workspaceModules();
  const fileOf = new Map(modules);
  const verdicts = new Map<string, boolean>();
  // A module starts one through node, or through another workspace module it imports by name.
  const starts = (file: string): boolean => {
    const known = verdicts.get(file);

    if (known !== undefined) return known;
    verdicts.set(file, false);
    const verdict = sourceModules(file, false).some((specifier) => {
      const target = fileOf.get(specifier);

      return NODE_STARTERS.has(specifier) || (target !== undefined && reachesSource(target, starts, false) !== undefined);
    });

    verdicts.set(file, verdict);

    return verdict;
  };
  const starters = modules.filter(([, file]) => reachesSource(file, starts, false) !== undefined).map(([name]) => name);

  expect(starters).toContain('@teamai/shared/exec');
  expect(starters.filter((name) => !PROCESS_STARTERS.has(name))).toEqual([]);
  expect([...PROCESS_STARTERS].filter((name) => !NODE_STARTERS.has(name) && !starters.includes(name))).toEqual([]);
});
