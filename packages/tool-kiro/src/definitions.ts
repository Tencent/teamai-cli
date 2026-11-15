import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Kiro, which teamai launches as kiro-cli. */
export const tools = {
  kiro: {
    home: { dir: '.kiro' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'home', path: '.kiro/steering', evidence: 'docs' }] },
      project: { channel: 'dir', format: 'kiro-steering', reads: [{ base: 'project', path: '.kiro/steering', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'inclusion-always' }, reads: [{ base: 'home', path: '.kiro/steering', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'inclusion-always' }, reads: [{ base: 'project', path: '.kiro/steering', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.kiro/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.kiro/agents', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.kiro/settings/mcp.json', evidence: 'docs' }] },
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.kiro/settings/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Kiro CLI V3 loads every hook file in ~/.kiro/hooks, whatever agent runs (#1341).
    hooks: { user: { channel: 'adapter', adapter: 'kiro-hooks', evidence: 'docs' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Kiro CLI docs: sessions under ~/.kiro, moved by KIRO_HOME.
    sessions: 'none',
    launch: 'kiro',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '◐d',
      stats: '?',
      tokens: '?',
      aiBackend: '✓d',
      sessionJudge: { cell: '✓d', note: 'a subagent works in its own context window, without the conversation; not run' },
      agentHooks: { cell: '✓d', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; Kiro\'s hook docs' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
