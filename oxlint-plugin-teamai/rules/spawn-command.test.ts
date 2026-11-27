import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/spawn-command', { filename: 'src/workflow/shell-command.ts' });

rule.valid('allows tool-core\'s exec module to start processes through cross-spawn', `
import spawn from 'cross-spawn';
export const start = (command: string) => spawn(command, []);
`, { filename: 'packages/shared/src/exec.ts' });

rule.valid('allows a test to mock cross-spawn', `
import { vi } from 'vitest';
vi.mock('cross-spawn', () => ({ default: vi.fn() }));
import crossSpawn from 'cross-spawn';
export const spawned = crossSpawn;
`, { filename: 'src/__tests__/tool-launch-run.test.ts' });

rule.valid('allows starting a process through spawnCommand', `
import { spawnCommand } from '@teamai/shared/exec';
export const start = (command: string) => spawnCommand(command, [], {});
`);

rule.invalid('rejects importing cross-spawn in teamai\'s source', `
import crossSpawn from 'cross-spawn';
export const start = (command: string) => crossSpawn(command, []);
`);

rule.invalid('rejects importing cross-spawn in a workspace package other than tool-core\'s exec module', `
import spawn from 'cross-spawn';
export const start = (command: string) => spawn(command, []);
`, undefined, { filename: 'packages/runtime-paseo/src/daemon/sign-in.ts' });

rule.invalid('rejects loading cross-spawn at run time', `
export const load = () => import('cross-spawn');
`);

rule.invalid('rejects requiring cross-spawn', `
export const spawn = require('cross-spawn');
`, undefined, { filename: 'src/codex-trust.ts' });

rule.invalid('rejects re-exporting cross-spawn', `
export { default as spawn } from 'cross-spawn';
`);

rule.invalid('rejects re-exporting all of cross-spawn', `
export * from 'cross-spawn';
`);

rule.invalid('rejects loading cross-spawn through a require made with createRequire', `
import { createRequire } from 'node:module';
export const crossSpawn = createRequire(import.meta.url)('cross-spawn');
`);

rule.invalid('rejects loading cross-spawn through an aliased require', `
import { createRequire as requireFrom } from 'node:module';
const load = requireFrom(import.meta.url);
export const crossSpawn = load('cross-spawn');
`);

rule.valid('allows a require made with createRequire to load something else', `
import { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
export const yaml = load('yaml');
`);
