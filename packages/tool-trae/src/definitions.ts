import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Trae and its China build, which keep their own home. */
export const tools = {
  // Trae keeps user MCP servers in its app-support directory, which teamai does not write.
  trae: {
    home: { dir: '.trae' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'home', path: '.trae/user_rules', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Trae loads `.trae/agents` only while its Beta "Enable Subagents Directory" switch is on, a setting teamai cannot read.
    agents: {
      // Its docs give ~/.trae-cn/agents, a copy of Trae CN's page; nothing shows ~/.trae/agents.
      user: 'unknown',
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Trae docs: chat history in the IDE's ModularData database, which no variable moves.
    sessions: 'none',
    launch: 'none',
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
      recall: '?',
      stats: '?',
      tokens: '?',
      aiBackend: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
  'trae-cn': {
    home: { dir: '.trae-cn' },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'trae', reads: 'unknown' },
      project: { channel: 'dir', format: 'trae', reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'home', path: '.trae-cn/user_rules', evidence: 'docs' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' }, reads: [{ base: 'project', path: '.trae/rules', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    // Trae CN loads them only while its Beta "Enable Subagents Directory" switch is on (on by default, its docs say).
    agents: {
      user: { reads: [{ base: 'home', path: '.trae-cn/agents', evidence: 'docs' }] },
      project: { reads: [{ base: 'project', path: '.trae/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    mcp: {
      user: 'none',
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.trae/mcp.json', when: 'workspaceUnder', evidence: 'docs' }] },
    },
    hooks: { user: 'unknown', self: 'unknown', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Trae CN docs: the same database under Trae CN's application data.
    sessions: 'none',
    launch: 'none',
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
      recall: '?',
      stats: '?',
      tokens: '?',
      aiBackend: '?',
      sessionJudge: { cell: '✓s', note: 'the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run' },
      agentHooks: '?',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
