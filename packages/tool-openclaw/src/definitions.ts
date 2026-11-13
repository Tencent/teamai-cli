import { NONE, UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** OpenClaw. */
export const tools = {
  // Hermes (`skill_view`) and OpenClaw (`skills_read`) have skill tools, but teamai installs no post-tool-use hook for them yet.
  // OpenClaw's skills sit in its workspace.
  openclaw: {
    receivesDeliveredModels: true,
    home: {
      dir: '.openclaw',
      // docs.openclaw.ai/help/environment; OPENCLAW_STATE_DIR and OPENCLAW_PROFILE also in src/config/paths.ts at 884a96d1.
      moves: { by: [{ kind: 'openclaw-state', evidence: 'docs' }] },
    },
    skillLoad: 'unknown',
    skills: UNKNOWN_READS,
    skillsFollowSession: true,
    rules: { user: { channel: 'inline', label: 'OpenClaw workspace AGENTS.md' }, project: 'none' },
    blocks: {
      user: { channel: 'file', file: { in: 'openclaw-workspace', name: 'AGENTS.md' }, reads: 'unknown' },
      // OpenClaw's only project file is the shared AGENTS.md; it reads no project .openclaw/workspace (#946).
      project: 'none',
      retired: { project: ['.openclaw/workspace/AGENTS.md'] },
    },
    agents: NONE,
    // MCP servers are `mcp.servers` entries of openclaw.json (JSON5). Only its
    // user config is proven; OpenClaw reads no project openclaw.json.
    mcp: {
      user: { format: 'openclaw', key: ['mcp', 'servers'], syntax: 'json5', reads: [{ base: 'home', path: '.openclaw/openclaw.json', evidence: 'docs' }] },
      project: 'none',
    },
    hooks: { user: { channel: 'adapter', adapter: 'openclaw-hook', evidence: 'verified', readGates: ['openclaw-hooks-enabled', 'openclaw-plugins-enabled'] }, self: 'user', subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    // OpenClaw 2026.10: rows in ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite, moved by OPENCLAW_STATE_DIR.
    sessions: 'none',
    launch: 'openclaw',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '◐d',
      workflows: '+d',
      unattended: '?',
      recall: '✓s',
      stats: '+s',
      tokens: { cell: '+s', note: 'no Stop hook reaches the dashboard' },
      aiBackend: '✓d',
      sessionJudge: { cell: '◐s', note: 'sessions_spawn with isolated context, in the coding and messaging tool profiles; a tool policy can remove it; not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; OpenClaw\'s plugin source' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
