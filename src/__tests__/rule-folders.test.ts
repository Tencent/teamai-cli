import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { RulesHandler } from '../resources/rules.js';
import { RuleFolders } from '../resources/rule-folders.js';
import { log } from '../utils/logger.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

/** The rule folder the spec documents (#1787, slice 5). */
const RULE = '---\npaths: ["src/api/**"]\n---\nFollow the team API style. Before adding an endpoint, read\n'
  + '${TEAMAI_RULE_DIR}/checklist.md and ${TEAMAI_RULE_DIR}/examples/good-endpoint.ts.\n';
const CHECKLIST = '# Endpoint checklist\n\n- Name the resource in the plural.\n';

describe('rule folders (#1787)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const home = (...parts: string[]) => path.join(homeDir, ...parts);
  const forward = (file: string) => file.split(path.sep).join('/');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-folders-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.md'), RULE);
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'checklist.md'), CHECKLIST);
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'examples', 'good-endpoint.ts'), 'export {};\n');
    await fse.ensureDir(home('.claude'));
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    localConfig = LocalConfigSchema.parse({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      scope: 'user',
      enabledAgents: ['claude'],
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('delivers a user-scope rule folder to the data home and names it there in the rule', async () => {
    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    const dir = forward(home('.teamai', 'rules', 'api-style'));
    expect(await fse.readFile(home('.claude', 'rules', 'api-style.md'), 'utf8')).toBe(
      '---\npaths: ["src/api/**"]\n---\nFollow the team API style. Before adding an endpoint, read\n'
      + `${dir}/checklist.md and ${dir}/examples/good-endpoint.ts.\n`,
    );
    expect(await fse.readFile(home('.teamai', 'rules', 'api-style', 'checklist.md'), 'utf8')).toBe(CHECKLIST);
    expect(await fse.pathExists(home('.teamai', 'rules', 'api-style', 'examples', 'good-endpoint.ts'))).toBe(true);
    expect(await fse.pathExists(home('.claude', 'rules', 'api-style'))).toBe(false);
  });

  it('takes the body of the language variant under the frontmatter of RULE.md', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.zh.md'), '遵循团队 API 风格。\n');
    teamConfig = { ...teamConfig, language: 'zh' };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(home('.claude', 'rules', 'api-style.md'), 'utf8')).toBe('---\npaths: ["src/api/**"]\n---\n遵循团队 API 风格。\n');
  });

  it('ignores the frontmatter of a language variant, and says so', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.en.md'), '---\npaths: ["docs/**"]\n---\nFollow the API style.\n');
    teamConfig = { ...teamConfig, language: 'en' };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(home('.claude', 'rules', 'api-style.md'), 'utf8')).toBe('---\npaths: ["src/api/**"]\n---\nFollow the API style.\n');
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'The frontmatter of rules/api-style/RULE.en.md is ignored: every language of a rule folder takes the frontmatter of its RULE.md. '
      + 'Move those fields to rules/api-style/RULE.md in the team repo.',
    );
  });

  it('reads RULE.md with CRLF turned into LF, ending in one newline', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.md'), 'Use named exports.\r\nKeep it short.\r\n');

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(home('.claude', 'rules', 'api-style.md'), 'utf8')).toBe('Use named exports.\nKeep it short.\n');
  });

  it('names a namespaced rule folder by its path, flat for OMP', async () => {
    await fse.move(path.join(repoPath, 'rules', 'api-style'), path.join(repoPath, 'rules', 'fe', 'api-style'));
    await fse.ensureDir(home('.omp'));
    localConfig = { ...localConfig, enabledAgents: ['claude', 'omp'] };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    const dir = forward(home('.teamai', 'rules', 'fe', 'api-style'));
    expect(await fse.readFile(home('.claude', 'rules', 'fe', 'api-style.md'), 'utf8')).toContain(`read\n${dir}/checklist.md and`);
    expect(await fse.readFile(home('.omp', 'agent', 'rules', 'fe.api-style.md'), 'utf8')).toContain(`${dir}/checklist.md and`);
    expect(await fse.readFile(home('.teamai', 'rules', 'fe', 'api-style', 'checklist.md'), 'utf8')).toBe(CHECKLIST);
  });

  it('in a project, names the data home for Claude Code and a copy in the worktree for a tool that cannot read it', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const dataHome = home('.teamai', 'projects', 'project');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    localConfig = { ...localConfig, scope: 'project', projectRoot, dataHome, enabledAgents: ['claude', 'codebuddy'] };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(projectRoot, '.claude', 'rules', 'api-style.md'), 'utf8'))
      .toContain(`read\n${forward(path.join(dataHome, 'rules', 'api-style'))}/checklist.md and`);
    expect(await fse.readFile(path.join(projectRoot, '.codebuddy', 'rules', 'api-style.md'), 'utf8'))
      .toContain('read\n.teamai/delivered/rules/api-style/checklist.md and .teamai/delivered/rules/api-style/examples/good-endpoint.ts.');
    expect(await fse.readFile(path.join(projectRoot, '.teamai', 'delivered', 'rules', 'api-style', 'checklist.md'), 'utf8')).toBe(CHECKLIST);
    expect(await fse.readFile(path.join(dataHome, 'rules', 'api-style', 'checklist.md'), 'utf8')).toBe(CHECKLIST);
  });

  it.each([true, false])('keeps the worktree copy out of git with gitExclude %s', async (gitExcludeEnabled) => {
    const projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    execFileSync('git', ['init', '-q', projectRoot]);
    localConfig = { ...localConfig, scope: 'project', projectRoot, dataHome: home('.teamai', 'projects', 'project'), enabledAgents: ['codebuddy'], gitExcludeEnabled };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(execFileSync('git', ['-C', projectRoot, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).not.toContain('.teamai/');
    expect(await fse.pathExists(path.join(projectRoot, '.teamai', 'delivered', 'rules', 'api-style', 'checklist.md'))).toBe(true);
  });

  it('points a workspace rule and an inherited user-scope rule of the same name each at its own files, leaving ~/.teamai/rules alone', async () => {
    const workspaceRepo = path.join(tmpDir, 'workspace-repo');
    const projectRoot = path.join(tmpDir, 'project');
    const dataHome = home('.teamai', 'projects', 'project');
    await fse.outputFile(path.join(workspaceRepo, 'rules', 'api-style', 'RULE.md'), 'Read ${TEAMAI_RULE_DIR}/checklist.md.\n');
    await fse.outputFile(path.join(workspaceRepo, 'rules', 'api-style', 'checklist.md'), '- Singular names.\n');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    await new RulesHandler().pullAllRules(teamConfig, localConfig);
    const userFolder = await fse.readFile(home('.teamai', 'rules', 'api-style', 'checklist.md'), 'utf8');

    await new RulesHandler().pullAllRules(teamConfig, {
      ...localConfig, repo: { localPath: workspaceRepo, remote: 'https://example.invalid/x/workspace.git' }, scope: 'project', projectRoot, dataHome,
    });

    expect(await fse.readFile(home('.claude', 'rules', 'api-style.md'), 'utf8')).toContain(`${forward(home('.teamai', 'rules', 'api-style'))}/checklist.md`);
    expect(await fse.readFile(path.join(projectRoot, '.claude', 'rules', 'api-style.md'), 'utf8'))
      .toBe(`Read ${forward(path.join(dataHome, 'rules', 'api-style'))}/checklist.md.\n`);
    expect(await fse.readFile(path.join(dataHome, 'rules', 'api-style', 'checklist.md'), 'utf8')).toBe('- Singular names.\n');
    expect(userFolder).toBe(CHECKLIST);
    expect(await fse.readFile(home('.teamai', 'rules', 'api-style', 'checklist.md'), 'utf8')).toBe(CHECKLIST);
    expect(await fse.pathExists(path.join(projectRoot, '.teamai', 'rules'))).toBe(false);
  });

  it('in user scope, names the data home for every tool, and warns once for a tool that cannot read it', async () => {
    await fse.ensureDir(home('.codebuddy'));
    localConfig = { ...localConfig, enabledAgents: ['claude', 'codebuddy'] };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(home('.codebuddy', 'rules', 'api-style.md'), 'utf8'))
      .toContain(`read\n${forward(home('.teamai', 'rules', 'api-style'))}/checklist.md and`);
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).filter((message) => message.includes('user-scope rule folders'))).toEqual([
      `codebuddy may ask before it reads the files of user-scope rule folders in ${home('.teamai', 'rules')} (api-style): teamai grants it no access `
      + 'there, and a user-scope rule has no project to copy them into. Allow the directory in its settings, or share these rules from a project.',
    ]);
  });

  it('proposes no push of a rule folder\'s copy, edited or not', async () => {
    const handler = new RulesHandler();
    await handler.pullAllRules(teamConfig, localConfig);
    await fse.appendFile(home('.claude', 'rules', 'api-style.md'), 'An edit.\n');

    expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
  });

  it('inlines the rendered text for a tool without native rules', async () => {
    await fse.ensureDir(home('.codex'));
    localConfig = { ...localConfig, enabledAgents: ['codex'] };

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    const dir = forward(home('.teamai', 'rules', 'api-style'));
    expect(await fse.readFile(home('.codex', 'AGENTS.md'), 'utf8')).toContain(
      `Applies to files matching: src/api/**\nFollow the team API style. Before adding an endpoint, read\n${dir}/checklist.md and`,
    );
  });

  it('proposes no push of a member\'s rule that would land inside a rule folder, and says why', async () => {
    const handler = new RulesHandler();
    await handler.pullAllRules(teamConfig, localConfig);
    await fse.outputFile(home('.claude', 'rules', 'api-style', 'extra.md'), '# Extra\n');

    expect(await handler.scanLocalForPush(teamConfig, localConfig)).toEqual([]);
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      `${home('.claude', 'rules', 'api-style', 'extra.md')} is not pushed: rules/api-style/ is a rule folder, so rules/api-style/extra.md would be one of `
      + 'its files, not a rule. Rename your rule, or add the file to the folder in the team repo.',
    );
  });

  it('delivers neither of a rule file and a rule folder of the same name, and says so', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style.md'), 'Use named exports.\n');

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(home('.claude', 'rules', 'api-style.md'))).toBe(false);
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/api-style.md and rules/api-style/ both define the rule api-style, so neither is delivered. Remove one of them in the team repo.',
    );
  });

  it('skips a rule folder holding a symlink, with a pull warning, and delivers the other rules', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'style.md'), 'Use named exports.\n');
    await fse.symlink(path.join(repoPath, 'rules', 'style.md'), path.join(repoPath, 'rules', 'api-style', 'style-link.md'));

    await new RulesHandler().pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(home('.claude', 'rules', 'api-style.md'))).toBe(false);
    expect(await fse.pathExists(home('.teamai', 'rules', 'api-style'))).toBe(false);
    expect(await fse.readFile(home('.claude', 'rules', 'style.md'), 'utf8')).toBe('Use named exports.\n');
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      'rules/api-style/ is not delivered: style-link.md is a symlink. A rule folder holds only files teamai can read, never links; fix it in the team repo.',
    );
  });
});

describe('the Claude Code grant of the data home (#1787)', () => {
  let tmpDir: string;
  let settingsFile: string;
  let dir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-grant-'));
    settingsFile = path.join(tmpDir, '.claude', 'settings.json');
    dir = path.join(tmpDir, '.teamai', 'rules');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('appends the directory once, after the member\'s own entries, and keeps the rest of the file', async () => {
    await fse.outputJson(settingsFile, { model: 'opus', permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/b', '/a'] } });

    const owned = await RuleFolders.grant({ settingsFile, dirs: [dir], previous: [] });
    const again = await RuleFolders.grant({ settingsFile, dirs: [dir], previous: owned });

    expect([owned, again]).toEqual([[dir], [dir]]);
    expect(await fse.readJson(settingsFile)).toEqual({ model: 'opus', permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/b', '/a', dir] } });
  });

  it('takes back only the entry it added, on withdraw', async () => {
    await fse.outputJson(settingsFile, { permissions: { additionalDirectories: ['/b'] } });
    const owned = await RuleFolders.grant({ settingsFile, dirs: [dir], previous: [] });

    expect(await RuleFolders.grant({ settingsFile, dirs: [dir], previous: owned, withdraw: true })).toEqual([]);
    expect(await fse.readJson(settingsFile)).toEqual({ permissions: { additionalDirectories: ['/b'] } });
  });

  it('leaves the entry to the member who already had it', async () => {
    await fse.outputJson(settingsFile, { permissions: { additionalDirectories: [dir] } });
    const owned = await RuleFolders.grant({ settingsFile, dirs: [dir], previous: [] });

    await RuleFolders.grant({ settingsFile, dirs: [dir], previous: owned, withdraw: true });

    expect(owned).toEqual([]);
    expect(await fse.readJson(settingsFile)).toEqual({ permissions: { additionalDirectories: [dir] } });
  });
});

describe('TEAMAI_RULE_DIR (#1787)', () => {
  it('is a reserved team env name, so no team variable shadows it', async () => {
    const { reservedTeamEnvWarning } = await import('../env-reserved.js');

    expect(reservedTeamEnvWarning(['TEAMAI_RULE_DIR', 'API_URL'])).toBe('TEAMAI_RULE_DIR is reserved for the folder path teamai gives a workflow step, hook, rule or MCP server; those team env values are ignored.');
  });
});
