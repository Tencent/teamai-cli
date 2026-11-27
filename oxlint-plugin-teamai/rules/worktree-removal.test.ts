import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';
import { ALLOWED, inScope } from './worktree-removal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/worktree-removal', { filename: 'src/workflow/worktree.ts' });

const MESSAGE = 'Remove a worktree with removeWorktree';

/** `body` as the body of function `name`, with the declarations the owner's file needs to lint alone. */
const inFunction = (name: string, body: string): string => `declare function git(cwd: string, args: string[]): Promise<{ code: number }>;
export async function ${name}(main: string, dir: string): Promise<void> {
  ${body}
}
`;

const owner = `declare function git(cwd: string, args: string[]): Promise<{ code: number }>;
export async function forgetGoneWorktrees(main: string): Promise<void> {
  await git(main, ['worktree', 'prune']);
}
export async function removeWorktree(main: string, dir: string): Promise<void> {
  await forgetGoneWorktrees(main);
  await git(main, ['worktree', 'remove', '--force', dir]);
}
`;

rule.valid('allows the removal and the prune in their owner', owner);

rule.invalid('rejects a forced removal beside the owner, in its own file', `${owner}
export async function removeRunWorktree(main: string, dir: string): Promise<void> {
  await git(main, ['worktree', 'remove', '--force', dir]);
}
`, (output) => {
  expect(output).toContain(MESSAGE);
  expect(output).toContain('1 errors');
});

rule.invalid('rejects a function of the owner\'s name in another file', inFunction('removeWorktree', "await git(main, ['worktree', 'remove', '--force', dir]);"), (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'src/workflow/place/clone.ts' });

rule.invalid('rejects a prune through simple-git raw, by array and by arguments', inFunction('sweep', "const raw = (...args: unknown[]) => args;\n  raw(['worktree', 'prune']);\n  raw('worktree', 'prune');"), (output) => {
  expect(output).toContain('2 errors');
}, { filename: 'src/utils/learnings-branch.ts' });

rule.invalid('rejects a removal behind global options', inFunction('drop', "await git(main, ['-C', dir, 'worktree', 'remove', dir]);"), (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'scripts/verify/world.ts' });

rule.invalid('rejects a removal spelled as template literals', inFunction('drop', 'await git(main, [`worktree`, `remove`, dir]);'), (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('holds a package added later, with no rule edit', inFunction('close', "await git(main, ['worktree', 'remove', '--force', dir]);"), (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'packages/runtime-newcomer/src/place.ts' });

rule.valid('allows the git calls that remove nothing', inFunction('make', "await git(main, ['worktree', 'add', '-b', 'x', dir]);\n  await git(main, ['worktree', 'list', '--porcelain']);\n  await git(main, ['remove', 'worktree']);"), { filename: 'src/workflow/place/clone.ts' });

for (const filename of ['src/__tests__/leftovers.test.ts', 'packages/runtime-t3/src/place.test.ts', 'src/testing/fixture.ts', 'packages/runtime-sandbox/src/testing/fake.ts']) {
  rule.valid(`leaves test code alone: ${filename}`, inFunction('fixture', "await git(main, ['worktree', 'remove', '--force', dir]);"), { filename });
}

rule.valid('allows upstream\'s own removal in the function the rule lists for it', inFunction('rejectedTeamFiles', "await git(main, ['worktree', 'prune']);\n  await git(main, ['worktree', 'remove', '--force', '--', dir]);"), { filename: 'src/workflow/place/team.ts' });

rule.invalid('rejects a removal in another function of a file the rule lets off', `${inFunction('rejectedTeamFiles', "await git(main, ['worktree', 'prune']);")}
export async function removeTeamClone(main: string, dir: string): Promise<void> {
  await git(main, ['worktree', 'remove', '--force', dir]);
}
`, (output) => {
  expect(output).toContain(MESSAGE);
  expect(output).toContain('1 errors');
}, { filename: 'src/workflow/place/team.ts' });

rule.invalid('names a let-off function its file no longer declares, so the list only shrinks', inFunction('renamedAway', "await git(main, ['worktree', 'list']);"), (output) => {
  expect(output).toContain('removeDataCheckout');
  expect(output).toContain('no longer removes one');
}, { filename: 'src/workflow/place/data.ts' });

rule.invalid('names a let-off function that no longer removes a worktree, so the list only shrinks', inFunction('removeDataCheckout', "await git(main, ['worktree', 'list']);"), (output) => {
  expect(output).toContain('removeDataCheckout');
  expect(output).toContain('no longer removes one');
}, { filename: 'src/workflow/place/data.ts' });

rule.valid('lets off an allowed function written as an arrow', `declare function git(cwd: string, args: string[]): Promise<{ code: number }>;
export const removeDataCheckout = async (main: string): Promise<void> => { await git(main, ['worktree', 'prune']); };
`, { filename: 'src/workflow/place/data.ts' });

it('holds every file of this checkout but its tests, scripts and packages included', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  const matched = files.filter(inScope);

  expect(matched).toContain('src/workflow/worktree.ts');
  expect(matched).toContain('scripts/agent-wait-budget.ts');
  expect(matched.some((file) => file.startsWith('packages/'))).toBe(true);
  expect(matched.length).toBeGreaterThan(1000);
  expect(matched.filter((file) => /\.test\.|\/__tests__\/|(^|\/)src\/testing\//.test(file))).toEqual([]);
});

it('lists only functions their files still declare', () => {
  for (const { file, functions } of ALLOWED) {
    const source = fs.readFileSync(path.join(REPO, file), 'utf8');

    for (const name of functions) expect(source, `${file} ${name}`).toMatch(new RegExp(String.raw`function ${name}\b`));
  }
});

it('is an error in this checkout, with no file let off', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = z.object({ rules: z.record(z.string(), z.unknown()), overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })) }).parse(JSON.parse(config));

  expect(parsed.rules['teamai/worktree-removal']).toBe('error');
  expect(parsed.overrides.filter((override) => 'teamai/worktree-removal' in override.rules)).toEqual([]);
});
