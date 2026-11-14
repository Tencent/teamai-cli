import { type ToolDescriptor } from '@teamai/tool-core/definition';

/** OpenCode. */
export const tools = {
  // opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode.
  opencode: {
    home: {
      dir: '.config/opencode',
      moves: { by: [{ kind: 'env', name: 'OPENCODE_CONFIG_DIR', evidence: 'source' }, { kind: 'xdg', child: 'opencode', evidence: 'source' }], defaultHomeLeftovers: true },
    },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.config/opencode/skills', evidence: 'verified' }, { base: 'home', path: '.claude/skills', evidence: 'verified' }],
      project: [
        { base: 'project', path: '.opencode/skills', when: 'workspaceUnder', evidence: 'verified' },
        { base: 'project', path: '.claude/skills', when: 'workspaceUnder', evidence: 'verified' },
      ],
    },
    // OpenCode scans no rules directory: the `instructions` glob in its config file loads it.
    rules: {
      user: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/rules', evidence: 'verified' }],
      },
      project: {
        channel: 'dir', format: 'verbatim', activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'home', path: '.config/opencode/teamai-context.md', owned: true }, activation: { key: 'instructions', in: 'mcp-file' },
        reads: [{ base: 'home', path: '.config/opencode/teamai-context.md', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'project', path: '.opencode/teamai-context.md', owned: true },
        activation: { key: 'instructions', in: 'project', path: '.opencode/opencode.json' },
        reads: [{ base: 'project', path: '.opencode/teamai-context.md', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/opencode/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.opencode/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    // OpenCode 2.1.2 parses opencode.json with jsonc-parser, `allowTrailingComma: true` (packages/core/src/config.ts#L110-L121).
    mcp: {
      user: { format: 'opencode', syntax: 'jsonc', reads: [{ base: 'home', path: '.config/opencode/opencode.json', evidence: 'verified' }] },
      project: {
        judgedTeamaiOnly: true,
        format: 'opencode', syntax: 'jsonc', alternate: { path: '.opencode/teamai-mcp.json', when: 'opencode-v2-plugin' },
        reads: [
          { base: 'project', path: 'opencode.json', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.opencode/teamai-mcp.json', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    hooks: { user: { channel: 'adapter', adapter: 'opencode-plugin', evidence: 'source' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: ['opencode'],
    launch: 'opencode',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'opencode-db',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓d',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: '✓v',
      aiBackend: '✓v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓v', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; OpenCode 1.18.23 ran a team hook through it' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
