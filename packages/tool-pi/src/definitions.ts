import { NONE, type ToolDescriptor } from '@teamai/tool-core/definition';

/** Pi Coding Agent and omp, its fork, which keep their own home, command and sessions. */
export const tools = {
  pi: {
    home: { dir: '.pi', moves: { root: '.pi/agent', by: [{ kind: 'env', name: 'PI_CODING_AGENT_DIR', evidence: 'verified' }], defaultHomeLeftovers: true } },
    skillLoad: { calls: [], promptForm: 'skill-block' },
    skills: {
      user: [{ base: 'home', path: '.pi/agent/skills', evidence: 'verified' }],
      project: [{ base: 'project', path: '.pi/skills', when: 'cwdOnly', evidence: 'verified' }],
      readGates: ['pi-project-trust'],
    },
    rules: {
      user: { channel: 'inline', label: 'Pi AGENTS.md' },
      project: { channel: 'extension', probe: 'pi-extension', evidence: 'verified' },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.pi/agent/AGENTS.override.md', evidence: 'verified' }, { base: 'home', path: '.pi/agent/AGENTS.md', evidence: 'verified' }] },
      project: { channel: 'extension', probe: 'pi-extension', evidence: 'verified' },
      retired: { project: ['AGENTS.md'] },
    },
    agents: NONE,
    mcp: {
      user: { format: 'pi', reads: [{ base: 'home', path: '.pi/agent/mcp.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'pi', reads: [{ base: 'project', path: '.pi/mcp.json', when: 'cwdOnly', evidence: 'verified' }], readGates: ['pi-project-trust'] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'pi-extension', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Pi 1.4.0: v3 JSONL under --session-dir > PI_CODING_AGENT_SESSION_DIR > the sessionDir setting > PI_CODING_AGENT_DIR/sessions.
    sessions: ['pi'],
    launch: 'pi',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: true,
    legacyAgentMd: false,
    tokens: 'pi-session',
    features: {
      env: '✓s',
      workflows: '+v',
      unattended: '?',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: '✓t',
      aiBackend: '✓s',
      sessionJudge: { cell: '◐s', note: 'bare Pi starts no subagent, so its session answers h4 and teamai judges the run in the background through pi at best-effort; the subagent example extension adds one (since 0.24.0); not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; Pi\'s extension source' },
    },
  },
  // Extensions capture the installed Node/CLI launcher instead of depending on the host PATH.
  // utils/src/dirs.ts at a70f001c. A `--profile` flag another process starts with is out of teamai's sight: init records the home for it.
  // OMP also reads PI_CODING_AGENT_DIR for its default profile. teamai does not follow it: Pi owns that directory, and both
  // tools' files there, the hook extension's one name included, would overwrite each other.
  // No `defaultHomeLeftovers`: members run profiles side by side, so ~/.omp/agent is the live default profile.
  omp: {
    home: { dir: '.omp', moves: { root: '.omp/agent', by: [{ kind: 'omp-agent', evidence: 'source' }] } },
    skillLoad: { calls: [] },
    skills: { user: [{ base: 'home', path: '.omp/agent/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'omp', reads: [{ base: 'home', path: '.omp/agent/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'omp', reads: [{ base: 'project', path: '.omp/rules', when: 'cwdOnly', evidence: 'verified' }] },
    },
    blocks: {
      // An always-applied rule beside OMP's single user context file, which ~/.agents/AGENTS.md would take.
      user: { channel: 'file', file: { in: 'home', path: '.omp/agent/RULES.md' }, reads: [{ base: 'home', path: '.omp/agent/RULES.md', evidence: 'verified' }] },
      // OMP keeps one context file per level, so .omp/AGENTS.md would hide the project's AGENTS.md.
      project: { channel: 'extension', probe: 'omp-extension', evidence: 'verified' },
      retired: { user: ['.omp/agent/AGENTS.md'], project: ['.omp/AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.omp/agent/agents', evidence: 'verified' }] },
      project: { reads: [{ base: 'project', path: '.omp/agents', when: 'workspaceUnder', evidence: 'verified' }] },
    },
    mcp: {
      user: { format: 'claude', reads: [{ base: 'home', path: '.omp/agent/mcp.json', evidence: 'verified' }] },
      project: { judgedTeamaiOnly: true, format: 'claude', reads: [{ base: 'project', path: '.omp/mcp.json', when: 'cwdOnly', evidence: 'verified' }] },
    },
    hooks: { user: { channel: 'adapter', adapter: 'omp-extension', evidence: 'verified' }, self: 'user', subagentStop: false, stopReply: true, shell: 'system', teamHooks: 'home', needsBundle: false },
    // Oh My Pi 18.12.6: Pi v3 JSONL with a leading title record under the resolved profile agent root.
    sessions: ['omp'],
    launch: 'omp',
    autoCompact: 'none',
    skillAllowedTools: false,
    searchEvidence: false,
    projectFromHome: true,
    legacyAgentMd: true,
    tokens: 'pi-session',
    features: {
      env: '✓s',
      workflows: '+s',
      unattended: '?',
      recall: '✓v',
      stats: { cell: '✓t', note: 'A1 (#1245) records its skill loads; not rerun' },
      tokens: '✓t',
      aiBackend: '✓d',
      sessionJudge: { cell: '✓s', note: 'the task tool starts each child as a new agent session (omp 18.12.6); not run' },
      agentHooks: { cell: '✓s', note: 'runs from teamai\'s team-hook bridge, which can block a tool call; OMP\'s extension source' },
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
