import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/tool-registry', { filename: 'src/pull.ts' });

rule.invalid('rejects a new module importing TOOLS', `import { TOOLS } from './tools.js';
export const homes = Object.keys(TOOLS);`, (output) => {
  expect(output).toContain('Read tools through src/tool-registry.ts');
  expect(output).toContain('TOOLS from src/tools.ts');
});

rule.invalid('rejects a type-only import of TOOLS', `import type { TOOLS } from './tools.js';
export type Shell = (typeof TOOLS)['claude']['hooks']['shell'];`);

rule.invalid('rejects the launch adapter table', `import { LAUNCH_ADAPTERS } from '../tool-launch/adapters.js';
export const confined = LAUNCH_ADAPTERS.claude.confined;`, (output) => {
  expect(output).toContain('LAUNCH_ADAPTERS from src/tool-launch/adapters.ts');
}, { filename: 'src/scorers/new-judge.ts' });

rule.invalid('rejects the session adapter registry', `import { ADAPTER_REGISTRY } from './adapters/index.js';
export const adapter = ADAPTER_REGISTRY.codex;`, undefined, { filename: 'src/session-flow/new-reader.ts' });

rule.invalid('rejects a namespace import of a table\'s module', `import * as tools from './tools.js';
export const ids = Object.keys(tools.TOOLS);`);

rule.invalid('rejects a dynamic import of a table\'s module', `export const load = () => import('./tools.js');`);

rule.invalid('rejects a table taken from a dynamic import', `export async function confined() {
  const { LAUNCH_ADAPTERS } = await import('../tool-launch/adapters.js');
  return LAUNCH_ADAPTERS.claude.confined;
}`, undefined, { filename: 'src/scorers/new-judge.ts' });

rule.invalid('rejects a dynamic import whose rest element may take a table', `export async function all() {
  const { LaunchAdapterId, ...rest } = await import('./tool-launch/adapters.js');
  return [LaunchAdapterId, rest];
}`);

rule.invalid('rejects a script reading TOOLS', `import { TOOLS } from '../src/tools.js';
export const ids = Object.keys(TOOLS);`, undefined, { filename: 'scripts/new-page.ts' });

rule.invalid('rejects a reader not yet moved once it no longer reads a table', `import { isToolId } from '../tool-registry.js';
export const known = isToolId('claude');`, (output) => {
  expect(output).toContain('remove it from NOT_YET_MOVED');
}, { filename: 'src/session-flow/index.ts' });

rule.invalid('rejects the session adapter registry in agent-session, which looks adapters up through getAdapter', `import { ADAPTER_REGISTRY } from './adapters/index.js';
export const adapter = ADAPTER_REGISTRY.codex;`, undefined, { filename: 'src/session-flow/agent-session.ts' });

rule.invalid('rejects reading the families directly', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
export const claude = BUILT_IN_TOOLS.claude.tools.claude;`, (output) => {
  expect(output).toContain('BUILT_IN_TOOLS from @teamai/tool-definitions');
});

rule.valid('allows a table built from the families to read them', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
export const TOOLS = { claude: BUILT_IN_TOOLS.claude.tools.claude };`, { filename: 'src/tools.ts' });

rule.valid('allows the registry', `import { TOOLS } from './tools.js';
export const ids = Object.keys(TOOLS);`, { filename: 'src/tool-registry.ts' });

rule.valid('allows a reader not yet moved', `import { ADAPTER_REGISTRY } from './adapters/index.js';
export const adapter = ADAPTER_REGISTRY.codex;`, { filename: 'src/session-flow/index.ts' });

rule.valid('allows types and lookups from the tables\' modules', `import type { ToolId, ToolDescriptor } from './tools.js';
import { descriptorOf, isToolId } from './tool-registry.js';
import { opencodeModelArgs } from './tool-launch/tools.js';
export const shell = (tool: ToolId): ToolDescriptor['hooks']['shell'] | undefined => isToolId(tool) ? descriptorOf(tool).hooks.shell : undefined;
export const args = opencodeModelArgs(undefined, 2);`);

rule.valid('allows a lookup taken from a dynamic import of a table\'s module', `export async function codexAdapter() {
  const { getAdapter } = await import('./session-flow/adapters/index.js');
  return getAdapter('codex');
}`);

rule.valid('allows a test to read TOOLS', `import { TOOLS } from '../tools.js';
export const ids = Object.keys(TOOLS);`, { filename: 'src/__tests__/tools.test.ts' });

rule.valid('allows a test beside its source to read TOOLS', `import { TOOLS } from './tools.js';
export const ids = Object.keys(TOOLS);`, { filename: 'src/tools.test.ts' });

rule.valid('allows a TOOLS of another module', `import { TOOLS } from './benchmark/tools.js';
export const ids = Object.keys(TOOLS);`);

rule.valid('allows the registry\'s launch half to read the launch adapter table', `import { LAUNCH_ADAPTERS } from './adapters.js';
export const claude = LAUNCH_ADAPTERS.claude;`, { filename: 'src/tool-launch/tools.ts' });
