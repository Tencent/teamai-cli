import { UNKNOWN, UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Claude Code and the two internal builds of it, which keep their own home, command and sessions. */
export const tools = {
  claude: {
    instances: true,
    // Claude Code keeps its sign-in, its settings and each project's state in ~/.claude.json.
    home: { dir: '.claude', rootVariable: 'CLAUDE_CONFIG_DIR', stateFiles: ['.claude.json'] },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'verified' }] },
    skills: { user: [{ base: 'home', path: '.claude/skills', evidence: 'docs' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'verbatim', reads: [{ base: 'home', path: '.claude/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'verbatim', reads: [{ base: 'project', path: '.claude/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    // Claude Code 2.1.319: `claude -p` reads a file outside the project with no permission denial once its directory
    // is in `permissions.additionalDirectories` of ~/.claude/settings.json, and is denied the read without it.
    folderReach: { reach: 'grant', setting: 'permissions.additionalDirectories', evidence: 'verified' },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.claude/CLAUDE.md', evidence: 'verified' }] },
      // CLAUDE.local.md would stop Claude's native AGENTS.md load (#945).
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true },
        reads: [{ base: 'project', path: '.claude/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
      retired: { project: ['.claude/CLAUDE.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.claude/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.claude/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.claude.json', evidence: 'verified' }] },
      project: {
        judgedTeamaiOnly: false,
        format: 'claude', localScope: { file: 'user-mcp-file', key: 'git-common-root' },
        reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'verified' }],
        // Claude Code 2.1.316: an interactive session starts a .mcp.json server only once it is approved.
        readGates: ['claude-mcp-approval'],
      },
    },
    hooks: {
      user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.claude/settings.json', evidence: 'verified' }], readGates: ['claude-hooks-enabled'] },
      // No workspace-trust gate: Claude Code 2.1.316 shows its trust dialog before SessionStart and exits on "No",
      // and `claude -p` runs a project's hooks in an untrusted folder, so no session runs while it skips them.
      self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.claude/settings.json', when: 'workspaceUnder', evidence: 'verified' }, { base: 'project', path: '.claude/settings.local.json', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['claude-hooks-enabled'] },
      subagentStop: true,
      stopReply: true,
      shell: 'system',
      teamHooks: 'main-checkout',
      projectDirVariable: 'CLAUDE_PROJECT_DIR',
      needsBundle: false,
      // `async` on a command hook since 2.1.23; before 2.1.119 an async PostToolUse hook that prints nothing wrote an
      // empty transcript entry (changelog 2.1.119). Run on 2.1.322, macOS.
      unwaitedSince: '2.1.119',
      // `/bin/sh -c`, not a login shell: run on 2.1.322, macOS; Linux `sh -c` as documented.
      loginDeferrable: true,
    },
    sessions: ['claude-code'],
    launch: 'claude',
    autoCompact: 'claude',
    skillAllowedTools: true,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'claude-jsonl',
    features: {
      env: '✓t',
      workflows: '✓v',
      unattended: '✓v',
      recall: '✓v',
      stats: '✓v',
      tokens: '✓v',
      aiBackend: '✓v',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '✓v',
    },
  },
  'claude-internal': {
    home: { dir: '.claude-internal' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
    blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: UNKNOWN,
    hooks: {
      user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.claude-internal/settings.json', evidence: 'assumed' }] },
      self: { channel: 'settings', format: 'claude', reads: 'unknown' },
      subagentStop: true,
      stopReply: true,
      shell: 'system',
      teamHooks: 'home',
      needsBundle: false,
      // Assumed to run a hook as Claude Code (`claude`) does: not run, no public source.
      loginDeferrable: true,
    },
    sessions: ['claude-internal'],
    launch: 'claude',
    autoCompact: 'claude',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'claude-jsonl',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓t',
      recall: '?',
      stats: '?',
      tokens: '✓t',
      aiBackend: '✓t',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
  tclaude: {
    home: { dir: '.tclaude' },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    rules: { user: { channel: 'dir', format: 'verbatim', reads: 'unknown' }, project: { channel: 'dir', format: 'verbatim', reads: 'unknown' } },
    blocks: { user: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' }, project: { channel: 'file', file: { in: 'claudemd' }, reads: 'unknown' } },
    agents: { user: { reads: 'unknown' }, project: { reads: 'unknown' } },
    mcp: {
      user: { format: 'claude', reads: 'unknown' },
      project: { judgedTeamaiOnly: false, format: 'claude', writtenBy: 'claude', reads: [{ base: 'project', path: '.mcp.json', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    hooks: {
      user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.tclaude/settings.json', evidence: 'assumed' }] },
      self: { channel: 'settings', format: 'claude', reads: 'unknown' },
      subagentStop: true,
      stopReply: true,
      shell: 'system',
      teamHooks: 'home',
      needsBundle: false,
      // Assumed to run a hook as Claude Code (`claude`) does: not run, no public source.
      loginDeferrable: true,
    },
    sessions: ['tclaude'],
    launch: 'claude',
    autoCompact: 'claude',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'claude-jsonl',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓t',
      recall: '?',
      stats: '?',
      tokens: '✓t',
      aiBackend: '✓t',
      sessionJudge: '?',
      agentHooks: '?',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
