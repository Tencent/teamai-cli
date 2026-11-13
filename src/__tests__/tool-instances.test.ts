import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
