import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { ruleHarness } from '../test/harness.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/piped-git', { filename: 'src/__tests__/x.test.ts' });

rule.invalid('rejects a hook that pipes git log into grep', `receiveHook(origin, 'while read old new ref; do git log -1 --format=%s "$new" | grep -q Cancel && exit 1; done; exit 0');`,
  (output) => { if (!output.includes('|| exit 1')) throw new Error(output); });
rule.invalid('rejects a piped git in a template with interpolations', 'receiveHook(origin, `while read old new ref; do git diff --name-only "$old" "$new" | grep -q "runs/${id}.json" && exit 1; done`);');
rule.invalid('rejects a piped git in a hook written by hand', 'fs.writeFileSync(hook, `#!/bin/sh\\ngit log --format=%s "$old..$new" | grep -q x && exit 1\\n`, { mode: 0o755 });');
rule.invalid('holds production source too', `execSync('git status --porcelain | wc -l');`, undefined, { filename: 'src/commands/status.ts' });
rule.invalid('holds a folder added later, with no rule edit', `const script = 'git rev-list HEAD | head -1';`, undefined, { filename: 'packages/tool-newcomer/src/__tests__/a.test.ts' });
rule.invalid('rejects a piped git whose stderr goes to its stdout', `execSync('git log --format=%s 2>&1 | grep -q x');`, undefined, { filename: 'src/commands/status.ts' });
rule.valid('allows a git that runs in the background before another command', `receiveHook(origin, 'git gc & echo started | tee log');`);
rule.valid('allows a git whose output is captured and checked first', `receiveHook(origin, 'while read old new ref; do subjects=$(git log --format=%s "$old..$new") || exit 1; echo "$subjects" | grep -q Cancel && exit 1; done; exit 0');`);
rule.valid('allows a git followed by ||', `receiveHook(origin, 'git rev-parse HEAD || exit 1');`);
rule.valid('allows a pipe that does not start at git', `receiveHook(origin, 'echo "$ref" | grep -q main && exit 1; git log -1');`);
rule.valid('leaves the fixtures of a lint rule alone', `const fixture = 'git log | grep x';`, { filename: 'oxlint-plugin-teamai/rules/other.test.ts' });
rule.valid('allows a Markdown table row that names a git command', `expect(markdown).toContain('| git worktree add, first run | none / 17 |');`);
rule.valid('allows a word that only starts with git', `const s = 'gitAnswer | other';`);

it('is an error in this checkout, with no file let off', () => {
  const config = fs.readFileSync(path.join(REPO, '.oxlintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = z.object({ rules: z.record(z.string(), z.unknown()), overrides: z.array(z.object({ rules: z.record(z.string(), z.unknown()) })) }).parse(JSON.parse(config));

  expect(parsed.rules['teamai/piped-git']).toBe('error');
  expect(parsed.overrides.filter((override) => 'teamai/piped-git' in override.rules)).toEqual([]);
});
