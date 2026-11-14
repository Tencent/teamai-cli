import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Qoder CLI and its China build, which keep their own home, command and sessions. */
export const tools = {
  qoder: {
    home: { dir: '.qoder', moves: { by: [{ kind: 'qoder-home', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'qoder', reads: [{ base: 'home', path: '.qoder/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'qoder', reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'home', path: '.qoder/rules', evidence: 'source' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'source' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.qoder/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.qoder/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    // qodercli 1.1.81 reads settings.json as JSON.parse(stripJsonComments(text)): comments, no trailing commas.
    mcp: {
      user: { format: 'claude', syntax: 'json-comments', reads: [{ base: 'home', path: '.qoder/settings.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: false, format: 'claude', syntax: 'json-comments', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['qoder-folder-trust', 'qoder-mcp-approval'] },
    },
    // qodercli 1.1.81 loads project, then project-local (settings.local.json), then user hooks; both project files wait on folder trust.
    hooks: { user: { channel: 'settings', format: 'claude', syntax: 'json-comments', reads: [{ base: 'home', path: '.qoder/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', syntax: 'json-comments', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'cwdOnly', evidence: 'source' }, { base: 'project', path: '.qoder/settings.local.json', when: 'cwdOnly', evidence: 'source' }], readGates: ['qoder-folder-trust'] }, subagentStop: true, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Qoder CLI 1.1.78: <id>.jsonl under <QODER_CONFIG_DIR or QODER_CLI_HOME/.qoder or ~/.qoder>/projects/<cwd>.
    sessions: ['qoder'],
    launch: 'qoder',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'claude-jsonl',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '◐s',
      stats: '✓s',
      tokens: { cell: '◐t', note: 'Qoder bills credits and can write zero token counts' },
      aiBackend: '✓d',
      sessionJudge: { cell: '✓s', note: 'Claude Code-style subagents, transcripts under <id>/subagents/ (qodercli 1.1.78); not run' },
      agentHooks: '✓s',
    },
  },
  'qoder-cn': {
    home: { dir: '.qoder-cn', moves: { by: [{ kind: 'qoder-cn-home', evidence: 'source' }] } },
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }] },
    skills: UNKNOWN_READS,
    installedBy: 'home-edition',
    rules: {
      user: { channel: 'dir', format: 'qoder', reads: [{ base: 'home', path: '.qoder-cn/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'qoder', reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'home', path: '.qoder-cn/rules', evidence: 'assumed' }] },
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'trigger-always-on' }, reads: [{ base: 'project', path: '.qoder/rules', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.qoder-cn/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.qoder/agents', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.qoder-cn/settings.json', evidence: 'source' }] },
      project: { judgedTeamaiOnly: false, format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'workspaceUnder', evidence: 'assumed' }] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.qoder-cn/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.qoder/settings.json', when: 'cwdOnly', evidence: 'source' }, { base: 'project', path: '.qoder/settings.local.json', when: 'cwdOnly', evidence: 'assumed' }] }, subagentStop: true, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Qoder CN: the same layout under ~/.qoder-cn, moved by QODERCN_CONFIG_DIR.
    sessions: ['qoder-cn'],
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'claude-jsonl',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '◐s',
      stats: '✓s',
      tokens: { cell: '◐t', note: 'Qoder bills credits and can write zero token counts' },
      aiBackend: '?',
      sessionJudge: { cell: '✓s', note: 'Claude Code-style subagents, transcripts under <id>/subagents/ (qodercli 1.1.78); not run' },
      agentHooks: { cell: '✓t', note: '#1224 writes ~/.qoder-cn/settings.json; not rerun' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
