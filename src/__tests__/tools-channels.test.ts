import { describe, expect, it } from 'vitest';
import { CODEBUDDY_RULE_FORMAT } from '../resources/codebuddy-rule.js';
import { COPILOT_INSTRUCTIONS_FORMAT } from '../resources/copilot-instructions.js';
import { CURSOR_MDC_FORMAT } from '../resources/cursor-mdc.js';
import { JOYCODE_RULE_FORMAT } from '../resources/joycode-rule.js';
import { KIRO_STEERING_FORMAT } from '../resources/kiro-steering.js';
import type { McpFormat } from '../resources/mcp-format.js';
import { OMP_RULE_FORMAT } from '../resources/omp-rule.js';
import { QODER_RULE_FORMAT } from '../resources/qoder-rule.js';
import { getsRulesFromExtension, getsRulesFromSessionHook, ruleFormatById, ruleFormatForTool, type RuleFormat } from '../resources/rule-format.js';
import { TRAE_RULE_FORMAT } from '../resources/trae-rule.js';
import { AGENT_TOOLS, hookFormatOf, isToolId, mcpFormatOf, ruleFormatIdOf, runTimeRulesOf, hasDefaultHomeLeftovers, type HookFormat } from '../tools.js';
import { DEFAULT_TOOL_PATHS } from '../types.js';

const TOOL_IDS = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId);
const TOOLS_AND_A_CUSTOM_ONE = [...TOOL_IDS, 'my-ide'];

/** The per-tool tables the descriptor replaced, as they stood at 50fb7283. */
const BEFORE: {
  readonly ruleFormats: Readonly<Record<string, RuleFormat>>;
  readonly sessionHookRules: readonly string[];
  readonly extensionRules: readonly string[];
  readonly mcpFormats: Readonly<Record<string, McpFormat>>;
  readonly agentTools: readonly string[];
  /** hooks.ts `detectFormat` at 157516d4; every other tool took Claude's shape. */
  readonly hookFormats: Readonly<Record<string, HookFormat>>;
} = {
  ruleFormats: {
    cursor: CURSOR_MDC_FORMAT,
    joycode: JOYCODE_RULE_FORMAT,
    copilot: COPILOT_INSTRUCTIONS_FORMAT,
    kiro: KIRO_STEERING_FORMAT,
    qoder: QODER_RULE_FORMAT,
    'qoder-cn': QODER_RULE_FORMAT,
    trae: TRAE_RULE_FORMAT,
    'trae-cn': TRAE_RULE_FORMAT,
    codebuddy: CODEBUDDY_RULE_FORMAT,
    workbuddy: CODEBUDDY_RULE_FORMAT,
    omp: OMP_RULE_FORMAT,
  },
  sessionHookRules: ['codex', 'codex-internal', 'tcodex', 'zcode', 'dsh', 'muse'],
  extensionRules: ['pi'],
  mcpFormats: {
    claude: 'claude', 'claude-internal': 'claude', tclaude: 'claude', qoder: 'claude', 'qoder-cn': 'claude', kiro: 'claude',
    zcode: 'claude', omp: 'claude', trae: 'claude', 'trae-cn': 'claude', cursor: 'cursor', codex: 'codex', 'codex-internal': 'codex',
    tcodex: 'codex', codebuddy: 'buddy', workbuddy: 'buddy', opencode: 'opencode', copilot: 'copilot', pi: 'pi', muse: 'muse',
  },
  agentTools: [
    'claude', 'claude-internal', 'tclaude', 'codebuddy', 'codex', 'codex-internal', 'tcodex', 'cursor', 'copilot', 'joycode',
    'qoder', 'qoder-cn', 'kiro', 'zcode', 'omp', 'opencode', 'workbuddy', 'muse',
  ],
  hookFormats: { copilot: 'copilot', codex: 'codex', 'codex-internal': 'codex', tcodex: 'codex', muse: 'codex', zcode: 'zcode', cursor: 'cursor' },
};

const descriptorFormat = (tool: string): RuleFormat | undefined => {
  const id = ruleFormatIdOf(tool);
  return id === 'verbatim' ? undefined : ruleFormatById(id);
};

describe('the descriptor\'s channels agree with the tables they replaced', () => {
  it.each(TOOLS_AND_A_CUSTOM_ONE)('%s', (tool) => {
    expect(ruleFormatForTool(tool)).toBe(BEFORE.ruleFormats[tool]);
    expect(descriptorFormat(tool)).toBe(BEFORE.ruleFormats[tool]);

    expect(getsRulesFromSessionHook(tool)).toBe(BEFORE.sessionHookRules.includes(tool));
    expect(getsRulesFromExtension(tool)).toBe(BEFORE.extensionRules.includes(tool));
    expect(runTimeRulesOf(tool)).toBe(
      BEFORE.sessionHookRules.includes(tool) ? 'session-hook' : BEFORE.extensionRules.includes(tool) ? 'extension' : null,
    );

    const internal = ['claude-internal', 'codex-internal', 'tcodex'].includes(tool);
    expect(mcpFormatOf(tool)).toBe(internal ? null : BEFORE.mcpFormats[tool] ?? null);

    expect(hookFormatOf(tool)).toBe(BEFORE.hookFormats[tool] ?? 'claude');
  });

  it('renders agents for the same tools, and for the Trae editions their subagents directory added since', () => {
    expect([...AGENT_TOOLS].sort()).toEqual([...BEFORE.agentTools, 'trae', 'trae-cn'].sort());
  });

  it('marks the tools earlier releases left hooks and MCP servers for in the default home', () => {
    expect(TOOL_IDS.filter(hasDefaultHomeLeftovers)).toEqual(['pi', 'codebuddy', 'opencode', 'muse']);
  });
});
