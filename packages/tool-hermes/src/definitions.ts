import { NONE, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Hermes. */
export const tools = {
  // hermes_constants.py and hermes_cli/main.py at 68134629 (the same rules at 7e9eb8d9). Hermes reads its home in either scope.
  // Out of teamai's sight: another process's -p/--profile flag, and the supervised, desktop SSH and s6 gateway starts that skip active_profile.
  hermes: {
    receivesDeliveredModels: true,
    home: { dir: '.hermes', moves: { by: [{ kind: 'hermes-home', evidence: 'source' }] } },
    skillLoad: 'unknown',
    skills: {
      user: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
      project: [{ base: 'home', path: '.hermes/skills', evidence: 'source' }],
    },
    rules: { user: { channel: 'inline', label: 'Hermes SOUL.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.hermes/SOUL.md' }, reads: [{ base: 'home', path: '.hermes/SOUL.md', evidence: 'source' }] },
      // Hermes reads the project's AGENTS.md itself; teamai's plugin adds the blocks as a system prompt section.
      project: { channel: 'plugin', probe: 'hermes-plugin', limit: 4000, evidence: 'source' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: NONE,
    // MCP servers live in `mcp_servers` of the profile's config.yaml. The home
    // move resolves the active profile; no project channel is proven.
    mcp: {
      user: { format: 'hermes', reads: [{ base: 'home', path: '.hermes/config.yaml', evidence: 'docs' }] },
      project: 'none',
    },
    hooks: { user: { channel: 'adapter', adapter: 'hermes-plugin', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: ['hermes'],
    launch: 'hermes',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '◐s',
      workflows: '+s',
      unattended: '?',
      recall: '✓v',
      stats: '+s',
      tokens: { cell: '+s', note: 'no Stop hook reaches the dashboard' },
      aiBackend: '✓s',
      sessionJudge: { cell: '✓s', note: 'delegate_task starts a child agent with a fresh conversation; not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; Hermes\'s shell-hook source' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
