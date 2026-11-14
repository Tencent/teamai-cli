import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ruleHarness } from '../test/harness.ts';

const TOOL_IDS_FILE = 'oxlint-plugin-teamai/tool-ids.generated.json';
/** The shipped tool ids `node scripts/check-docs.mjs --write` generates from the tool registry, which the rule reads. */
const TOOL_IDS = z.array(z.string()).parse(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', TOOL_IDS_FILE), 'utf8')));
const WORKSPACE = JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'] });
const files = { 'package.json': WORKSPACE, [TOOL_IDS_FILE]: JSON.stringify(TOOL_IDS) };
const rule = ruleHarness('teamai/tool-facts', { filename: 'src/hooks.ts' });

describe('teamai/tool-facts', () => {
  rule.invalid('reports a partial set of tools', `const SUBAGENT_STOP_TOOLS = new Set(['claude', 'codebuddy']);`, (output) => {
    expect(output).toContain('packages/tool-<family>/');
  }, { files });

  rule.invalid('reports a list typed against ToolId', `const LIST = ['claude', 'codex'] as const satisfies readonly ToolId[];`, undefined, { files });

  rule.invalid('reports a tool list inside a function', `
function exclusionOnly(agentKey: string): boolean {
  return ['pi', 'omp', ...CODEX_TOOL_IDS].includes(agentKey);
}
`, undefined, { files });

  rule.invalid('reports a partial table keyed by tool', `
const SHELLS: Record<string, () => string | null> = { workbuddy: resolveWorkbuddy, codebuddy: resolveCodebuddy };
`, undefined, { files });

  rule.invalid('reports a Partial<Record<ToolId, ...>> table', `
const ALIASES = { tclaude: 'claude', tcodex: 'codex' } satisfies Partial<Record<ToolId, ToolId>>;
`, undefined, { files });

  rule.valid('allows a table keyed by every tool', `
const DETECTORS = { claude: detectClaude, codex: null } satisfies Record<ToolId, Detector | null>;
`, { files });

  rule.valid('allows a table keyed by another closed union whose members share tool names', `
const FORMATS: Record<McpFormat, string> = { claude: 'mcpServers', codex: 'mcp_servers' };
`, { files });

  rule.valid('allows a table keyed by part of another closed union', `
export const MCP_SERVER_KEY: Record<Exclude<McpFormat, 'codex'>, string> = { claude: 'mcpServers', opencode: 'mcp' };
`, { files });

  rule.valid('allows an exhaustive table written as const', `
const SHELLS = { claude: 'system', codex: 'system' } as const satisfies Record<ToolId, string>;
`, { files });

  rule.valid('allows a typed value a function returns', `
function rootsOf(): AgentRoots {
  return { claude: rootOf('claude'), codex: rootOf('codex') };
}
`, { files });

  rule.invalid('reports a partial table written as const', `
const SHELLS = { workbuddy: 'bundled', codebuddy: 'bundled' } as const;
`, undefined, { files });

  rule.valid('allows one tool id', `if (tool === 'claude' || ['x', 'claude'].includes(name)) run();`, { files });

  rule.valid('allows a list in TOOLS itself', `const ORDER = ['claude', 'codex'];`, { filename: 'src/tools.ts', files });

  rule.invalid('reports a partial set of tools in a workspace package', `export const SHELLS = { workbuddy: 'bundled', codebuddy: 'bundled' } as const;`, undefined, {
    filename: 'packages/tool-codebuddy/src/shells.ts',
    files: { ...files, 'packages/tool-codebuddy/package.json': JSON.stringify({ name: '@teamai/tool-codebuddy', private: true }) },
  });

  rule.valid('stays out of a test beside its source in a workspace package', `const LIST = ['claude', 'codex'];`, {
    filename: 'packages/tool-claude/src/launch.test.ts',
    files: { ...files, 'packages/tool-claude/package.json': JSON.stringify({ name: '@teamai/tool-claude', private: true }) },
  });

  const family = { ...files, 'packages/tool-claude/package.json': JSON.stringify({ name: '@teamai/tool-claude', private: true }) };

  rule.valid('allows the descriptors a family declares', `
export const tools = { claude: { launch: 'claude' }, tclaude: { launch: 'claude' } } as const satisfies Record<string, ToolDescriptor>;
`, { filename: 'packages/tool-claude/src/definitions.ts', files: family });

  rule.valid('allows the session platforms a family declares', `
export const platforms = { tclaude: TCLAUDE, 'claude-internal': INTERNAL } as const satisfies Record<string, SessionPlatformDefinition>;
`, { filename: 'packages/tool-claude/src/sessions.ts', files: family });

  rule.valid('allows the launch profiles a family declares', `
export const launch = { pi: PI, omp: OMP } as const satisfies Record<string, LaunchAdapter>;
`, { filename: 'packages/tool-pi/src/launch.ts', files: { ...files, 'packages/tool-pi/package.json': JSON.stringify({ name: '@teamai/tool-pi', private: true }) } });

  rule.valid('allows the version detectors a family declares', `
export const detect = { codebuddy: CLI, workbuddy: () => app('/Applications/WorkBuddy.app') } as const satisfies Record<string, VersionDetector>;
`, { filename: 'packages/tool-codebuddy/src/detect.ts', files: { ...files, 'packages/tool-codebuddy/package.json': JSON.stringify({ name: '@teamai/tool-codebuddy', private: true }) } });

  rule.valid('allows the families tool-definitions lists', `
export const BUILT_IN_TOOLS = { claude, codex } as const satisfies Readonly<Record<string, ToolFamily>>;
`, { filename: 'packages/tool-definitions/src/registry.ts', files: { ...files, 'packages/tool-definitions/package.json': JSON.stringify({ name: '@teamai/tool-definitions', private: true }) } });

  rule.invalid('reports descriptors declared outside a family package', `
export const tools = { claude: { launch: 'claude' }, tclaude: { launch: 'claude' } } as const satisfies Record<string, ToolDescriptor>;
`, undefined, { files });

  rule.invalid('reports another table keyed by tools in a family package', `
export const COMMANDS = { claude: 'claude', tclaude: 'tclaude' } as const satisfies Record<string, string>;
`, undefined, { filename: 'packages/tool-claude/src/commands.ts', files: family });

  rule.invalid('reports a family list outside tool-definitions', `
export const FAMILIES = { claude, codex } as const satisfies Readonly<Record<string, ToolFamily>>;
`, undefined, { files });

  rule.invalid('fails when the generated tool ids are missing, instead of checking nothing', `export const ok = 1;`, (output) => {
    expect(output).toContain('oxlint-plugin-teamai/tool-ids.generated.json');
    expect(output).toContain('node scripts/check-docs.mjs --write');
  }, { files: { 'package.json': WORKSPACE } });

  rule.invalid('fails when the generated tool ids are empty', `export const ok = 1;`, (output) => {
    expect(output).toContain('node scripts/check-docs.mjs --write');
  }, { files: { 'package.json': WORKSPACE, [TOOL_IDS_FILE]: '[]' } });

  rule.valid('allows an explained exception', `
// oxlint-disable-next-line teamai/tool-facts -- the picker order; membership comes from TOOLS
const CHOICES = ['claude', 'codex'];
`, { files });

  rule.valid('stays out of tests', `const LIST = ['claude', 'codex'];`, { filename: 'src/__tests__/x.test.ts', files });

  // A tool missing from what the rule reads would let its tables through, so every shipped id must be caught.
  it('reads the shipped tool ids it checks against', () => {
    expect(TOOL_IDS).toContain('claude');
    expect(TOOL_IDS).toContain('agy');
  });
  for (const tool of TOOL_IDS) {
    rule.invalid(`knows the tool ${tool}`, `const LIST = new Set(['${tool}', '${tool === 'claude' ? 'codex' : 'claude'}']);`, undefined, { files });
  }
});
