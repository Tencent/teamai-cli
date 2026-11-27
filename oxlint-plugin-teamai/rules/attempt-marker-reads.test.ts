import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { entriesUnder } from '@teamai/shared/entries-under';
import { ruleHarness } from '../test/harness.ts';
import { isAttemptMarkerReadChecked, MARKER_READERS } from './attempt-marker-reads.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MESSAGE = 'Read the attempt marker through markedAttempt';
const IMPORTED = `import { ATTEMPT_ENV } from '../launch-context.js';\n`;

const rule = ruleHarness('teamai/attempt-marker-reads', { filename: 'src/workflow/engine.ts' });
const { valid, invalid } = rule;

invalid('rejects reading the marker off process.env', `${IMPORTED}export const marker = process.env[ATTEMPT_ENV];`, (output) => expect(output).toContain(MESSAGE));
invalid('rejects splitting the marker of an env a function is given', `${IMPORTED}export const run = (env: NodeJS.ProcessEnv) => (env[ATTEMPT_ENV] ?? '').split('/')[0];`);
invalid('rejects the marker read under another name', `import { ATTEMPT_ENV as MARKER } from '../launch-context.js';\nexport const marker = (env: NodeJS.ProcessEnv) => env[MARKER];`);
invalid('rejects the marker taken apart from an env', `${IMPORTED}export const marker = (env: NodeJS.ProcessEnv) => { const { [ATTEMPT_ENV]: value } = env; return value; };`);
invalid('rejects removing the marker by taking it apart, and names the helper that removes it', `${IMPORTED}export const { [ATTEMPT_ENV]: _marker, ...unmarked } = process.env;`, (output) => expect(output).toContain('withoutAgentEvidence'));
invalid('rejects the marker read by its spelling', `export const marker = (env: NodeJS.ProcessEnv) => env['TEAMAI_WORKFLOW_ATTEMPT'];`, (output) => expect(output).toContain(MESSAGE));
invalid('rejects a read in a folder no rule names yet', `${IMPORTED}export const marker = process.env[ATTEMPT_ENV];`, undefined, { filename: 'src/brand-new-area/reader.ts' });
invalid("rejects a read in a package module that shares a reader's file name", `import { ATTEMPT_ENV } from 'teamai/launch-context';\nexport const marker = process.env[ATTEMPT_ENV];`, undefined, { filename: 'packages/brand-new/src/launch-context.ts' });
invalid('rejects a read in a package no rule names yet', `import { ATTEMPT_ENV } from 'teamai/launch-context';\nexport const marker = process.env[ATTEMPT_ENV];`, undefined, { filename: 'packages/brand-new/src/reader.ts' });

valid('allows setting the marker for a process teamai starts', `${IMPORTED}export const mark = (env: NodeJS.ProcessEnv, marker: string) => { env[ATTEMPT_ENV] = marker; };`);
valid('allows building an env with the marker, or without it', `${IMPORTED}export const unmarked = { ...process.env, [ATTEMPT_ENV]: undefined };`);
valid('allows removing the marker', `${IMPORTED}export const unmark = (env: NodeJS.ProcessEnv) => { delete env[ATTEMPT_ENV]; };`);
valid('allows the module that parses the marker', `${IMPORTED}export const marker = (env: NodeJS.ProcessEnv) => env[ATTEMPT_ENV];`, { filename: 'src/workflow/attempt-marker.ts' });
valid('allows the module that names the marker', `const ATTEMPT_ENV = 'TEAMAI_WORKFLOW_ATTEMPT';\nexport const launcher = (markers: Record<string, string>) => markers[ATTEMPT_ENV];`, { filename: 'src/launch-context.ts' });
valid('allows tests, which build and read the env they launch with', `${IMPORTED}export const marker = process.env[ATTEMPT_ENV];`, { filename: 'src/__tests__/engine.test.ts' });

it('matches the production source of src/ and of every package in this checkout, but its readers', () => {
  const sources = (dir: string) => entriesUnder(path.join(REPO, dir))
    .map(({ relative }) => `${dir}/${relative.split(path.sep).join('/')}`)
    .filter((file) => !file.includes('node_modules'));
  const matched = [...sources('src'), ...sources('packages')].filter(isAttemptMarkerReadChecked);

  expect(matched.filter((file) => file.startsWith('src/')).length).toBeGreaterThan(500);
  expect(matched.filter((file) => file.startsWith('packages/')).length).toBeGreaterThan(150);
  expect(matched.filter((file) => /\.test\.|\/__tests__\/|\/testing\//.test(file))).toEqual([]);
  expect(matched.filter((file) => MARKER_READERS.includes(file))).toEqual([]);
});

it.each(MARKER_READERS)('names reader %s, which exists', (file) => {
  expect(fs.existsSync(path.join(REPO, file))).toBe(true);
});
