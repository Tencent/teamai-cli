import { NONE, type ToolDescriptor } from '@teamai/tool-core/definition';

/** DeepSeek Harness, run as dsh. */
export const tools = {
  dsh: {
    receivesDeliveredModels: true,
    home: { dir: '.dsh', moves: { by: [{ kind: 'env', name: 'DSH_HOME', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.dsh/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'inline', label: 'DeepSeek Harness AGENTS.md' },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.dsh/AGENTS.md' }, reads: [{ base: 'home', path: '.dsh/AGENTS.md', evidence: 'source' }] },
      project: { channel: 'session-hook', probe: 'dsh-session-start', evidence: 'source' },
    },
    agents: NONE,
    // MCP servers are mcp-client plugin instances in the home patch DSH applies
    // on every boot. Only the user channel is proven.
    mcp: {
      user: { format: 'dsh', reads: [{ base: 'home', path: '.dsh/cordis.patch.yml', evidence: 'source' }] },
      project: 'none',
    },
    hooks: { user: { channel: 'adapter', adapter: 'dsh-hooks', evidence: 'source' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: 'none',
    launch: 'none',
    autoCompact: 'dsh',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '✗s',
      workflows: '+s',
      unattended: '?',
      recall: '✓s',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: { cell: '+s', note: 'zstd session files need a newer Node than 20' },
      aiBackend: '+s',
      sessionJudge: { cell: '◐s', note: 'the subagent tool with the fresh spawn backend, not fork; the minimal preset leaves it out; not run' },
      agentHooks: '—t',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
