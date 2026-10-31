import { ruleHarness } from '../test/harness.ts';
const rule = ruleHarness('teamai/rules-locate', { filename: 'src/resources/rules.ts' });
rule.invalid('rejects MCP lookup during rules activation', `locate(tool, 'mcp', install);`);
rule.valid('allows rules lookups', `locate(tool, 'rules', install);`);
rule.valid('allows MCP in its own resource handler', `locate(tool, 'mcp', install);`, { filename: 'src/resources/mcp.ts' });
