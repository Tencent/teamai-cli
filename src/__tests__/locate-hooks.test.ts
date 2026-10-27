import { describeLocateMatrix, type FilesRow, type OtherRow, type Spot } from './helpers/locate-matrix.js';

const HOOK_LIST = ['hooks'] as const;
const CODEBUDDY_SOURCE = 'CodeBuddy 2.176.0 bundle: CODEBUDDY_CONFIG_DIR replaces ~/.codebuddy, settings.json included (issue #1221, `codebuddy mcp list` at 2.168.0)';
const MUSE_SOURCE = 'muse-bin 1.4.11: $XDG_CONFIG_HOME/muse, else ~/.config/muse; with XDG_CONFIG_HOME set, ~/.config/muse is never read';
const OPENCODE_SOURCE = 'opencode v2.1.1 Global.Path: OPENCODE_CONFIG_DIR, else (XDG_CONFIG_HOME || ~/.config)/opencode; plugins load from its plugin directory';
const HERMES_SOURCE = 'hermes-agent hermes_constants.py:51-58: HERMES_HOME, else %LOCALAPPDATA%\\hermes on Windows, else ~/.hermes; shell hooks registered in config.yaml';
const SELF = 'issue #1221 matrix, Self scope';

/** A tool's hook list in `file`, which it reads from any session: `probe` says it is installed. */
const settings = (tool: string, scope: 'user' | 'project', file: Spot, probe: Spot, rest: Partial<FilesRow> = {}): FilesRow => ({
  tool, scope, existingDirs: [probe], installed: { probe, met: true },
  writes: [{ at: file, key: HOOK_LIST }], reads: [{ at: file, when: 'always', key: HOOK_LIST }],
  source: 'issue #1221 matrix, Hooks column',
  ...rest,
});

/** A project's own hook list in self mode, read from a session at or under the root, or only at it. */
const selfSettings = (tool: string, file: Spot, probe: Spot, when: 'workspaceUnder' | 'cwdOnly', rest: Partial<FilesRow> = {}): FilesRow =>
  settings(tool, 'project', file, probe, { install: { self: true }, reads: [{ at: file, when, key: HOOK_LIST }], source: SELF, ...rest });

/** The directory a tool's adapter writes teamai's hook file into, which the tool loads. */
const adapter = (tool: string, scope: 'user' | 'project', dir: Spot, probe: Spot, rest: Partial<FilesRow> = {}): FilesRow => ({
  tool, scope, existingDirs: [probe], installed: { probe, met: true },
  writes: [dir], reads: [{ at: dir, when: 'always' }],
  source: 'issue #1221 matrix, Hooks column',
  ...rest,
});

const ROWS: readonly (FilesRow | OtherRow)[] = [
  settings('claude', 'user', '~/.claude/settings.json', '~/.claude'),
  settings('claude', 'user', '~/.claude-work/settings.json', '~/.claude-work', {
    toolRoots: { claude: '~/.claude-work' }, reads: [{ at: '~/.claude-work/settings.json', when: 'always', key: HOOK_LIST }],
    source: 'CLAUDE_CONFIG_DIR recorded by teamai init (RELOCATABLE_TOOLS)',
  }),
  settings('claude', 'project', '~/.claude/settings.json', '~/.claude', { source: 'resolveHookScope: a workspace takes the user hooks (#264)' }),
  settings('claude', 'project', '~/.claude-work/settings.json', '~/.claude-work', {
    userToolRoots: { claude: '~/.claude-work' }, reads: [{ at: '~/.claude-work/settings.json', when: 'always', key: HOOK_LIST }],
    source: 'a project config that records no toolRoots follows the user config (resolveMemberToolRoots)',
  }),
  selfSettings('claude', '<root>/.claude/settings.json', '<root>/.claude', 'workspaceUnder', {
    reads: [
      { at: '<root>/.claude/settings.json', when: 'workspaceUnder', key: HOOK_LIST },
      { at: '<root>/.claude/settings.local.json', when: 'workspaceUnder', key: HOOK_LIST },
    ],
  }),
  settings('codex', 'user', '~/.codex/hooks.json', '~/.codex'),
  settings('codex', 'project', '~/.codex/hooks.json', '~/.codex', { source: 'resolveHookScope: a workspace takes the user hooks (#264)' }),
  selfSettings('codex', '<root>/.codex/hooks.json', '<root>/.codex', 'workspaceUnder'),
  settings('codex-internal', 'user', '~/.codex-internal/hooks.json', '~/.codex-internal', { source: 'assumed from Codex: the build runs Codex from its own home' }),
  settings('tcodex', 'user', '~/.tcodex/hooks.json', '~/.tcodex', { source: 'assumed from Codex: the build runs Codex from its own home' }),
  settings('claude-internal', 'user', '~/.claude-internal/settings.json', '~/.claude-internal', { source: 'assumed from Claude Code: the build runs it from its own home' }),
  selfSettings('claude-internal', '<root>/.claude-internal/settings.json', '<root>/.claude-internal', 'workspaceUnder', {
    reads: 'unknown', source: `${SELF}: the internal builds' own project lookup is not verified`,
  }),
  settings('tclaude', 'user', '~/.tclaude/settings.json', '~/.tclaude', { source: 'assumed from Claude Code: tclaude relocates its whole user data dir' }),
  settings('cursor', 'user', '~/.cursor/hooks.json', '~/.cursor'),
  selfSettings('cursor', '<root>/.cursor/hooks.json', '<root>/.cursor', 'workspaceUnder'),
  settings('copilot', 'user', '~/.copilot/hooks/teamai.json', '~/.copilot'),
  settings('copilot', 'user', '/copilot-home/hooks/teamai.json', '/copilot-home', {
    env: { COPILOT_HOME: '/copilot-home' }, reads: [{ at: '/copilot-home/hooks/teamai.json', when: 'always', key: HOOK_LIST }],
    source: 'Copilot CLI 1.0.98: COPILOT_HOME moves the whole user customization root, hooks included',
  }),
  selfSettings('copilot', '<root>/.github/hooks/teamai.json', '~/.copilot', 'workspaceUnder', {
    source: `${SELF}: whether repo hooks wait for folder trust is not traced`,
  }),
  settings('qoder', 'user', '~/.qoder/settings.json', '~/.qoder'),
  selfSettings('qoder', '<root>/.qoder/settings.json', '~/.qoder', 'cwdOnly', {
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: `${SELF}: <cwd>/.qoder/settings.json, shared with Qoder CN`,
  }),
  settings('qoder-cn', 'user', '~/.qoder-cn/settings.json', '~/.qoder-cn'),
  selfSettings('qoder-cn', '<root>/.qoder/settings.json', '~/.qoder-cn', 'cwdOnly', {
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: `${SELF}: Qoder CN's project hooks are Qoder's <cwd>/.qoder/settings.json`,
  }),
  settings('codebuddy', 'user', '~/.codebuddy/settings.json', '~/.codebuddy', { source: CODEBUDDY_SOURCE }),
  settings('codebuddy', 'user', '/cb/settings.json', '/cb', {
    env: { CODEBUDDY_CONFIG_DIR: '/cb' }, reads: [{ at: '/cb/settings.json', when: 'always', key: HOOK_LIST }],
    retired: [{ at: '~/.codebuddy/settings.json', was: 'default' }],
    source: `${CODEBUDDY_SOURCE}; earlier releases wrote the hooks to ~/.codebuddy`,
  }),
  settings('codebuddy', 'user', '/recorded/codebuddy/settings.json', '/recorded/codebuddy', {
    toolHomes: { codebuddy: '/recorded/codebuddy' }, reads: [{ at: '/recorded/codebuddy/settings.json', when: 'always', key: HOOK_LIST }],
    retired: [{ at: '~/.codebuddy/settings.json', was: 'default' }],
    source: `${CODEBUDDY_SOURCE}; a recorded home wins over a shell without the variable`,
  }),
  settings('codebuddy', 'project', '/cb/settings.json', '/cb', {
    env: { CODEBUDDY_CONFIG_DIR: '/cb' }, reads: [{ at: '/cb/settings.json', when: 'always', key: HOOK_LIST }],
    retired: [{ at: '~/.codebuddy/settings.json', was: 'default' }],
    source: `${CODEBUDDY_SOURCE}; a workspace takes the user hooks`,
  }),
  selfSettings('codebuddy', '<root>/.codebuddy/settings.json', '<root>/.codebuddy', 'cwdOnly', {
    broken: { 'project-subdir': { reason: 'cwd-only', issue: '#1221' } },
    source: `${SELF}: CodeBuddy reads project settings from the session cwd only`,
  }),
  settings('workbuddy', 'user', '~/.workbuddy/settings.json', '~/.workbuddy', { source: 'issue #1221 matrix, WorkBuddy user hooks (t)' }),
  selfSettings('workbuddy', '<root>/.workbuddy/settings.json', '<root>/.workbuddy', 'cwdOnly', { reads: 'unknown', source: `${SELF}: WorkBuddy (?t)` }),
  settings('muse', 'user', '~/.config/muse/settings.json', '~/.config/muse', { source: MUSE_SOURCE }),
  settings('muse', 'user', '/xdg/muse/settings.json', '/xdg/muse', {
    env: { XDG_CONFIG_HOME: '/xdg' }, reads: [{ at: '/xdg/muse/settings.json', when: 'always', key: HOOK_LIST }],
    retired: [{ at: '~/.config/muse/settings.json', was: 'default' }],
    source: `${MUSE_SOURCE}; earlier releases wrote the hooks to ~/.config/muse`,
  }),
  selfSettings('muse', '<root>/.muse/hooks.json', '~/.config/muse', 'workspaceUnder', { source: `${SELF}: runs only in a trusted workspace` }),
  settings('zcode', 'user', '~/.zcode/cli/config.json', '~/.zcode'),
  settings('zcode', 'project', '~/.zcode/cli/config.json', '~/.zcode', {
    install: { self: true },
    source: 'ZCode 3.16.2 source: the CLI runs user-level hooks only, so self mode installs them in ~/.zcode/cli/config.json (#1330)',
  }),
  adapter('opencode', 'user', '~/.config/opencode/plugin', '~/.config/opencode', { source: OPENCODE_SOURCE }),
  adapter('opencode', 'user', '/xdg/opencode/plugin', '/xdg/opencode', {
    env: { XDG_CONFIG_HOME: '/xdg' }, retired: [{ at: '~/.config/opencode/plugin', was: 'default' }],
    source: `${OPENCODE_SOURCE}; earlier releases wrote the plugin to ~/.config/opencode`,
  }),
  adapter('opencode', 'user', '/oc/plugin', '/oc', {
    env: { OPENCODE_CONFIG_DIR: '/oc' }, retired: [{ at: '~/.config/opencode/plugin', was: 'default' }],
    source: OPENCODE_SOURCE,
  }),
  adapter('opencode', 'project', '~/.config/opencode/plugin', '~/.config/opencode', {
    install: { self: true }, source: `${SELF}: OpenCode loads the HOME plugin, so one copy dispatches every event once`,
  }),
  adapter('pi', 'user', '~/.pi/agent/extensions', '~/.pi', { source: 'issue #1221 matrix, Pi user hooks (v, Pi 0.99.2)' }),
  adapter('pi', 'user', '/pi-agent/extensions', '/pi-agent', {
    env: { PI_CODING_AGENT_DIR: '/pi-agent' }, retired: [{ at: '~/.pi/agent/extensions', was: 'default' }],
    source: 'issue #1221 matrix, PI_CODING_AGENT_DIR row (v); earlier releases wrote the extension to ~/.pi/agent',
  }),
  adapter('pi', 'project', '~/.pi/agent/extensions', '~/.pi', { install: { self: true }, source: `${SELF}: as user scope, the HOME extension` }),
  adapter('omp', 'user', '~/.omp/agent/extensions', '~/.omp', { source: 'issue #1221 matrix, Oh My Pi user hooks (v, 18.2.1)' }),
  adapter('hermes', 'user', '~/.hermes/hooks', '~/.hermes', { platforms: ['darwin', 'linux'], source: HERMES_SOURCE }),
  adapter('hermes', 'user', '$LOCALAPPDATA/hermes/hooks', '$LOCALAPPDATA/hermes', { platforms: ['win32'], source: HERMES_SOURCE }),
  adapter('hermes', 'user', '/hermes/hooks', '/hermes', { env: { HERMES_HOME: '/hermes' }, source: HERMES_SOURCE }),
  adapter('openclaw', 'user', '~/.openclaw/workspace/hooks', '~/.openclaw/workspace', {
    source: 'OpenClaw 884a96d1 loads workspace hooks from <workspace>/hooks (issue #1221 matrix, v)',
  }),
  adapter('openclaw', 'user', '/oc-state/workspace/hooks', '/oc-state/workspace', {
    env: { OPENCLAW_STATE_DIR: '/oc-state' }, source: 'OpenClaw: the workspace defaults to <state dir>/workspace',
  }),
  adapter('dsh', 'user', '~/.teamai/dsh', '~/.dsh', { source: 'dsh-hooks.ts: the bridge config teamai mounts through $DSH_HOME/cordis.patch.yml (#1219, #1223)' }),
  adapter('dsh', 'user', '~/.teamai/dsh', '/dsh', { env: { DSH_HOME: '/dsh' }, source: 'dsh config.ts dshHome: DSH_HOME moves the home, not teamai\'s bridge config' }),
  {
    tool: 'my-tool', scope: 'user', existingDirs: ['~/.my-tool'], installed: { probe: '~/.my-tool', met: true },
    install: { toolPaths: { 'my-tool': { skills: '.my-tool/skills', settings: '.my-tool/settings.json' } } },
    writes: [{ at: '~/.my-tool/settings.json', key: HOOK_LIST }], reads: 'unknown',
    source: 'a custom tool takes Claude-shaped hooks in its configured settings file, as it always has',
  },
  { tool: 'joycode', scope: 'user', channel: 'none', existingDirs: [], installed: { probe: '~/.joycode', met: false }, source: 'JoyCode 3.8.71 source: no lifecycle hooks (—s)' },
  adapter('kiro', 'user', '~/.kiro/hooks', '~/.kiro', { source: 'Kiro CLI V3 docs: hook files in ~/.kiro/hooks load for every agent (#1341)' }),
  { tool: 'trae', scope: 'user', channel: 'unknown', existingDirs: [], installed: { probe: '~/.trae', met: false }, source: 'issue #1221 matrix: Trae hooks ?t' },
];

describeLocateMatrix('hooks', ROWS);
