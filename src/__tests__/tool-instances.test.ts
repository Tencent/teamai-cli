import { execFileSync } from 'node:child_process';
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

  it.each([
    ['kiro', 'name: acme-kiro', 'an instance extends claude or codex; teamai does not support an instance of kiro or any other tool yet'],
    ['claude-internal', 'name: acme-claude', 'an instance extends claude or codex; teamai does not support an instance of claude-internal or any other tool yet'],
    ['cursor', 'name: cursor', 'teamai does not adjust cursor with a tools/ file yet; move its paths with a toolPaths.cursor entry in teamai.yaml'],
  ])('refuses an instance of %s, which no instance extends yet, naming the file and what to do instead', async (base, name, reason) => {
    const stem = name.slice('name: '.length);
    const text = ACME_CLAUDE.replace('extends: claude', `extends: ${base}`).replace('name: acme-claude', name);
    const { config, registry, errors } = await load(teamRepo({ [`tools/${stem}.yaml`]: text }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${stem}.yaml`)} is not valid: extends: ${reason}`)]);
    expect(registry.toolOf(stem)?.instance).toBeUndefined();
    expect(config?.toolPaths[stem]).toEqual(stem === 'cursor' ? expect.objectContaining({ skills: '.cursor/skills' }) : undefined);
  });

  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR'],
    ['codex', 'CODEX_HOME'],
  ])('refuses an instance of %s whose home.env is %s, which teamai sets to the instance home itself', async (base, variable) => {
    const stem = `acme-${base}`;
    const text = ACME_CLAUDE.replaceAll('claude', base).replace(/env: \w+/, `env: ${variable}`);
    const { registry, errors } = await load(teamRepo({ [`tools/${stem}.yaml`]: text }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${stem}.yaml`)} is not valid: home.env: ${variable} is the variable ${base} reads its home from, and teamai sets it to this instance's home when it starts it; leave env out`)]);
    expect(registry.toolOf(stem)).toBeUndefined();
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

  it('forgets the team repos it loaded once reset, so a repo loaded after defines a name anew', async () => {
    const repoOf = (dir: string, command: string): string => {
      const repo = path.join(root, dir);
      fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: acme\nrepo: acme/team\n');
      fs.writeFileSync(path.join(repo, 'tools', 'acme-claude.yaml'), ACME_CLAUDE.replace('command: acme-claude', `command: ${command}`));

      return repo;
    };
    const { loadTeamConfig } = await import('../config.js');
    const { resetToolInstancesForTests } = await import('../tool-instances.js');
    const registry = await import('../tool-registry.js');

    await loadTeamConfig(repoOf('first', 'acme-claude-1'));
    resetToolInstancesForTests();
    await loadTeamConfig(repoOf('second', 'acme-claude-2'));

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-2');
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

    // What list, status and skill show read: the instance is installed, with its skills in the moved home.
    const { detectInstalledAgents } = await import('../known-agents.js');
    const local: LocalConfig = { repo: { localPath: root, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user', enabledAgents: ['acme-claude'] };
    const agents = await detectInstalledAgents(local, config ?? { toolPaths: {} } as never);

    expect(agents.find((agent) => agent.id === 'acme-claude')).toMatchObject({ absoluteSkillsPath: path.join(moved, 'skills'), installed: true });
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

describe('the facts an instance keeps from the tool it extends', () => {
  const instanceOf = (base: string): string => `schemaVersion: v1alpha1\nname: acme-${base}\nextends: ${base}\nhome: { dir: .acme-${base} }\n`;
  const BASES = ['claude', 'codex'] as const;
  const workflow = { name: 'review', description: 'Review a change', invoke: 'allow', source: 'team', skill: 'review' } as const;

  /** Each fact as a reader of a tool name sees it. Each row tells the tool it extends apart from a custom tool, which has none of its facts. */
  const FACTS: ReadonlyArray<readonly [string, (typeof BASES)[number], (name: string) => Promise<unknown>]> = [
    ['where it reads its skills', 'claude', async (name) => {
      const { installOf, locate } = await import('../locate.js');
      const { loadTeamConfig } = await import('../config.js');
      const config = await loadTeamConfig(path.join(root, 'repo'));

      return (await locate(name, 'skills', installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user' }))).reads === 'unknown';
    }],
    ['whether a workflow skill pre-approves teamai', 'claude', async (name) => (await import('../workflow/discovery/render.js')).renderWorkflowSkill(workflow, name).includes('allowed-tools')],
    ['how it reads a delivered rule folder', 'claude', async (name) => (await import('../tool-registry.js')).folderReachOf(name)],
  ];

  it.each(FACTS)('%s', async (_fact, base, read) => {
    await load(teamRepo(Object.fromEntries(BASES.map((one) => [`tools/acme-${one}.yaml`, instanceOf(one)]))));
    fs.mkdirSync(path.join(home, `.acme-${base}`), { recursive: true });
    const shipped = await read(base);

    expect(await read(`acme-${base}`)).toEqual(shipped);
    expect(await read('custom-tool')).not.toEqual(shipped);
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

describe('the built-in hooks of an instance', () => {
  it('takes the hook entries of the tool it extends, each naming the instance', async () => {
    const { INSTANCE_BASES } = await import('../tool-registry.js');
    await load(teamRepo(Object.fromEntries(INSTANCE_BASES.map((tool) => [`tools/acme-${tool}.yaml`, `schemaVersion: v1alpha1\nname: acme-${tool}\nextends: ${tool}\nhome: { dir: .acme-${tool} }\n`]))));
    const { builtinHookDefs } = await import('../builtin-hooks.js');
    const entries = (tool: string, named = tool) => JSON.parse(JSON.stringify(builtinHookDefs(tool)).replaceAll(`--tool ${tool}`, `--tool ${named}`));

    expect(Object.fromEntries(INSTANCE_BASES.map((tool) => [tool, entries(`acme-${tool}`, tool)]))).toEqual(Object.fromEntries(INSTANCE_BASES.map((tool) => [tool, entries(tool)])));
  });
});

describe('the rules of an instance', () => {
  it('shares its rules directory with the member as the tool it extends does', async () => {
    const { INSTANCE_BASES } = await import('../tool-registry.js');
    await load(teamRepo(Object.fromEntries(INSTANCE_BASES.map((tool) => [`tools/acme-${tool}.yaml`, `schemaVersion: v1alpha1\nname: acme-${tool}\nextends: ${tool}\nhome: { dir: .acme-${tool} }\n`]))));
    const { sharesRulesDirWithMember } = await import('../resources/rule-format.js');

    expect(Object.fromEntries(INSTANCE_BASES.map((tool) => [tool, sharesRulesDirWithMember(`acme-${tool}`)])))
      .toEqual(Object.fromEntries(INSTANCE_BASES.map((tool) => [tool, sharesRulesDirWithMember(tool)])));
  });
});

describe('the project instructions of an instance', () => {
  it('reads the project file the tool it extends reads first', async () => {
    await load(teamRepo({ 'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n' }));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'shared');
    fs.writeFileSync(path.join(project, 'AGENTS.override.md'), 'override');
    const { nativeProjectInstructions } = await import('../instruction-targets.js');

    expect(await nativeProjectInstructions('acme-codex', project)).toBe(await nativeProjectInstructions('codex', project));
  });
});

describe('the co-author setting of an instance', () => {
  it.each([
    ['its own home', false],
    ['the home its own variable moves', true],
  ])('lands in the config of %s', async (_where, moved) => {
    const envOf = (variable: string): string => (moved ? `, env: ${variable}` : '');
    const repo = teamRepo({
      'tools/acme-codex.yaml': `schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex${envOf('ACME_CODEX_HOME')} }\n`,
      'tools/acme-claude.yaml': `schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .acme-claude${envOf('ACME_CLAUDE_CONFIG_DIR')} }\n`,
    });
    // A moved home is the only one on disk: nothing is left at the default it replaces.
    const codexHome = moved ? path.join(home, 'moved-codex') : path.join(home, '.acme-codex');
    const claudeHome = moved ? path.join(home, 'moved-claude') : path.join(home, '.acme-claude');

    if (moved) {
      vi.stubEnv('ACME_CODEX_HOME', codexHome);
      vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', claudeHome);
    }
    fs.appendFileSync(path.join(repo, 'teamai.yaml'), 'sharing:\n  coAuthor: { enabled: false }\n');
    const { config } = await load(repo);
    for (const dir of [codexHome, claudeHome]) fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    const { reconcileCoAuthorForConfig } = await import('../coauthor-reconcile.js');
    const { StateSchema } = await import('../types.js');
    const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user', enabledAgents: ['acme-codex', 'acme-claude'] };

    if (!config) throw new Error('the team config did not load');
    const { changes } = await reconcileCoAuthorForConfig(config, local, StateSchema.parse({}));

    expect(changes.map(({ tool, file }) => ({ tool, file }))).toEqual([
      { tool: 'acme-claude', file: path.join(claudeHome, 'settings.json') },
      { tool: 'acme-codex', file: path.join(codexHome, 'config.toml') },
    ]);
  });
});

describe('the model aliases of an instance', () => {
  const instance = (name: string, base: string, ownHome = `home: { dir: .${name} }\n`) => `schemaVersion: v1alpha1\nname: ${name}\nextends: ${base}\n${ownHome}`;
  const strong = new Map([['strong', { source: 'models/aliases.yaml', entries: { codex: { model: 'gpt-6', effort: 'high' } } }]]);
  const aliases = { ok: true, names: new Set(['strong']), team: strong, local: new Map(), inactive: new Map(), warnings: [], switches: { codex: { ok: true, switched: true } } } as const;

  beforeEach(async () => {
    await load(teamRepo({
      'tools/acme-codex.yaml': instance('acme-codex', 'codex'),
      'tools/twin-codex.yaml': instance('twin-codex', 'codex', ''),
    }));
  });

  it('gives an instance the entry of the tool it extends, and that tool\'s model switch only when it reads that tool\'s home', async () => {
    const { resolveModelValue } = await import('../models/aliases.js');

    expect(resolveModelValue(aliases, 'strong', 'acme-codex')).toMatchObject({ ok: true, step: 'team', model: 'gpt-6' });
    expect(resolveModelValue(aliases, 'strong', 'twin-codex')).toEqual(resolveModelValue(aliases, 'strong', 'codex'));
    expect(resolveModelValue(aliases, 'strong', 'custom-tool')).toEqual({ ok: true, step: 'default' });
    expect(resolveModelValue(aliases, 'gpt-5', 'custom-tool')).toEqual({ ok: true, step: 'literal', model: 'gpt-5' });
  });

  it('says an aliases entry keyed by an instance is ignored, as the instance takes the entry of the tool it extends', async () => {
    const repo = teamRepo({ 'tools/acme-codex.yaml': instance('acme-codex', 'codex'), 'models/aliases.yaml': 'aliases:\n  strong:\n    acme-codex: gpt-6\n' });
    await load(repo);
    const { loadTeamModelAliases } = await import('../models/aliases.js');
    const loaded = await loadTeamModelAliases({ repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user' });

    expect(loaded.ok && loaded.warnings.map(({ message }) => message)).toEqual([
      'models/aliases.yaml: alias "strong" maps "acme-codex", a tool instance, so that entry is ignored: an instance takes the entry of the tool it extends. Map codex instead.',
    ]);
  });

  it('judges with the model the tool it extends gets', async () => {
    const { chooseJudgeModel } = await import('../scorers/judge-model.js');

    expect(chooseJudgeModel(aliases, { name: 'quality', model: 'strong' }, ['acme-codex']))
      .toMatchObject({ ok: true, choice: { tool: 'acme-codex', by: 'scorer', model: { name: 'gpt-6' }, alias: 'strong' } });
  });
});

describe('the agents of an instance', () => {
  const ACME_CODEX = 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n';
  const REVIEWER = 'name: reviewer\ndescription: Reviews a change\ninstructions: Review it.\nmodel: strong\ntargets: [codex]\n';
  const ALIASES = 'aliases:\n  strong:\n    codex: gpt-6\n';

  async function delivered() {
    const repo = teamRepo({ 'tools/acme-codex.yaml': ACME_CODEX, 'agents/reviewer.yaml': REVIEWER, 'models/aliases.yaml': ALIASES });
    const { config } = await load(repo);
    fs.mkdirSync(path.join(home, '.acme-codex'), { recursive: true });
    const { AgentsHandler } = await import('../resources/agents.js');
    const handler = new AgentsHandler();
    const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user', enabledAgents: ['acme-codex'] };

    if (!config) throw new Error('the team config did not load');
    await handler.pullItem({ name: 'reviewer', type: 'agents', sourcePath: path.join(repo, 'agents', 'reviewer.yaml'), relativePath: 'agents/reviewer.yaml' }, config, local);

    return { handler, config, local, copy: path.join(home, '.acme-codex', 'agents', 'reviewer.toml') };
  }

  it('gets the team\'s agents in the format of the tool it extends, with that tool\'s model alias', async () => {
    const { copy } = await delivered();
    const { reverseByTool } = await import('../resources/agent-format.js');

    expect(reverseByTool('codex', copy, fs.readFileSync(copy, 'utf8'))).toMatchObject({ ok: true, spec: { name: 'reviewer', description: 'Reviews a change', model: 'gpt-6' } });
  });

  it('gives push the edit made to its copy, its alias kept', async () => {
    const { handler, config, local, copy } = await delivered();
    fs.writeFileSync(copy, fs.readFileSync(copy, 'utf8').replace('Reviews a change', 'Reviews a change closely'));

    expect(await handler.scanLocalForPush(config, local)).toMatchObject([
      { name: 'reviewer', status: 'modified', mergedSpec: { description: 'Reviews a change closely', model: 'strong' } },
    ]);
  });

  it('takes back a copy the team history proves teamai rendered for it when the agent is removed', async () => {
    const { handler, config, local, copy } = await delivered();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: local.repo.localPath, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'team');

    expect(await handler.removeItem('reviewer', config, local)).toContain(copy);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('reads the definition a step names from the instance\'s own agents, in the format of the tool it extends', async () => {
    const repo = teamRepo({ 'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n' });
    const { config } = await load(repo);
    const { renderForTool } = await import('../resources/agent-format.js');
    const { loadDeployedAgent } = await import('../workflow/step-model.js');
    const spec = { name: 'rev', description: 'Reviews a change', instructions: 'Review it.', model: 'gpt-6' };
    fs.mkdirSync(path.join(home, '.acme-codex', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.acme-codex', 'agents', 'rev.toml'), renderForTool(spec, 'codex').content);
    const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.com/acme/team.git' }, username: 'member', additionalRoles: [], scope: 'user' };

    expect(await loadDeployedAgent({ tool: 'acme-codex', name: 'rev', config: local, toolPaths: config?.toolPaths }))
      .toMatchObject({ spec: { name: 'rev', model: 'gpt-6' }, file: path.join(home, '.acme-codex', 'agents', 'rev.toml') });
  });

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
