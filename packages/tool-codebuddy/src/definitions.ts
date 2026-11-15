import { UNKNOWN_READS, type ToolDescriptor } from '@teamai/tool-core/definition';

/** The CodeBuddy CLI and WorkBuddy, CodeBuddy's desktop agent. */
export const tools = {
  // Model switching follows the same recorded home for models.json.
  // CODEBUDDY_CONFIG_DIR replaces ~/.codebuddy, and ~/.codebuddy.json moves into it.
  // Two hosts share this home: the IDE sends the tool name `skill`
  // (src/utils/tool-names.ts), while the VSCode plugin's own skill tool is
  // `use_skill` (#1516). A manual slash command lands as `@command://name`
  // rather than `/name`, so the prompt form is that.
  codebuddy: {
    home: { dir: '.codebuddy', stateFiles: ['.codebuddy.json'], moves: { by: [{ kind: 'env', name: 'CODEBUDDY_CONFIG_DIR', evidence: 'verified' }], defaultHomeLeftovers: true } },
    skillLoad: {
      calls: [{ name: 'Skill', evidence: 'verified' }, { name: 'skill', evidence: 'assumed' }, { name: 'use_skill', evidence: 'source' }],
      // The plugin lands a manual slash command as `@command://name` (#1516);
      // the generic `/name` counts too, for a build that sends that.
      promptForm: ['/name', 'command-uri'],
    },
    skills: { user: [{ base: 'home', path: '.codebuddy/skills', evidence: 'verified' }], project: 'unknown' },
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.codebuddy/rules', evidence: 'verified' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }] },
    },
    blocks: {
      user: { channel: 'file', file: { in: 'claudemd' }, reads: [{ base: 'home', path: '.codebuddy/CODEBUDDY.md', evidence: 'source' }] },
      // WorkBuddy's project entry names the same file: one copy.
      project: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' },
        reads: [{ base: 'project', path: '.codebuddy/rules', when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.codebuddy/CODEBUDDY.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.codebuddy/agents', evidence: 'source' }] },
      project: { reads: [{ base: 'project', path: '.codebuddy/agents', when: 'cwdOnly', evidence: 'source' }] },
    },
    // CodeBuddy Code 2.179.1 reads its settings and MCP files with jsonc-parser, `allowTrailingComma: true`; models.json strictly.
    mcp: {
      user: {
        format: 'buddy',
        syntax: 'jsonc',
        reads: [{ base: 'home', firstOf: ['.codebuddy/.mcp.json', '.codebuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        judgedTeamaiOnly: false,
        format: 'buddy',
        syntax: 'jsonc',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
        // CodeBuddy Code 2.179.1 starts a .mcp.json server only once it is approved, in `codebuddy -p` too.
        readGates: ['codebuddy-mcp-approval'],
      },
    },
    // CodeBuddy Code 2.179.1 (`-p`) runs the hooks of the project's settings.json and settings.local.json, merged.
    hooks: { user: { channel: 'settings', format: 'claude', syntax: 'jsonc', reads: [{ base: 'home', path: '.codebuddy/settings.json', evidence: 'source' }] }, self: { channel: 'settings', format: 'claude', syntax: 'jsonc', reads: [{ base: 'project', path: '.codebuddy/settings.json', when: 'cwdOnly', evidence: 'source' }, { base: 'project', path: '.codebuddy/settings.local.json', when: 'cwdOnly', evidence: 'verified' }] }, subagentStop: true, stopReply: false, shell: 'bundled', teamHooks: 'home', needsBundle: false },
    sessions: ['codebuddy'],
    launch: 'codebuddy',
    autoCompact: 'buddy',
    skillAllowedTools: true,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: true,
    tokens: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓d',
      unattended: '✓d',
      recall: '✓s',
      stats: '✓v',
      tokens: '✓t',
      aiBackend: '✓d',
      sessionJudge: { cell: '✓t', note: '#1386 the session judges its skill-driven run; not rerun' },
      agentHooks: '✓s',
    },
  },
  // CodeBuddy engine 2.168.0; the WorkBuddy launcher's binding of ~/.workbuddy is not certified.
  // WorkBuddy and WorkBuddy AI keep separate data roots — `.workbuddy/` and
  // `.workbuddy-ai/` — as two products rather than two generations of one, and
  // either can outlive the other. The one whose `last-launch.json` is newer is
  // the live one, and every user-scope path below hangs off it (#1273).
  workbuddy: {
    home: { dir: '.workbuddy' },
    installedBy: 'own-root',
    skillLoad: { calls: [{ name: 'Skill', evidence: 'source' }, { name: 'skill', evidence: 'assumed' }] },
    skills: UNKNOWN_READS,
    // The engine resolves user rules as `<configDir>/rules` (`loadProjectRules`
    // passes no explicit dir, so it falls to the app's config dir) and only
    // reaches for `.codebuddy/rules` in a project.
    rules: {
      user: { channel: 'dir', format: 'codebuddy', reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'source' }] },
      project: { channel: 'dir', format: 'codebuddy', reads: 'unknown' },
    },
    blocks: {
      user: {
        channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', owned: true, header: 'always-apply' },
        reads: [{ base: 'home', path: '.workbuddy/rules', evidence: 'source' }],
      },
      // CodeBuddy's engine reads the project's .codebuddy/rules, so WorkBuddy shares CodeBuddy's copy there.
      project: { channel: 'file', file: { in: 'rules-dir', name: 'teamai-context.md', dir: '.codebuddy/rules', owned: true, header: 'always-apply' }, reads: 'unknown' },
      retired: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
    },
    agents: {
      user: { reads: [{ base: 'home', path: '.workbuddy/agents', evidence: 'source' }] },
      // The engine's project agents live under `<cwd>/.codebuddy/agents`, but
      // that loader has no call site in the build, so `.workbuddy/agents` stays
      // as reported rather than as guessed-at (#1273).
      project: { reads: [{ base: 'project', path: '.workbuddy/agents', when: 'cwdOnly', evidence: 'assumed' }] },
    },
    mcp: {
      user: {
        format: 'buddy',
        reads: [{ base: 'home', firstOf: ['.workbuddy/.mcp.json', '.workbuddy/mcp.json', { in: 'codebuddy-config-dir', path: '.codebuddy.json' }], evidence: 'source' }],
      },
      project: {
        judgedTeamaiOnly: true,
        format: 'buddy',
        localScope: { file: { in: 'codebuddy-config-dir', path: '.codebuddy.json' }, key: 'realpath' },
        reads: [{ base: 'project', firstOf: ['.mcp.json', 'mcp.json'], when: 'cwdOnly', evidence: 'source' }],
      },
      retired: { project: ['.workbuddy/mcp.json'] },
    },
    hooks: { user: { channel: 'settings', format: 'claude', reads: [{ base: 'home', path: '.workbuddy/settings.json', evidence: 'assumed' }] }, self: { channel: 'settings', format: 'claude', reads: 'unknown' }, subagentStop: false, stopReply: false, shell: 'bundled', teamHooks: 'home', needsBundle: false },
    sessions: ['workbuddy'],
    launch: 'codebuddy',
    autoCompact: 'buddy',
    skillAllowedTools: false,
    searchEvidence: true,
    projectFromHome: false,
    legacyAgentMd: false,
    tokens: 'codebuddy',
    features: {
      env: '?',
      workflows: '✓t',
      unattended: '✓t',
      recall: '✓t',
      stats: '?',
      tokens: '✓t',
      aiBackend: '✓t',
      sessionJudge: { cell: '✓t', note: 'CodeBuddy\'s engine, whose session judges its skill-driven run; not run' },
      agentHooks: '?',
    },
  },
} as const satisfies Record<string, ToolDescriptor>;
