import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** ZCode. */
export const tools = {
  // ZCode 3.16.2 source; 3.15.1 not certified. Its CLI runs only user-level hooks, and reads servers under `mcp.servers` of its own config files.
  zcode: {
    home: { dir: '.zcode' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'inline', label: 'ZCode AGENTS.md' },
      project: { channel: 'session-hook', probe: 'zcode-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.zcode/AGENTS.md' }, reads: [{ base: 'home', path: '.zcode/AGENTS.md', evidence: 'source' }] },
      // hooks.maxOutputBytes defaults to 32768 (zcode.z.ai docs); ZCode drops a longer hook output whole.
      project: { channel: 'session-hook', probe: 'zcode-session-start', limit: 32768, evidence: 'source' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.zcode/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.zcode/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: true, format: 'claude', key: ['mcp', 'servers'], reads: [{ base: 'project', path: '.zcode/config.json', when: 'workspaceUnder', evidence: 'source' }] },
      retired: { user: ['.agents/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'zcode', reads: [{ base: 'home', path: '.zcode/cli/config.json', evidence: 'source' }] }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: 'none',
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'unknown',
    features: {
      env: '✓t',
      workflows: '+s',
      unattended: '?',
      recall: '✓s',
      stats: '✓s',
      tokens: '?',
      aiBackend: '+s',
      sessionJudge: { cell: '✓d', note: 'the built-in general-purpose subagent works in its own context; not run' },
      agentHooks: { cell: '+t', note: 'refused until teamai writes the hooks.events shape (#1224)' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
