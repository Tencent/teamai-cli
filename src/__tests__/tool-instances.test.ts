import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';

/**
 * Tool instances as `loadTeamConfig` reads them: a team's in tools/ of its repo, a member's in ~/.teamai/tools/, and
 * every lookup of a tool name seeing them. Each test loads the modules afresh, since the instances a process read
 * are the ones it keeps.
 */

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-instances-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function teamRepo(files: Record<string, string>): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: acme\nrepo: acme/team\n');

  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }

  return repo;
}

function personal(name: string, text: string): void {
  const dir = path.join(home, '.teamai', 'tools');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), text);
}

const ACME_CLAUDE = `schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
`;

async function load(repo: string) {
  const { loadTeamConfig } = await import('../config.js');
  const registry = await import('../tool-registry.js');
  const { log } = await import('@teamai/shared/log');
  const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  const config = await loadTeamConfig(repo);

  return { config, registry, errors: errors.mock.calls.map(([message]) => String(message)) };
}

describe('team tool instances', () => {
  it('reads a team instance as a tool of its own over the tool it extends, with that tool\'s paths moved to its home', async () => {
    const { config, registry } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));

    expect(registry.toolOf('acme-claude')).toMatchObject({ name: 'acme-claude', base: 'claude', instance: { command: 'acme-claude', source: 'team' } });
    expect(registry.channelsOf('acme-claude')).toEqual(registry.channelsOf('claude'));
    expect(registry.sessionPlatformsOf('acme-claude')).toEqual(['acme-claude']);
    expect(config?.toolPaths['acme-claude']).toEqual({
      skills: '.acme-claude/skills', rules: '.acme-claude/rules', settings: '.acme-claude/settings.json', claudemd: '.acme-claude/CLAUDE.md',
      agents: '.acme-claude/agents', mcp: '.acme-claude/.claude.json', mcpProject: '.mcp.json',
    });
    expect(config?.toolPaths.claude?.skills).toBe('.claude/skills');
  });

  it('gives an instance the paths it sets, whole', async () => {
    const { config } = await load(teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .acme/skills }\n` }));

    expect(config?.toolPaths['acme-claude']).toEqual({ skills: '.acme/skills' });
  });

  it('lets a team instance named like a shipped tool replace that tool\'s paths, as a toolPaths entry does', async () => {
    const { config, registry } = await load(teamRepo({ 'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n' }));

    expect(config?.toolPaths.claude).toEqual({ skills: '.claude/team-skills' });
    expect(registry.sessionPlatformsOf('claude')).toEqual(['claude-code']);
  });

  it.each([
    ['a format key', 'sessions: pi\n', /sets sessions, and an instance sets only command, home and paths/],
    ['another key', 'launch: { args: [-p] }\n', /sets launch, and an instance sets only command, home and paths/],
    ['an unknown tool', '', /extends: nope is not a tool teamai ships/],
  ])('refuses an instance that sets %s, naming it, and uses none of it', async (_, extra, message) => {
    const text = _ === 'an unknown tool' ? ACME_CLAUDE.replace('extends: claude', 'extends: nope') : `${ACME_CLAUDE}${extra}`;
    const { config, registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': text }));

    expect(errors).toEqual([expect.stringMatching(message)]);
    expect(errors[0]).toContain(path.join('tools', 'acme-claude.yaml'));
    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(config?.toolPaths['acme-claude']).toBeUndefined();
  });

  it.each(['./scripts/acme-claude', 'bin/acme-claude', '/opt/acme/bin/acme-claude', String.raw`tools\acme-claude.exe`])(
    'refuses an instance whose command is the path %s, since what runs at a path is not the file a person accepted',
    async (command) => {
      const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', `command: '${command}'`) }));

      expect(errors).toEqual([expect.stringContaining('command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude')]);
      expect(registry.toolOf('acme-claude')).toBeUndefined();
    },
  );

  it.each(['C:acme-claude', '.:acme-claude', '$PATH:acme-claude', 'acme*', 'acme-claude?'])(
    'refuses an instance whose command is %s, which Windows reads as a place or a wildcard and may find in the checkout',
    async (command) => {
      const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', `command: '${command}'`) }));

      expect(errors).toEqual([expect.stringContaining('command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude')]);
      expect(registry.toolOf('acme-claude')).toBeUndefined();
    },
  );

  it('names an instance it refuses once per pull, though a pull loads the team config many times', async () => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', "command: './scripts/acme-claude'") });
    const { loadTeamConfig } = await import('../config.js');
    const { resetWarnOnce } = await import('../utils/warn-once.js');
    const { log } = await import('@teamai/shared/log');
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const shown = () => errors.mock.calls.map(([message]) => String(message));
    const refusal = expect.stringContaining('command: command is the name of one executable on PATH');

    for (let pass = 0; pass < 3; pass++) await loadTeamConfig(repo);
    expect(shown()).toEqual([refusal]);

    resetWarnOnce();
    await loadTeamConfig(repo);
    expect(shown()).toEqual([refusal, refusal]);
  });

  it('accepts an instance whose command is a bare name, looked up on PATH where the tool runs', async () => {
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-2.4') }));

    expect(errors).toEqual([]);
    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-2.4');
  });

  it('refuses an instance not named after its file, or named like another shipped tool', async () => {
    const { errors, registry } = await load(teamRepo({
      'tools/acme.yaml': ACME_CLAUDE,
      'tools/codex.yaml': 'schemaVersion: v1alpha1\nname: codex\nextends: claude\n',
    }));

    expect(errors).toEqual([
      expect.stringContaining('its name is "acme-claude", and an instance is named after its file, "acme"'),
      expect.stringContaining('"codex" is a tool teamai ships, and an instance named like one adjusts it, so it extends codex'),
    ]);
    expect(registry.toolOf('codex')).toEqual({ name: 'codex', base: 'codex' });
  });

  it('uses neither of two namespaces that define one name, and names both files', async () => {
    const { errors, registry } = await load(teamRepo({ 'tools/web/acme-claude.yaml': ACME_CLAUDE, 'tools/mobile/acme-claude.yaml': ACME_CLAUDE }));

    expect(errors).toEqual([expect.stringMatching(/"acme-claude" is defined twice in the team repo \(tools\/mobile\/acme-claude\.yaml and tools\/web\/acme-claude\.yaml\)/)]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
  });

  it('lets a namespace instance replace the root one of the same name', async () => {
    const { registry } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE, 'tools/web/acme-claude.yaml': ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-web') }));

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-web');
  });
});

describe('the sessions of an instance', () => {
  it('reads an instance that keeps the home of the tool it extends on that tool\'s platform, listed once', async () => {
    await load(teamRepo({
      'tools/review-claude.yaml': 'schemaVersion: v1alpha1\nname: review-claude\nextends: claude\npaths: { skills: .claude/review-skills }\n',
      'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n',
      'tools/acme-claude.yaml': ACME_CLAUDE,
    }));
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const { listAvailablePlatforms } = await import('../session-flow/adapters/index.js');
    const platforms = listAvailablePlatforms();

    expect(AgentSession.platformForTool('review-claude')).toBe('claude-code');
    expect(AgentSession.platformForTool('acme-claude')).toBe('acme-claude');
    expect(platforms.filter((platform) => platform === 'claude-code')).toHaveLength(1);
    expect(platforms).toContain('acme-claude');
    expect(platforms).not.toContain('review-claude');
  });
});

describe('the home of an instance', () => {
  it.each(['project', 'user'] as const)('reads, in %s scope, the rules, instruction blocks and agents teamai writes under its home, as the tool it extends reads its own', async (scope) => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const { config } = await load(repo);
    const { installOf, locate, unreadWrites, writesOf } = await import('../locate.js');
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.acme-claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.acme-claude'), { recursive: true });
    const install = installOf(config ?? { toolPaths: {} }, { repo: {}, scope, projectRoot: project });
    const base = scope === 'project' ? project : home;
    const session = scope === 'project' ? { kind: 'within', root: project } as const : { kind: 'anywhere' } as const;

    for (const resource of ['rules', 'blocks', 'agents'] as const) {
      const where = await locate('acme-claude', resource, install);

      expect(writesOf(where).map((place) => place.path)[0], resource).toMatch(new RegExp(`^${base}/\\.acme-claude/`));
      expect(unreadWrites(where, undefined, session), resource).toEqual([]);
    }
  });

  it('reads, in user scope, the MCP servers teamai writes to the file inside its home, as the tool it extends reads its file beside its own home', async () => {
    const { config } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));
    const { installOf, locate, unreadWrites, writesOf } = await import('../locate.js');
    fs.mkdirSync(path.join(home, '.acme-claude'), { recursive: true });
    const install = installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user' });
    const where = await locate('acme-claude', 'mcp', install);

    expect(writesOf(where).map((place) => place.path)).toEqual([path.join(home, '.acme-claude', '.claude.json')]);
    expect(unreadWrites(where, undefined, { kind: 'anywhere' })).toEqual([]);
  });

  it('delivers, in user scope, to the home its variable moves, where it reads its sessions', async () => {
    const moved = path.join(root, 'acme');
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', moved);
    fs.mkdirSync(moved, { recursive: true });
    const { config } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));
    const { installOf, isInstalledFor, locate, writesOf } = await import('../locate.js');
    const { storeDirOf } = await import('../session-flow/adapters/index.js');
    const install = installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user' });
    const skills = await locate('acme-claude', 'skills', install);

    expect(writesOf(skills).map((place) => place.path)).toEqual([path.join(moved, 'skills')]);
    expect(isInstalledFor(skills)).toBe(true);
    expect(writesOf(await locate('acme-claude', 'mcp', install)).map((place) => place.path)).toEqual([path.join(moved, '.claude.json')]);
    expect(storeDirOf('acme-claude', undefined)).toBe(path.join(moved, 'projects'));
  });

  it('makes, at init in user scope, the folders of the home its variable moves and none in the home it would have', async () => {
    const moved = path.join(root, 'acme');
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', moved);
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const { config } = await load(repo);
    const { seedSelfModeToolDirs } = await import('../known-agents.js');
    const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user', enabledAgents: ['acme-claude'] };

    if (!config) throw new Error('the team config did not load');

    expect(await seedSelfModeToolDirs(local, config)).toEqual(['acme-claude']);
    expect(fs.readdirSync(moved).sort()).toEqual(['agents', 'rules', 'skills']);
    expect(fs.existsSync(path.join(home, '.acme-claude'))).toBe(false);
  });

  it('reads where the tool it extends reads when it sets its own paths, which teamai writes to whole', async () => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .claude/skills, rules: .claude/rules }\n` });
    const { config } = await load(repo);
    const { installOf, locate, unreadWrites, writesOf } = await import('../locate.js');
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    const install = installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'project', projectRoot: project });
    const where = await locate('acme-claude', 'rules', install);

    expect(writesOf(where).map((place) => place.path)).toEqual([path.join(project, '.claude', 'rules')]);
    expect(unreadWrites(where, undefined, { kind: 'within', root: project })).toEqual([]);
  });
});

describe('the OpenCode sessions of an instance', () => {
  const ACME_OPENCODE = 'schemaVersion: v1alpha1\nname: acme-opencode\nextends: opencode\ncommand: acme-opencode\nhome: { dir: .acme-opencode, env: XDG_DATA_HOME }\n';

  /** A project with one session of the instance in its store, and on PATH only `acme-opencode`, never `opencode`. */
  async function onlyTheInstanceInstalled(): Promise<{ project: string; sessionId: string }> {
    const { installFakeOpencode, opencodeExportFixture, plantOpencodeSession } = await import('@teamai/tool-opencode/testing');
    const bin = installFakeOpencode();
    fs.renameSync(path.join(bin, 'opencode'), path.join(bin, 'acme-opencode'));
    fs.rmSync(path.join(bin, 'opencode.cmd'));
    vi.stubEnv('PATH', bin);
    vi.stubEnv('XDG_DATA_HOME', '');
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const session = opencodeExportFixture();
    session.info.id = 'ses_ec4a5b73fffeAAAAAAAAAAAAAA';
    session.info.location.directory = project;
    fs.mkdirSync(path.join(home, '.acme-opencode', 'opencode'), { recursive: true });
    plantOpencodeSession(path.join(home, '.acme-opencode'), session);

    return { project, sessionId: session.info.id };
  }

  it('lists a member\'s own instance with its own command, where the shipped one is not installed', async () => {
    personal('acme-opencode', ACME_OPENCODE);
    const { project, sessionId } = await onlyTheInstanceInstalled();
    await load(teamRepo({}));
    const { AgentSession } = await import('../session-flow/agent-session.js');

    const listed = await AgentSession.list({ platforms: ['acme-opencode'], cwd: project });

    expect(listed.failures).toEqual([]);
    expect(listed.sessions.map((one) => ({ platform: one.platform, sessionId: one.sessionId }))).toEqual([{ platform: 'acme-opencode', sessionId }]);
  });

  it('runs a team instance\'s command only once a person accepted its file, and the shipped one until then', async () => {
    const { project, sessionId } = await onlyTheInstanceInstalled();
    await load(teamRepo({ 'tools/acme-opencode.yaml': ACME_OPENCODE }));
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const registry = await import('../tool-registry.js');
    const { acceptToolCommand } = await import('../tool-instances.js');
    const instance = registry.toolOf('acme-opencode')?.instance;

    expect((await AgentSession.list({ platforms: ['acme-opencode'], cwd: project })).failures)
      .toEqual([{ platform: 'acme-opencode', code: 'tool_unavailable', message: 'The opencode CLI was not found on PATH. Install OpenCode 2 or later.' }]);

    if (!instance) throw new Error('the team instance did not load');
    expect(await acceptToolCommand(instance, { ask: async () => 'y' })).toEqual({ ok: true });

    expect((await AgentSession.list({ platforms: ['acme-opencode'], cwd: project })).sessions.map((one) => one.sessionId)).toEqual([sessionId]);
  });
});

describe('the facts an instance keeps from the tool it extends', () => {
  const instanceOf = (base: string): string => `schemaVersion: v1alpha1\nname: acme-${base}\nextends: ${base}\nhome: { dir: .acme-${base} }\n`;
  const BASES = ['claude', 'cursor', 'agy', 'openclaw'] as const;
  const workflow = { name: 'review', description: 'Review a change', invoke: 'allow', source: 'team', skill: 'review' } as const;

  /** Each fact as a reader of a tool name sees it. Each row tells the tool it extends apart from a custom tool, which has none of its facts. */
  const FACTS: ReadonlyArray<readonly [string, (typeof BASES)[number], (name: string) => Promise<unknown>]> = [
    ['where it reads its skills', 'claude', async (name) => {
      const { installOf, locate } = await import('../locate.js');
      const { loadTeamConfig } = await import('../config.js');
      const config = await loadTeamConfig(path.join(root, 'repo'));

      return (await locate(name, 'skills', installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user' }))).reads === 'unknown';
    }],
    ['which calls load a skill', 'agy', async (name) => (await import('../skill-use.js')).skillCandidates({ tool_name: 'Skill', tool_input: { skill: 'review' } }, name)],
    ['whether its search output shows the lines it read', 'cursor', async (name) => (await import('../utils/tool-call.js'))
      .classifyToolCall({ tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(root, 'a.md'), output_mode: 'content' }, tool_response: '3:x', cwd: root }, name).paths],
    ['whether a workflow skill pre-approves teamai', 'claude', async (name) => (await import('../workflow/discovery/render.js')).renderWorkflowSkill(workflow, name).includes('allowed-tools')],
    ['how it reads a delivered rule folder', 'claude', async (name) => (await import('../tool-registry.js')).folderReachOf(name)],
    ['whether its skills follow the session', 'openclaw', async (name) => (await import('../tool-registry.js')).skillsFollowSession(name)],
  ];

  it.each(FACTS)('%s', async (_fact, base, read) => {
    await load(teamRepo(Object.fromEntries(BASES.map((one) => [`tools/acme-${one}.yaml`, instanceOf(one)]))));
    fs.mkdirSync(path.join(home, `.acme-${base}`), { recursive: true });
    const shipped = await read(base);

    expect(await read(`acme-${base}`)).toEqual(shipped);
    expect(await read('custom-tool')).not.toEqual(shipped);
  });

  it('compares the skills of an instance whose skills follow the session by its own home', async () => {
    await load(teamRepo({ 'tools/acme-openclaw.yaml': instanceOf('openclaw') }));
    const { sessionToolHomesOf } = await import('../resources/places.js');

    expect(sessionToolHomesOf({ skills: { 'acme-openclaw': [path.join(home, '.acme-openclaw', 'skills')] } }))
      .toEqual({ 'acme-openclaw': path.join(home, '.acme-openclaw') });
  });
});

describe('the hooks of an instance', () => {
  it('writes the built-in hooks in its own home as the member\'s, in the form the tool it extends takes in its home', async () => {
    await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));
    const { builtinHookFormOf } = await import('../hooks.js');
    const formIn = async (tool: string, dir: string) => (await builtinHookFormOf({ tool, settingsPath: path.join(home, dir, 'settings.json'), from: 'installed' })).loginDeferred;

    expect(await formIn('acme-claude', '.acme-claude')).toBe(await formIn('claude', '.claude'));
    expect(await formIn('claude', '.claude')).toBe(process.platform !== 'win32');
  });
});

describe('the agents of an instance', () => {
  it('gets teamai\'s own agents in the format of the tool it extends, and recall off takes them back', async () => {
    const repo = teamRepo({ 'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n' });
    const { config } = await load(repo);
    fs.mkdirSync(path.join(home, '.acme-codex'), { recursive: true });
    const { deployBuiltinAgents } = await import('../builtin-agents.js');
    const { removeRecallAgentAndRule } = await import('../recall-toggle.js');
    const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user', enabledAgents: ['acme-codex'] };

    if (!config) throw new Error('the team config did not load');
    await deployBuiltinAgents(config, local);

    expect(fs.readdirSync(path.join(home, '.acme-codex', 'agents'))).toEqual(['teamai-recall.toml']);

    await removeRecallAgentAndRule(config, local);

    expect(fs.readdirSync(path.join(home, '.acme-codex', 'agents'))).toEqual([]);
  });
});

describe('personal tool instances', () => {
  it('lets a member\'s own instance replace the team\'s of the same name', async () => {
    personal('acme-claude', ACME_CLAUDE.replace('command: acme-claude', 'command: my-acme-build'));
    const { registry, config } = await load(teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .acme/skills }\n` }));

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'my-acme-build', source: 'personal' });
    expect(config?.toolPaths['acme-claude']?.skills).toBe('.acme-claude/skills');
  });

  it('leaves the member\'s own instances out once the process ignores them, and the team\'s take their place', async () => {
    personal('acme-claude', ACME_CLAUDE.replace('command: acme-claude', 'command: my-acme-build'));
    personal('mine', 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const { ignorePersonalToolInstances } = await import('../tool-instances.js');
    ignorePersonalToolInstances();
    const { registry, config } = await load(repo);

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'acme-claude', source: 'team' });
    expect(registry.toolOf('mine')).toBeUndefined();
    expect(config?.toolPaths.mine).toBeUndefined();
  });
});

describe('resume --next', () => {
  it('drives a run another member handed over without the member\'s own instances', async () => {
    personal('mine', 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const { registry } = await load(teamRepo({}));
    expect(registry.toolOf('mine')?.instance?.source).toBe('personal');
    const { workflowResume } = await import('../workflow-commands.js');
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cwd = process.cwd();
    process.chdir(root);

    try {
      await workflowResume(undefined, { next: true });
    } finally {
      process.chdir(cwd);
      written.mockRestore();
    }

    expect(registry.toolOf('mine')).toBeUndefined();
  });
});
