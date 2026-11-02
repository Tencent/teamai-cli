import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const TOOLS_SOURCE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools.ts'), 'utf8');
const files = { 'src/tools.ts': TOOLS_SOURCE };
/** The ids `TOOL_IDS` lists, which the type check holds `TOOLS` to: a second source for the keys the rule reads. */
const TOOL_IDS = [...(/export const TOOL_IDS = \[([^\]]*)\] as const/.exec(TOOLS_SOURCE)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
const rule = ruleHarness('teamai/tool-facts', { filename: 'src/hooks.ts' });

describe('teamai/tool-facts', () => {
  rule.invalid('reports a partial set of tools', `const SUBAGENT_STOP_TOOLS = new Set(['claude', 'codebuddy']);`, (output) => {
    expect(output).toContain('TOOLS');
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

  rule.valid('allows a list in TOOLS itself', `const ORDER = ['claude', 'codex'];`, { filename: 'src/tools.ts', files: { 'src/tools.ts': TOOLS_SOURCE } });

  rule.valid('allows an explained exception', `
// oxlint-disable-next-line teamai/tool-facts -- the picker order; membership comes from TOOLS
const CHOICES = ['claude', 'codex'];
`, { files });

  rule.valid('stays out of tests', `const LIST = ['claude', 'codex'];`, { filename: 'src/__tests__/x.test.ts', files });

  // A tool missing from what the rule reads would let its tables through, so every id of TOOLS must be caught.
  it('finds the TOOL_IDS list it checks against', () => {
    expect(TOOL_IDS).toContain('claude');
    expect(TOOL_IDS).toContain('agy');
  });
  for (const tool of TOOL_IDS) {
    rule.invalid(`knows the tool ${tool}`, `const LIST = new Set(['${tool}', '${tool === 'claude' ? 'codex' : 'claude'}']);`, undefined, { files });
  }
});
