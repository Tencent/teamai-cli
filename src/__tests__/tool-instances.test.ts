import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
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

/** The member's user-scope config, whose team repo is `repo`, with `fields` (`projects: [...]`) set. */
function memberOf(repo: string, fields: { projects?: string[] }): void {
  const dir = path.join(home, '.teamai');
  fs.mkdirSync(dir, { recursive: true });
  const projects = fields.projects ? `projects: [${fields.projects.join(', ')}]\n` : '';
  fs.writeFileSync(path.join(dir, 'config.yaml'), `repo:\n  localPath: ${repo}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n${projects}`);
}

const ACME_CLAUDE = `schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
`;

async function load(repo: string, member?: LocalConfig) {
  const { loadTeamConfig } = await import('../config.js');
  const registry = await import('../tool-registry.js');
  const { log } = await import('@teamai/shared/log');
  const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  const config = await loadTeamConfig(repo, member ?? null);

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
    const { config } = await load(teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .acme-claude/team-skills }\n` }));

    expect(config?.toolPaths['acme-claude']).toEqual({ skills: '.acme-claude/team-skills' });
  });

  it('lets a team instance named like a shipped tool replace that tool\'s paths, as a toolPaths entry does', async () => {
    const { config, registry } = await load(teamRepo({ 'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills }\n' }));

    expect(config?.toolPaths.claude).toEqual({ skills: '.claude/team-skills' });
    expect(registry.sessionPlatformsOf('claude')).toEqual(['claude-code']);
  });

  it('moves the paths of the tool an instance extends as the team adjusted them, the paths judging reads', async () => {
    const { config } = await load(teamRepo({
      'tools/codex.yaml': 'schemaVersion: v1alpha1\nname: codex\nextends: codex\npaths: { skills: .codex/team-skills, settings: .codex/hooks.json, agents: .codex/team-agents }\n',
      'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n',
    }));
    const { agentModelToolOf } = await import('../models/aliases.js');
    const toolPaths = config?.toolPaths ?? {};

    expect([toolPaths['acme-codex'], agentModelToolOf('acme-codex', { scope: 'project', toolPaths, toolRoots: {} })]).toEqual([
      expect.objectContaining({ skills: '.codex/team-skills', agents: '.codex/team-agents', userScope: { skills: '.acme-codex/team-skills', settings: '.acme-codex/hooks.json', agents: '.acme-codex/team-agents' } }),
      'codex',
    ]);
  });

  it('moves a user-scope hooks file the team gave the tool an instance extends into the instance\'s home', async () => {
    const { config } = await load(teamRepo({
      'tools/codex.yaml': 'schemaVersion: v1alpha1\nname: codex\nextends: codex\npaths: { userScope: { settings: .codex/hooks.json } }\n',
      'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\n',
    }));

    expect(config?.toolPaths['acme-codex']?.userScope?.settings).toBe('.acme-codex/hooks.json');
  });

  // An adjustment changes where teamai writes for the shipped tool; what runs it and where it lives are an instance's.
  it.each([
    ['codex', 'command: acme-codex\n', 'command'],
    ['claude', 'home: { dir: .work-claude }\n', 'home'],
  ])('refuses a tools/%s.yaml that sets more than paths (%#), naming the file and the instance to write instead', async (tool, extra, key) => {
    const { config, registry, errors } = await load(teamRepo({ [`tools/${tool}.yaml`]: `schemaVersion: v1alpha1\nname: ${tool}\nextends: ${tool}\npaths: { skills: .${tool}/team-skills }\n${extra}` }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${tool}.yaml`)} is not valid: it sets ${key}, and a file named like the tool it adjusts sets only paths; `
      + `to run another command or keep another home, write an instance of ${tool} instead, such as name: acme-${tool}, extends: ${tool} in tools/acme-${tool}.yaml. Fix the file; until then teamai does not use it.`)]);
    expect(registry.toolOf(tool)?.instance).toBeUndefined();
    expect(config?.toolPaths[tool]?.skills).not.toBe(`.${tool}/team-skills`);
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
    ['claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR', process.platform],
    ['codex', 'CODEX_HOME', 'CODEX_HOME', process.platform],
    // Windows reads a variable's name in any case, and a team file reaches every member's platform.
    ['codex', 'Codex_Home', 'CODEX_HOME', 'win32'],
    ['codex', 'Codex_Home', 'CODEX_HOME', 'linux'],
  ] as const)('refuses an instance of %s whose home.env is %s, which teamai sets to the instance home itself (%s, on %s)', async (base, spelled, variable, platform) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    onTestFinished(() => { Object.defineProperty(process, 'platform', { value: original, configurable: true }); });
    const stem = `acme-${base}`;
    const text = ACME_CLAUDE.replaceAll('claude', base).replace(/env: \w+/, `env: ${spelled}`);
    const { registry, errors } = await load(teamRepo({ [`tools/${stem}.yaml`]: text }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${stem}.yaml`)} is not valid: home.env: ${spelled} names ${variable}, the variable ${base} reads its home from in any letter case, and teamai sets it to this instance's home when it starts it; leave env out`)]);
    expect(registry.toolOf(stem)).toBeUndefined();
  });

  it.each([
    ['claude', '.claude', 'claude'],
    ['codex', '.codex', 'codex'],
    ['claude', '.codex', 'codex'],
  ])('refuses an instance of %s whose home.dir is %s, the home of %s, naming the file', async (base, dir, other) => {
    const stem = `acme-${base}`;
    const text = ACME_CLAUDE.replaceAll('claude', base).replace(`dir: .acme-${base}`, `dir: ${dir}`);
    const { config, registry, errors } = await load(teamRepo({ [`tools/${stem}.yaml`]: text }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${stem}.yaml`)} is not valid: home.dir: ${dir} is the home of ${other} too`)]);
    expect(registry.toolOf(stem)).toBeUndefined();
    expect(config?.toolPaths[stem]).toBeUndefined();
  });

  // macOS's default volume ignores case, so .Claude is the directory Claude Code reads; Windows's path.relative ignores it too.
  it.each(['darwin', 'win32'] as const)('refuses an instance whose home.dir is the home of another tool in another letter case, on %s', async (platform) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    onTestFinished(() => { Object.defineProperty(process, 'platform', { value: original, configurable: true }); });
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('dir: .acme-claude', 'dir: .Claude') }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', 'acme-claude.yaml')} is not valid: home.dir: .Claude is the home of claude too`)]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
  });

  it.each(['.', './', './/.'])('refuses an instance whose home.dir %s is the home itself, where Claude Code would read ~/CLAUDE.md for every project', async (dir) => {
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE.replace('dir: .acme-claude', `dir: '${dir}'`) }));

    expect(errors).toEqual([expect.stringContaining(`${path.join('tools', 'acme-claude.yaml')} is not valid: home.dir: home.dir is a directory under your home, such as .acme-claude, not your home itself, with no ..`)]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
  });

  it('refuses two instances on one home.dir, each naming the other', async () => {
    const codex = 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-claude }\n';
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE, 'tools/acme-codex.yaml': codex }));

    expect(errors.sort()).toEqual([
      expect.stringContaining(`${path.join('tools', 'acme-claude.yaml')} is not valid: home.dir: .acme-claude is the home of acme-codex too`),
      expect.stringContaining(`${path.join('tools', 'acme-codex.yaml')} is not valid: home.dir: .acme-claude is the home of acme-claude too`),
    ]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(registry.toolOf('acme-codex')).toBeUndefined();
  });

  it.each([
    ['its own variable names the home of Claude Code', '.claude', () => vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', path.join(home, '.claude'))],
    ['the member recorded the Claude Code home there (toolRoots.claude)', '.acme-claude', () => {
      fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), 'repo: { localPath: /x, remote: x }\nusername: u\nscope: user\nadditionalRoles: []\ntoolRoots: { claude: ~/.acme-claude }\n');
    }],
  ])('does not use an instance whose home resolves to the home of another tool when %s, naming both, and a pull neither records it nor lets its variable through', async (_, dir, setup) => {
    setup();
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));

    expect(errors).toEqual([`Tool instance acme-claude (tools/acme-claude.yaml) is not used: its home resolves to ${path.join(home, dir)}, which is also the home of claude, and two tools on one home write over each other's skills, hooks and sessions. Move one of the two homes, then re-run \`teamai init\`, or clear the record with \`ACME_CLAUDE_CONFIG_DIR= teamai init\`: a pull keeps the home it recorded.`]);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
    const { recordToolHomes } = await import('../tool-home-record.js');
    const { toolHomeVariableNames } = await import('../tool-home.js');
    // Only init may record a refused instance's home: a pull would pin the refusal in every shell.
    expect(await recordToolHomes('pull')).toEqual([]);
    // A child with another HOME cannot judge the refusal again, so the variable has to be stripped before it starts.
    expect(toolHomeVariableNames()).toContain('ACME_CLAUDE_CONFIG_DIR');
  });

  // init takes a refused instance in --agent and records its home from the files: else no value could ever replace this record.
  it.each([
    { refusal: 'the home of Claude Code', recorded: '.claude', toolRoots: '' },
    { refusal: 'the root recorded for Claude Code', recorded: '.claude-work', toolRoots: 'toolRoots: { claude: ~/.claude-work }\n' },
    { refusal: 'your home directory itself', recorded: '', toolRoots: '' },
  ].flatMap((row) => [{ ...row, action: 'replace', value: '.acme-good' }, { ...row, action: 'clear', value: null }]))(
    'lets init, given the instance in --agent, $action the record that put it at $refusal, after which the instance is used',
    async ({ recorded, toolRoots, value }) => {
      fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
      fs.writeFileSync(path.join(home, '.teamai', 'tool-homes.json'), JSON.stringify({ 'acme-claude': path.join(home, recorded) }));
      if (toolRoots) fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), `repo: { localPath: /x, remote: x }\nusername: u\nscope: user\nadditionalRoles: []\n${toolRoots}`);
      const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
      const refused = await load(repo);
      expect([refused.registry.toolOf('acme-claude'), refused.errors]).toEqual([undefined, [expect.stringContaining('Tool instance acme-claude (tools/acme-claude.yaml) is not used')]]);
      if (recorded !== '') expect(refused.errors[0]).toContain('or clear the record with `ACME_CLAUDE_CONFIG_DIR= teamai init`');
      const { teamToolIds } = await import('../config.js');
      expect(await teamToolIds(repo, refused.config)).toContain('acme-claude');
      vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', value === null ? '' : path.join(home, value));
      const { recordToolHomes } = await import('../tool-home-record.js');

      expect(await recordToolHomes('init')).toEqual([{ tool: 'acme-claude', variable: 'ACME_CLAUDE_CONFIG_DIR', dir: value === null ? null : path.join(home, value), previous: path.join(home, recorded) }]);
      vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', undefined);
      expect((await load(repo)).registry.toolOf('acme-claude')).toMatchObject({ name: 'acme-claude' });
    },
  );

  it.each([
    ['your home directory', ''],
    ['your home directory with a trailing separator', path.sep],
  ])('does not use an instance whose own variable names %s, as the home it would treat as its own', async (_, trailing) => {
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', `${home}${trailing}`);
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));

    expect(errors).toEqual([`Tool instance acme-claude (tools/acme-claude.yaml) is not used: its home resolves to your home directory itself, ${home}, `
      + 'where it would read and write every file in your home as its own. Point ACME_CLAUDE_CONFIG_DIR at a directory of its own and re-run `teamai init`.']);
    expect(registry.toolOf('acme-claude')).toBeUndefined();
  });

  // An instance with a home starts at that home, the one place it reads its user files from, so a user path outside it is read by nothing.
  it.each([
    { case: 'refuses one with no command whose paths leave its home', file: 'home: { dir: .acme-codex }\npaths: { skills: .codex/skills, settings: .codex/hooks.json }\n', refused: 'paths.skills: .codex/skills', dir: '.acme-codex' },
    { case: 'refuses one with no command whose user-scope paths leave its nested home', file: 'home: { dir: work/.acme-codex }\npaths: { skills: work/.acme-codex/skills, userScope: { agents: .codex/agents } }\n', refused: 'paths.userScope.agents: .codex/agents', dir: 'work/.acme-codex' },
    { case: 'uses one with no command whose project paths are the tool\'s and whose user paths are in its home', file: 'home: { dir: work/.acme-codex }\npaths: { skills: .codex/skills, userScope: { skills: work/.acme-codex/skills } }\n', refused: undefined },
    { case: 'refuses one with a command of its own whose hooks file is the one of the tool it extends', file: 'command: acme-codex\nhome: { dir: .acme-codex }\npaths: { skills: .acme-codex/skills, settings: .codex/hooks.json }\n', refused: 'paths.settings: .codex/hooks.json', dir: '.acme-codex' },
    { case: 'uses one with a command of its own whose project paths are the tool\'s and whose user paths are in its home', file: 'command: acme-codex\nhome: { dir: .acme-codex }\npaths: { skills: .codex/skills, userScope: { skills: .acme-codex/skills, settings: .acme-codex/hooks.json } }\n', refused: undefined },
    // Codex reads ~/.agents/skills whatever its home, so a path there is read from the instance's home too.
    { case: 'uses one whose skills are the shared directory Codex reads from any home', file: 'command: acme-codex\nhome: { dir: .acme-codex }\npaths: { skills: .agents/skills, settings: .acme-codex/hooks.json }\n', refused: undefined },
    // Claude Code reads .claude.json inside the home its variable names, so the one beside the home of Claude Code is read by nothing.
    { case: 'refuses one of Claude Code whose MCP file is the one beside the home of Claude Code', base: 'claude', file: 'home: { dir: .acme-claude }\npaths: { skills: .acme-claude/skills, mcp: .claude.json }\n', refused: 'paths.mcp: .claude.json', dir: '.acme-claude' },
  ])('$case', async ({ base = 'codex', file, refused, dir }) => {
    const name = `acme-${base}`;
    const { registry, errors } = await load(teamRepo({ [`tools/${name}.yaml`]: `schemaVersion: v1alpha1\nname: ${name}\nextends: ${base}\n${file}` }));

    if (refused === undefined) {
      expect([errors, registry.toolOf(name)?.name]).toEqual([[], name]);
    } else {
      expect(errors).toEqual([expect.stringContaining(`${path.join('tools', `${name}.yaml`)} is not valid: ${refused} is outside home.dir ${dir}, and teamai starts ${name} `
        + `with its home at ${dir}, the one place it reads user files from, so it would read none of it. Point every user-scope path inside ${dir}, or leave home out to keep the home of ${base}. Fix the file`)]);
      expect(registry.toolOf(name)).toBeUndefined();
    }
  });

  it('starts an instance whose skills are the shared directory Codex reads at its home, and delivers them where Codex reads them from it', async () => {
    fs.mkdirSync(path.join(home, '.acme-codex'));
    const { config } = await load(teamRepo({ 'tools/acme-codex.yaml': 'schemaVersion: v1alpha1\nname: acme-codex\nextends: codex\nhome: { dir: .acme-codex }\npaths: { skills: .agents/skills, settings: .acme-codex/hooks.json }\n' }));
    const { toolCommandEnv } = await vi.importActual<typeof import('../launch-registry.js')>('../launch-registry.js');
    const { installOf, locate, ownOf, unreadWrites } = await import('../locate.js');
    const skills = await locate('acme-codex', 'skills', installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user' }));

    expect({
      launch: toolCommandEnv('acme-codex', { kind: 'delivered', inherited: {}, toolRoots: {} }),
      skills: ownOf(skills)?.path,
      unread: unreadWrites(skills, undefined, { kind: 'anywhere' }),
      gate: skills.gates.find((gate) => gate.kind === 'installed'),
    }).toEqual({
      launch: { kind: 'ready', env: { CODEX_HOME: path.join(home, '.acme-codex') } },
      skills: path.join(home, '.agents', 'skills'),
      unread: [],
      gate: expect.objectContaining({ probe: path.join(home, '.acme-codex'), met: true }),
    });
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

    for (let pass = 0; pass < 3; pass++) await loadTeamConfig(repo, null);
    expect(shown()).toEqual([refusal]);

    resetWarnOnce();
    await loadTeamConfig(repo, null);
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

    await loadTeamConfig(repoOf('first', 'acme-claude-1'), null);
    resetToolInstancesForTests();
    await loadTeamConfig(repoOf('second', 'acme-claude-2'), null);

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-2');
  });

  it('keeps both of two acceptances a person gives at once, so neither command asks again', async () => {
    const { registry } = await load(teamRepo({
      'tools/acme-claude.yaml': ACME_CLAUDE,
      'tools/acme-codex.yaml': ACME_CLAUDE.replaceAll('claude', 'codex').replace(/env: \w+/, 'env: ACME_CODEX_HOME'),
    }));
    const { acceptToolCommand } = await import('../tool-instances.js');
    const instances = ['acme-claude', 'acme-codex'].map((name) => registry.toolOf(name)?.instance).filter((instance) => instance !== undefined);

    await Promise.all(instances.map((instance) => acceptToolCommand(instance, { ask: async () => 'y' })));

    expect(instances).toHaveLength(2);
    expect(await Promise.all(instances.map((instance) => acceptToolCommand(instance, { ask: undefined })))).toEqual([{ ok: true }, { ok: true }]);
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
      expect.stringContaining('its name is "acme-claude", and an instance is named after its file or its folder, "acme"'),
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

  it('reads an instance in a namespace only for the member it is given, whose project or role selects it, as drivers and workflows are, until another member is given, under any spelling of the repo', async () => {
    const repo = teamRepo({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n  - id: billing\n    resources: { workflows: [mobile] }\n',
      'tools/web/web-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'web-claude'),
      'tools/mobile/mobile-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'mobile-claude'),
      'tools/acme-claude.yaml': ACME_CLAUDE,
    });
    memberOf(repo, { projects: ['checkout'] });
    const { loadLocalConfig } = await import('../config.js');
    // A loader that ran for another member before decides nothing.
    const checkout = await loadLocalConfig();
    if (checkout === null) throw new Error('no member config');
    const { registry, config } = await load(repo, { ...checkout, projects: ['billing'] });

    expect(registry.toolOf('mobile-claude')?.instance?.command).toBe('mobile-claude');
    expect(registry.toolOf('web-claude')).toBeUndefined();
    expect(config?.toolPaths['web-claude']).toBeUndefined();
    // A later load that reads only a field of teamai.yaml, given no member, leaves the member's instances in place.
    await load(repo);
    expect(registry.toolOf('mobile-claude')?.instance?.command).toBe('mobile-claude');
    // So does one through another spelling of the repo, which reads a root instance changed since as another repo's.
    const linked = path.join(root, 'linked-repo');
    fs.symlinkSync(repo, linked);
    fs.writeFileSync(path.join(repo, 'tools', 'acme-claude.yaml'), ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-2'));
    const { errors } = await load(linked);
    expect([registry.toolOf('mobile-claude')?.instance?.command, registry.toolOf('acme-claude')?.instance?.command, errors]).toEqual(['mobile-claude', 'acme-claude', []]);
  });

  it('reads only the root instances of a team repo whose manifest selects namespaces, when given no member', async () => {
    const { registry } = await load(teamRepo({
      'manifest/projects.yaml': 'version: 1\nprojects:\n  - id: checkout\n    resources: { workflows: [web] }\n',
      'tools/acme-claude.yaml': ACME_CLAUDE,
      'tools/web/web-claude.yaml': ACME_CLAUDE.replaceAll('acme-claude', 'web-claude'),
    }));

    expect(registry.toolOf('acme-claude')?.instance?.source).toBe('team');
    expect(registry.toolOf('web-claude')).toBeUndefined();
  });
});

describe('a linked tools folder', () => {
  it('reads no instance through a team repo\'s tools folder that is a link, and says why', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'acme-claude.yaml'), ACME_CLAUDE);
    const repo = teamRepo({});
    fs.symlinkSync(outside, path.join(repo, 'tools'));
    const { registry, errors } = await load(repo);

    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(errors).toEqual(['tools in the team repo is a link, and teamai reads the team\'s tool instances only from a folder the team repo holds, so it uses none of them. Replace the link with the folder, push it, and run teamai pull.']);
  });
});

describe('team instances of two scopes', () => {
  it('takes the workspace\'s team instance over the user scope\'s of the same name, as a driver definition is', async () => {
    const userRepo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const workspaceRepo = path.join(root, 'workspace-repo');
    fs.mkdirSync(path.join(workspaceRepo, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRepo, 'teamai.yaml'), 'team: acme\nrepo: acme/workspace\n');
    fs.writeFileSync(path.join(workspaceRepo, 'tools', 'acme-claude.yaml'), ACME_CLAUDE.replace('command: acme-claude', 'command: acme-claude-workspace'));
    memberOf(userRepo, {});
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), `repo:\n  localPath: ${workspaceRepo}\n  remote: https://example.test/acme/workspace.git\nusername: tester\nscope: workspace\n`);
    const { loadLocalConfig, readConfigFrom } = await import('../config.js');
    const user = await loadLocalConfig();
    const workspace = await readConfigFrom(path.join(project, '.teamai'), project);
    expect(workspace).toMatchObject({ scope: 'project' });
    const { registry, errors } = await load(workspaceRepo, workspace ?? undefined);
    await load(userRepo, user ?? undefined);

    expect(registry.toolOf('acme-claude')?.instance?.command).toBe('acme-claude-workspace');
    expect(errors).toEqual([]);
  });
});

describe('a tool instance kept as a folder', () => {
  it('reads tools/<name>/TOOL.yaml as the instance named after its folder, in the user scope\'s team repo and a workspace\'s', async () => {
    const userRepo = teamRepo({ 'tools/acme-claude/TOOL.yaml': ACME_CLAUDE });
    const workspaceRepo = path.join(root, 'workspace-repo');
    fs.mkdirSync(path.join(workspaceRepo, 'tools', 'ws-claude'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRepo, 'teamai.yaml'), 'team: acme\nrepo: acme/workspace\n');
    fs.writeFileSync(path.join(workspaceRepo, 'tools', 'ws-claude', 'TOOL.yaml'), ACME_CLAUDE.replaceAll('acme-claude', 'ws-claude'));
    const { registry, errors } = await load(userRepo);
    await load(workspaceRepo);

    expect(registry.toolOf('acme-claude')?.instance).toMatchObject({ command: 'acme-claude', source: 'team', location: 'tools/acme-claude/TOOL.yaml' });
    expect(registry.toolOf('ws-claude')?.instance).toMatchObject({ command: 'ws-claude', source: 'team' });
    expect(registry.toolOf('TOOL')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('runs an instance moved from tools/<name>.yaml into its folder with the acceptance its unchanged content had', async () => {
    const repo = teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE });
    const first = await load(repo);
    const { acceptToolCommand } = await import('../tool-instances.js');
    const instance = first.registry.toolOf('acme-claude')?.instance;
    expect(instance && await acceptToolCommand(instance, { ask: async () => 'y' })).toEqual({ ok: true });
    fs.mkdirSync(path.join(repo, 'tools', 'acme-claude'));
    fs.renameSync(path.join(repo, 'tools', 'acme-claude.yaml'), path.join(repo, 'tools', 'acme-claude', 'TOOL.yaml'));
    vi.resetModules();
    const moved = await load(repo);
    const { acceptToolCommand: acceptMoved } = await import('../tool-instances.js');
    const movedInstance = moved.registry.toolOf('acme-claude')?.instance;

    expect(movedInstance?.location).toBe('tools/acme-claude/TOOL.yaml');
    expect(movedInstance && await acceptMoved(movedInstance, { ask: undefined })).toEqual({ ok: true });
  });

  it('uses neither of one name kept as a file and a folder in one place, and names both', async () => {
    const { registry, errors } = await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE, 'tools/acme-claude/TOOL.yaml': ACME_CLAUDE }));

    expect(registry.toolOf('acme-claude')).toBeUndefined();
    expect(errors).toEqual([expect.stringContaining('"acme-claude" is defined twice in the team repo (tools/acme-claude.yaml and tools/acme-claude/)')]);
  });

  it('reads the member\'s own ~/.teamai/tools/<name>/TOOL.yaml', async () => {
    fs.mkdirSync(path.join(home, '.teamai', 'tools', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'tools', 'mine', 'TOOL.yaml'), 'schemaVersion: v1alpha1\nname: mine\nextends: codex\n');
    const { registry } = await load(teamRepo({}));

    expect(registry.toolOf('mine')?.instance).toMatchObject({ source: 'personal', extends: 'codex' });
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

  // The home of an instance with no home of its own is the one of the tool it extends, so the root recorded for that tool is its own.
  it('starts, delivers, gates and finds the sessions of an instance with paths and no home at the root recorded for the tool it extends', async () => {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex-work'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), 'repo: { localPath: /x, remote: x }\nusername: u\nscope: user\nadditionalRoles: []\ntoolRoots: { codex: ~/.codex-work }\n');
    const { config } = await load(teamRepo({
      'tools/review-codex.yaml': 'schemaVersion: v1alpha1\nname: review-codex\nextends: codex\npaths: { skills: .codex/review-skills }\n',
      'tools/shared-codex.yaml': 'schemaVersion: v1alpha1\nname: shared-codex\nextends: codex\npaths: { skills: .agents/team-skills, settings: .codex/hooks.json }\n',
    }));
    const { scopedToolPaths } = await import('../types.js');
    // The setup file mocks this module once, and a mock outlives vi.resetModules, binding it to the first test's registry.
    const { toolCommandEnv } = await vi.importActual<typeof import('../launch-registry.js')>('../launch-registry.js');
    const { installOf, locate, ownOf } = await import('../locate.js');
    const { AgentSession } = await import('../session-flow/agent-session.js');
    const { storeDirOf } = await import('../session-flow/adapters/index.js');
    const toolRoots = { codex: '~/.codex-work' };
    const skills = await locate('review-codex', 'skills', installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user', toolRoots }));
    const work = path.join(home, '.codex-work');

    expect({
      launch: toolCommandEnv('review-codex', { kind: 'delivered', inherited: {}, toolRoots }),
      sessions: storeDirOf(AgentSession.platformForTool('review-codex') ?? 'none', { kind: 'recorded', toolRoots }),
      skills: ownOf(skills)?.path,
      gate: skills.gates.find((gate) => gate.kind === 'installed'),
      // Only what lies in the home of Codex moves with its root; Codex reads the shared skills directory from any home.
      outside: scopedToolPaths(config ?? { toolPaths: {} }, { scope: 'user', toolRoots })['shared-codex'],
    }).toEqual({
      launch: { kind: 'ready', env: { CODEX_HOME: work } },
      sessions: path.join(work, 'sessions'),
      skills: path.join(work, 'review-skills'),
      gate: expect.objectContaining({ probe: work, met: true }),
      outside: { skills: '.agents/team-skills', settings: '.codex-work/hooks.json' },
    });
  });

  // The team moved the skills of Codex out of its default root, so an instance in its home moves them as Codex does.
  it('relocates an instance with no home to the recorded root of the tool it extends as that tool\'s paths the team set relocate', async () => {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex-work'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), 'repo: { localPath: /x, remote: x }\nusername: u\nscope: user\nadditionalRoles: []\nenabledAgents: [review-codex]\ntoolRoots: { codex: ~/.codex-work }\n');
    const repo = teamRepo({
      'tools/review-codex.yaml': 'schemaVersion: v1alpha1\nname: review-codex\nextends: codex\n',
      'tools/shared-codex.yaml': 'schemaVersion: v1alpha1\nname: shared-codex\nextends: codex\npaths: { skills: .codex-team/review-skills, settings: .codex/hooks.json, agents: .agents/review-agents }\n',
    });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: acme\nrepo: acme/team\ntoolPaths:\n  codex: { skills: .codex-team/skills }\n');
    const { config } = await load(repo);
    const { scopedToolPaths } = await import('../types.js');
    const { toolCommandEnv } = await vi.importActual<typeof import('../launch-registry.js')>('../launch-registry.js');
    const { installOf, locate, ownOf, unreadWrites } = await import('../locate.js');
    const toolRoots = { codex: '~/.codex-work' };
    const scoped = scopedToolPaths(config ?? { toolPaths: {} }, { scope: 'user', toolRoots });
    const skills = await locate('review-codex', 'skills', installOf(config ?? { toolPaths: {} }, { repo: {}, scope: 'user', toolRoots, enabledAgents: ['review-codex'] }));
    const work = path.join(home, '.codex-work');

    expect({
      launch: toolCommandEnv('review-codex', { kind: 'delivered', inherited: {}, toolRoots }),
      skills: ownOf(skills)?.path,
      unread: unreadWrites(skills, undefined, { kind: 'anywhere' }),
      relocated: { codex: scoped.codex, 'review-codex': scoped['review-codex'] },
      // Its own paths move under either root Codex's paths hang off, the team's or the default; one under neither stays.
      own: scoped['shared-codex'],
    }).toEqual({
      launch: { kind: 'ready', env: { CODEX_HOME: work } },
      skills: path.join(work, 'skills'),
      unread: [],
      relocated: { codex: { skills: '.codex-work/skills' }, 'review-codex': { skills: '.codex-work/skills' } },
      own: { skills: '.codex-work/review-skills', settings: '.codex-work/hooks.json', agents: '.agents/review-agents' },
    });
  });
});

describe('the home of an instance', () => {
  it('stays the instance\'s own directory when its variable is an XDG base directory, which the member set for every tool', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'config'));
    await load(teamRepo({ 'tools/claude-work.yaml': 'schemaVersion: v1alpha1\nname: claude-work\nextends: claude\nhome: { dir: .claude-work, env: XDG_CONFIG_HOME }\n' }));
    const { storeDirOf } = await import('../session-flow/adapters/index.js');

    expect(storeDirOf('claude-work', { kind: 'recorded', toolRoots: undefined })).toBe(path.join(home, '.claude-work', 'projects'));
  });

  it('follows the member\'s value of a variable of the instance\'s own', async () => {
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', path.join(root, 'acme'));
    await load(teamRepo({ 'tools/acme-claude.yaml': ACME_CLAUDE }));
    const { storeDirOf } = await import('../session-flow/adapters/index.js');

    expect(storeDirOf('acme-claude', { kind: 'recorded', toolRoots: undefined })).toBe(path.join(root, 'acme', 'projects'));
  });

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
    expect(storeDirOf('acme-claude', { kind: 'recorded', toolRoots: undefined })).toBe(path.join(moved, 'projects'));

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
    const repo = teamRepo({ 'tools/acme-claude.yaml': `${ACME_CLAUDE}paths: { skills: .claude/skills, rules: .claude/rules, userScope: { skills: .acme-claude/skills, rules: .acme-claude/rules } }\n` });
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
      const config = await loadTeamConfig(path.join(root, 'repo'), null);

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
