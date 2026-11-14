import { type ToolDescriptor } from '@teamai/tool-core/definition';

/** Antigravity, run as agy. */
export const tools = {
  // agy 1.4.8 runs: ~/.gemini/config holds the user customizations, <root>/.agents a project's.
  agy: {
    home: { dir: '.gemini/config' },
    installedBy: 'home',
    // A skill loads as a read of its SKILL.md (`view_file` or `read_file`).
    skillLoad: { calls: [] },
    skills: {
      user: [{ base: 'home', path: '.gemini/config/skills', evidence: 'verified' }, { base: 'home', path: '.agents/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.agents/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'dir', format: 'agy', reads: [{ base: 'home', path: '.gemini/config/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'agy', reads: [{ base: 'project', path: '.agents/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'home', path: '.gemini/config/rules', evidence: 'verified' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'project', path: '.agents/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.gemini/config/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.agents/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'agy', reads: [{ base: 'home', path: '.gemini/config/mcp_config.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'agy', reads: [{ base: 'project', path: '.agents/plugins/teamai/mcp_config.json', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'agy-hooks', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: true },
    sessions: ['agy'],
    launch: 'agy',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'agy-transcript',
    features: {
      env: { cell: '✓v', note: 'agy 1.4.8 run_command inherits the environment agy starts in' },
      workflows: '✓v',
      unattended: '✓d',
      recall: '✓v',
      stats: '✓v',
      tokens: { cell: '◐v', note: 'agy 1.4.10 session read 2026-10-31; it names no model, so its tokens show unpriced' },
      aiBackend: '✓v',
      sessionJudge: { cell: '✓t', note: 'invoke_subagent starts a fresh conversation that gets only its prompt (agy 1.4.8); no session variable, so the session names its tool with --tools; not run' },
      agentHooks: { cell: '✓t', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; the dispatcher hands it a Claude payload' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
