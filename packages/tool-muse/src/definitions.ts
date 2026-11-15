import { type ToolDescriptor } from '@teamai/tool-core/definition';

/** Muse Code. */
export const tools = {
  // muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read.
  muse: {
    home: { dir: '.config/muse', moves: { by: [{ kind: 'xdg', child: 'muse', evidence: 'source' }], defaultHomeLeftovers: true } },
    installedBy: 'home',
    skillLoad: { calls: [{ name: 'read_skill', evidence: 'verified' }] },
    skills: {
      user: [
        { base: 'home', path: '.config/muse/skills', evidence: 'verified' },
        { base: 'home', path: '.agents/skills', evidence: 'verified' },
        { base: 'home', path: '.claude/skills', evidence: 'verified' },
      ],
      project: [{ base: 'project', path: '.agents/skills', when: 'workspaceUnder', evidence: 'verified' }],
      readGates: ['muse-workspace-trust'],
    },
    rules: {
      user: { channel: 'inline', label: 'Muse Code AGENTS.md' },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.config/muse/AGENTS.md' }, reads: [{ base: 'home', path: '.config/muse/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'session-hook', probe: 'muse-session-start', evidence: 'verified' },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.config/muse/agents', evidence: 'source' }] },
      project: { reads: 'unknown' },
    },
    mcp: {
      user: { format: 'muse', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: true, format: 'muse', writtenBy: 'claude', reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['muse-workspace-trust'] },
    },
    // Muse takes Codex's hook shape: it drops a group carrying any key but `matcher` and `hooks`, so Claude's described groups never reach it.
    hooks: { user: { channel: 'settings', format: 'codex', reads: [{ base: 'home', path: '.config/muse/settings.json', evidence: 'verified' }] }, self: { channel: 'settings', format: 'codex', reads: [{ base: 'project', path: '.muse/hooks.json', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['muse-workspace-trust'] }, subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    // muse-bin 1.4.14: sessions under $XDG_DATA_HOME/muse/sessions, ~/.local/share when unset.
    sessions: ['muse'],
    launch: 'muse',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'muse-session',
    features: {
      env: '✓t',
      workflows: '+v',
      unattended: '?',
      recall: '✓t',
      stats: '✓v',
      tokens: '✓t',
      aiBackend: '✓v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '✓t', note: '#1224 writes them to settings.json; not rerun' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
