import { type ToolDescriptor } from '@teamai/tool-core/definition';

/** GitHub Copilot CLI. */
export const tools = {
  copilot: {
    home: { dir: '.copilot', moves: { by: [{ kind: 'env', name: 'COPILOT_HOME', evidence: 'verified' }] } },
    skillLoad: { calls: [{ name: 'skill', evidence: 'verified' }] },
    skills: {
      user: [{ base: 'home', path: '.copilot/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.github/skills', when: 'workspaceUnder', evidence: 'verified' }],
    },
    rules: {
      user: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'home', path: '.copilot/instructions', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'copilot-instructions', reads: [{ base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.copilot/copilot-instructions.md', evidence: 'verified' }] },
      // Copilot inlines a `.github/instructions` file in every request only for the `applyTo: "**"` glob (#915).
      project: {
        channel: 'file', file: { in: 'claudemd' },
        gitExcluded: { in: 'rules-dir', name: 'teamai-context.instructions.md', owned: true, header: 'apply-to-all' },
        reads: [
          { base: 'project', path: '.github/copilot-instructions.md', when: 'workspaceUnder', evidence: 'verified' },
          { base: 'project', path: '.github/instructions', when: 'workspaceUnder', evidence: 'verified' },
        ],
      },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.copilot/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.github/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    mcp: {
      user: { format: 'copilot', reads: [{ base: 'home', path: '.copilot/mcp-config.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'copilot', reads: [{ base: 'project', path: '.github/mcp.json', when: 'workspaceUnder', evidence: 'verified' }], readGates: ['copilot-folder-trust'] },
    },
    hooks: {
      user: { channel: 'settings', format: 'copilot', reads: [{ base: 'home', path: '.copilot/hooks/teamai.json', evidence: 'source' }] },
      // Copilot 1.0.105 runs repo hooks only in a trusted folder (verified with `copilot -p`).
      self: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['copilot-folder-trust'] },
      workspace: { channel: 'settings', format: 'copilot', reads: [{ base: 'project', path: '.github/hooks/teamai.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['copilot-folder-trust'] },
      subagentStop: false,
      stopReply: true,
      shell: 'system',
      teamHooks: 'home',
      needsBundle: true,
    },
    sessions: ['copilot'],
    launch: 'copilot',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'copilot-shutdown',
    features: {
      env: '?',
      workflows: '+s',
      unattended: '?',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: { cell: '✓t', note: 'one request per model from the session.shutdown totals, priced without long-prompt rates; not run' },
      aiBackend: '✓d',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '—t',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
