import { NONE, UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** JoyCode, a Codex build that keeps its own home and sessions. */
export const tools = {
  joycode: {
    // JoyCode Desktop 0.6.0's dist/main.js resolves JOYCODE_HOME (default ~/.joycode) and passes it on as CODEX_HOME (#1572).
    // The JoyCode 3.8.71 IDE extension never reads it and keeps everything under os.homedir()/.joycode.
    home: { dir: '.joycode', moves: { by: [{ kind: 'env', name: 'JOYCODE_HOME', evidence: 'source' }] } },
    skillLoad: { calls: [] },
    skills: UNKNOWN_READS,
    rules: {
      user: { channel: 'inline', label: 'JoyCode rules.txt' },
      project: { channel: 'dir', format: 'joycode', reads: [{ base: 'project', path: '.joycode/rules', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'home', path: '.joycode/rules.txt' }, reads: [{ base: 'home', path: '.joycode/rules.txt', evidence: 'source' }] },
      project: 'none',
    },
    // JoyCode 3.8.71 loads Markdown agents named by `.joycode/agent.json`; TeamAI maintains that index beside the rendered files.
    agents: {
      user: { reads: [{ base: 'home', path: '.joycode/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.joycode/agents', when: 'workspaceUnder', evidence: 'source' }] },
    },
    mcp: NONE,
    // ~/.joycode/hooks.json and <project>/.joycode/hooks.json take Claude-shaped hooks (command type, timeout in seconds).
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.joycode/hooks.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', reads: [{ base: 'project', path: '.joycode/hooks.json', when: 'workspaceUnder', evidence: 'source' }] }, subagentStop: false, stopReply: false, shell: 'system', teamHooks: 'home', needsBundle: false },
    sessions: ['joycode'],
    launch: 'none',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'codex-rollout',
    features: {
      env: '?',
      workflows: '?',
      unattended: '?',
      recall: '◐s',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: '✓t',
      aiBackend: '?',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '?',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
