import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ruleHarness } from '../test/harness.ts';
import { isProductionSource, isScriptSource } from '../utils.js';
import { BASE_ID_COMPARISONS, SHIPPED_ONLY } from './shipped-tool-ids.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/shipped-tool-ids', { filename: 'src/pull.ts' });

rule.invalid('rejects a format fact read through isToolId', `import { descriptorOf, isToolId } from './tool-registry.js';
export const shell = (tool: string) => isToolId(tool) ? descriptorOf(tool).hooks.shell : undefined;`, (output) => {
  expect(output).toContain('isToolId is false for a tool instance');
  expect(output).toContain('toolOf, baseToolOf, baseDescriptorOf, agentFormatOf or toolHomeOf');
});

rule.invalid('rejects isAgentToolId passed as a filter', `import { isAgentToolId } from '../tool-registry.js';
export const renders = (tools: string[]) => tools.filter(isAgentToolId);`, undefined, { filename: 'src/resources/new-reader.ts' });

rule.invalid('rejects a new folder with no rule edit', `import { isToolId } from '../tool-registry.js';
export const known = (tool: string) => isToolId(tool);`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a package\'s source with no rule edit', `export const known = (isToolId: (tool: string) => boolean) => isToolId('claude');`, undefined, { filename: 'packages/tool-acme/src/reader.ts' });

rule.invalid('rejects a repository script with no rule edit', `import { isToolId } from '../src/tool-registry.js';
export const known = (tool: string) => isToolId(tool);`, undefined, { filename: 'scripts/doc-checks/new-check.ts' });

rule.valid('allows a script\'s test', `import { isToolId } from '../src/tool-registry.js';
export const known = isToolId('claude');`, { filename: 'scripts/check-docs.test.ts' });

rule.invalid('rejects one reference more than a file\'s SHIPPED_ONLY count', `import { isToolId } from './tool-registry.js';
export const a = isToolId('a');
export const b = isToolId('b');
export const c = isToolId('c');
export const d = isToolId('d');`, undefined, { filename: 'src/locate.ts' });

rule.invalid('rejects a SHIPPED_ONLY count above what the file holds', `import { isToolId } from './tool-registry.js';
export const a = isToolId('a');`, (output) => {
  expect(output).toContain('fewer times than SHIPPED_ONLY allows');
}, { filename: 'src/locate.ts' });

rule.valid('allows a file its SHIPPED_ONLY count', `import { isToolId } from './tool-registry.js';
export const a = isToolId('a');
export const b = isToolId('b');
export const c = isToolId('c');`, { filename: 'src/locate.ts' });

rule.invalid('rejects a comparison with Codex\'s id as a string', `export const shared = (tool: string) => tool === 'codex';`, (output) => {
  expect(output).toContain('is false for an instance of that tool');
}, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a comparison with Claude Code\'s id by name', `import { CLAUDE_TOOL_ID } from './types.js';
export const reads = (tool: string) => tool !== CLAUDE_TOOL_ID;`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a switch case on Codex\'s id', `export const home = (tool: string) => { switch (tool) { case 'codex': return '.codex'; default: return undefined; } };`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a comparison with Codex\'s id in a repository script', `export const shared = (tool: string) => tool === 'codex';`, undefined, { filename: 'scripts/doc-checks/new-check.ts' });

rule.invalid('rejects one comparison more than a file\'s BASE_ID_COMPARISONS count', `export const a = (tool: string) => tool === 'codex' || tool === 'claude';`, undefined, { filename: 'src/init.ts' });

rule.invalid('rejects a BASE_ID_COMPARISONS count above what the file holds', 'export const none = 1;', (output) => {
  expect(output).toContain('fewer times than BASE_ID_COMPARISONS allows');
}, { filename: 'src/init.ts' });

rule.valid('allows a file its BASE_ID_COMPARISONS count', `export const a = (tool: string) => tool === 'codex';`, { filename: 'src/init.ts' });

rule.valid('allows a comparison of the tool an instance extends, and of another tool\'s id', `import { baseToolOf } from './tool-registry.js';
export const a = (tool: string) => baseToolOf(tool) === 'codex' || tool === 'cursor';`, { filename: 'src/new-area/reader.ts' });

rule.valid('allows a comparison of a format, a family or the tool an instance extends, however it is held', `import { hookFormatOf, launchAdapterIdOf, toolOf } from './tool-registry.js';
import type { McpFormat, ModelAgent } from './types.js';
export const a = (tool: string) => toolOf(tool)?.base === 'claude' || hookFormatOf(tool) === 'codex';
export const b = (tool: string, launched: boolean) => { const family = launched ? launchAdapterIdOf(tool) : undefined; return family === 'codex'; };
export const c = (target: { format: McpFormat }) => target.format === 'codex';
export const d = (agent: ModelAgent) => { switch (agent) { case 'claude': return 1; default: return 0; } };
export const e = (format: Exclude<McpFormat, 'json'>) => format === 'claude';`, { filename: 'src/new-area/reader.ts' });

rule.valid('allows a comparison of a closed union of shipped ids: a resolved field\'s type, or a switch whose default holds what it switches over as never', `import type { AgentTool } from './types.js';
export const b = (format: AgentTool['format']) => format === 'claude';
export const c = (target: { tool: 'claude' | 'codex' }) => { switch (target.tool) { case 'claude': return 1; case 'codex': return 2; default: { const unhandled: never = target.tool; return unhandled; } } };`, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a switch whose default holds another value as never', `export const a = (tool: string, other: never) => { switch (tool) { case 'codex': return 1; default: { const unhandled: never = other; return unhandled; } } };`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a comparison of a field that holds a tool\'s own name', `export const a = (tool: { name: string }['name']) => tool === 'codex';`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a local that held a resolved name until a tool\'s own name replaced it', `import { baseToolOf } from './tool-registry.js';
export const a = (tool: string) => { let family = baseToolOf(tool); family = tool; return family === 'codex'; };`, undefined, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a lookup in the list of Codex\'s shipped ids', `import { CODEX_TOOL_IDS } from './utils/tool-names.js';
export const codex = (tool: string) => CODEX_TOOL_IDS.some((id) => id === tool);`, (output) => {
  expect(output).toContain('isCodexTool(tool)');
}, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a substring test for Codex\'s id', `export const codex = (tool: string) => tool.toLowerCase().includes('codex');`, (output) => {
  expect(output).toContain('is false for an instance of that tool');
}, { filename: 'src/new-area/reader.ts' });

rule.invalid('rejects a lookup of Claude Code\'s id in a list of tool names', `import { CLAUDE_TOOL_ID } from './types.js';
export const delivers = (tools: string[]) => tools.includes(CLAUDE_TOOL_ID) || tools[0]?.startsWith('claude') === true;`, undefined, { filename: 'src/new-area/reader.ts' });

rule.valid('allows a lookup of another tool\'s id, and of the tool an instance extends', `import { baseToolOf } from './tool-registry.js';
export const a = (tools: string[]) => tools.includes('opencode') || baseToolOf(tools[0] ?? '').startsWith('codex');`, { filename: 'src/new-area/reader.ts' });

rule.valid('allows a name resolved through toolOf', `import { baseDescriptorOf, toolOf } from './tool-registry.js';
export const shell = (tool: string) => toolOf(tool) === undefined ? undefined : baseDescriptorOf(tool)?.hooks.shell;`, { filename: 'src/new-area/reader.ts' });

rule.valid('allows the registry that defines them', `export const isToolId = (value: string) => value in TOOLS;
export const ids = Object.keys(TOOLS).filter(isToolId);`, { filename: 'src/tool-registry.ts' });

rule.valid('allows a test', `import { isToolId } from '../tool-registry.js';
export const known = isToolId('claude');`, { filename: 'src/__tests__/tool-registry.test.ts' });

describe('in this checkout', () => {
  it('scopes the production source the rule reads', () => {
    const scoped = ['src', ...fs.readdirSync(path.join(REPO, 'packages')).map((folder) => `packages/${folder}/src`)]
      .filter((dir) => fs.existsSync(path.join(REPO, dir)))
      .flatMap((dir) => fs.readdirSync(path.join(REPO, dir), { recursive: true, encoding: 'utf8' }).map((file) => `${dir}/${file.split(path.sep).join('/')}`))
      .filter((file) => /\.[cm]?tsx?$/.test(file) && isProductionSource(file));

    expect(scoped.length).toBeGreaterThan(500);
  });

  it('names in SHIPPED_ONLY only production files that exist', () => {
    const entries = [...SHIPPED_ONLY.keys()];

    expect(entries.filter((file) => !fs.existsSync(path.join(REPO, file)) || !(isProductionSource(file) || isScriptSource(file)))).toEqual([]);
    expect([...SHIPPED_ONLY.values()].every(({ count }) => count > 0)).toBe(true);
  });

  it('names in BASE_ID_COMPARISONS only production or script files that exist', () => {
    expect([...BASE_ID_COMPARISONS.keys()].filter((file) => !fs.existsSync(path.join(REPO, file)) || !(isProductionSource(file) || isScriptSource(file)))).toEqual([]);
    expect([...BASE_ID_COMPARISONS.values()].every((count) => count > 0)).toBe(true);
  });
});
