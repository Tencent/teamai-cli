import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Cursor, the editor and its cursor-agent CLI. */
export const tools = {
  // Cursor reads `<ancestor>/.cursor/rules` walking up from the workspace (cursor-user-rules.ts).
  cursor: {
    home: { dir: '.cursor' },
    skillLoad: { calls: [] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'cursor-mdc', reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        // The Cursor CLI reads no ~/.cursor/agents (#1218).
        noRecallAgent: true,
        reads: [{ base: 'home', path: '.cursor/rules', when: 'workspaceUnderHome', evidence: 'verified' }],
      },
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.mdc', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.cursor/rules', when: 'workspaceUnder', evidence: 'verified' }],
      },
    },
    agents: {
      // The IDE reads it; the CLI does not (#1218), which doctor's wording names.
      user: { reads: [{ base: 'home', path: '.cursor/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.cursor/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    // cursor-agent 2026.10.21 (run) lists the servers of an mcp.json with comments and trailing commas.
    mcp: {
      user: { format: 'cursor', syntax: 'jsonc', reads: [{ base: 'home', path: '.cursor/mcp.json', evidence: 'source' }] },
      // The Cursor CLI (2026.10.21, verified) loads a project server only once it is approved; the IDE's approvals are not traced.
      project: { judgedTeamaiOnly: true, format: 'cursor', syntax: 'jsonc', reads: [{ base: 'project', path: '.cursor/mcp.json', when: 'workspaceUnder', evidence: 'source' }], readGates: ['cursor-mcp-approval'] },
    },
    // cursor-agent 2026.10.21 parses hooks.json with `parseJSONC`: comments stripped, then JSON.parse, so no trailing commas.
    hooks: { user: { channel: 'settings', format: 'cursor', syntax: 'json-comments', reads: [{ base: 'home', path: '.cursor/hooks.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'cursor', syntax: 'json-comments', reads: [{ base: 'project', path: '.cursor/hooks.json', when: 'workspaceUnder', evidence: 'source' }] }, subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: ['cursor'],
    launch: 'cursor',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: false,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'none',
    features: {
      env: '?',
      workflows: { cell: '+s', note: 'Cursor IDE: —' },
      unattended: '?',
      recall: { cell: '✗v', note: 'Cursor IDE: ✓v' },
      stats: { cell: '✓v', note: 'Cursor IDE: ✓t' },
      tokens: { cell: '+d', note: 'usage is in the Cursor account dashboard only' },
      aiBackend: '✓d',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: { cell: '+t', note: 'teamai refuses agent hooks in the Cursor hook format' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
