import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({}),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import { isInstalled } from './helpers/install-gate.js';
import { rulesReceivingTools } from '../resources/rules.js';
import { DEFAULT_TOOL_PATHS, scopedToolPaths } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * WorkBuddy 5.7+ moved its runtime to `~/.workbuddy-ai/` (settings.json,
 * plugins/, skills/ …) and stopped reading `~/.workbuddy/` — the old root is a
 * leftover (#1273). The install probe must recognize both generations, or a
 * 5.7+ member looks uninstalled and teamai integrates nothing.
 */
describe('WorkBuddy install probe across generations (#1273)', () => {
  let root: string;
  let home: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-workbuddy-detect-'));
    home = path.join(root, 'home');
    projectRoot = path.join(root, 'project');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    await fse.ensureDir(projectRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const projectConfig = (): LocalConfig => ({
    repo: { localPath: path.join(root, 'repo'), remote: 'fixture' },
    username: 'tester', scope: 'project', projectRoot, additionalRoles: [],
  });

  it('finds old-generation WorkBuddy by .workbuddy at the base dir', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    expect(await isInstalled('workbuddy', 'rules', projectConfig())).toBe(true);
  });

  it('does not treat .workbuddy-ai alone as installed outside the skills surface (#1290)', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(await isInstalled('workbuddy', 'rules', projectConfig())).toBe(false);
  });

  it('takes the old root as proof when both generations left directories behind', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(await isInstalled('workbuddy', 'rules', projectConfig())).toBe(true);
  });

  it('does not take a bare .codebuddy directory for WorkBuddy', async () => {
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    expect(await isInstalled('workbuddy', 'rules', projectConfig())).toBe(false);
  });
});

/**
 * The skills write side (#1273): on an install that left only the 5.7+
 * `.workbuddy-ai/` root, skills must land where the app actually scans —
 * live-verified in the issue (13 team skills showed in the `/` menu). Only
 * the default `.workbuddy/skills` swaps: a team that redirected skills on
 * purpose keeps its own path.
 */
describe('scopedToolPaths swaps WorkBuddy skills to the 5.7+ root (#1273)', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wb-paths-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const defaultTeam = { toolPaths: { workbuddy: { skills: '.workbuddy/skills' } } };
  const paths = (team: unknown, scope: 'user' | 'project' = 'user', projectRoot?: string) =>
    scopedToolPaths(team as never, { scope, ...(projectRoot ? { projectRoot } : {}) });

  it('delivers to .workbuddy-ai/skills when only the 5.7+ root exists', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('prefers the new root when an upgrade left both roots behind', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy'));
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('keeps the old path when neither root exists (nothing detected)', () => {
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy/skills');
  });

  it('never stomps a team that redirected skills on purpose', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const redirected = { toolPaths: { workbuddy: { skills: '.workbuddy-ai/skills' } } };
    expect(paths(redirected).workbuddy.skills).toBe('.workbuddy-ai/skills');
    const elsewhere = { toolPaths: { workbuddy: { skills: 'custom/skills' } } };
    expect(paths(elsewhere).workbuddy.skills).toBe('custom/skills');
  });

  it('keeps the swap after the user-scope override merges the default path', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const scoped = {
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills', userScope: { skills: '.workbuddy/skills' } },
      },
    };
    expect(paths(scoped).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('never stomps a userScope skills redirect of its own', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const scoped = {
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills', userScope: { skills: 'custom/skills' } },
      },
    };
    expect(paths(scoped).workbuddy.skills).toBe('custom/skills');
  });

  it('swaps against the project root in project scope', async () => {
    const projectRoot = path.join(root, 'project');
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(paths(defaultTeam, 'project', projectRoot).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });
});

/**
 * Doctor on a member whose only WorkBuddy root is `.workbuddy-ai/` (#1273):
 * skills arrive there, while rules, instructions, agents, MCP servers and
 * hooks wait for `.workbuddy/`, so pull writes none of them. Doctor must say
 * so instead of passing.
 */
describe('doctor on a WorkBuddy member with only the 5.7+ root', () => {
  let root: string;
  let home: string;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wb-doctor-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const localConfig: LocalConfig = {
      repo: { localPath: path.join(root, 'repo'), remote: 'owner/repo' },
      username: 'tester', scope: 'user', additionalRoles: [], enabledAgents: ['workbuddy'],
    };
    teamConfig = {
      team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: { workbuddy: DEFAULT_TOOL_PATHS.workbuddy },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  it('fails a check naming the surfaces pull holds and the root they wait for', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const all = await checks();

    const installed = all.find((c) => c.name === 'workbuddy is installed');
    expect(await installed?.check()).toBe(true);
    const held = all.filter((c) => c.name.startsWith('workbuddy receives'));
    expect(held).toHaveLength(1);
    expect(await held[0].check()).toBe(false);
    for (const surface of ['rules', 'agents', 'MCP servers', 'hooks']) expect(held[0].name).toContain(surface);
    expect(held[0].fix).toContain(path.join(home, '.workbuddy-ai', 'skills'));
    expect(held[0].fix).toContain(`${path.join(home, '.workbuddy')} exists`);
  });

  it('names hooks when the team maps WorkBuddy to skills and settings only', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    vi.mocked(loadTeamConfig).mockResolvedValue({
      ...teamConfig, toolPaths: { workbuddy: { skills: '.workbuddy/skills', settings: '.workbuddy/settings.json' } },
    });
    const held = (await checks()).filter((c) => c.name.startsWith('workbuddy receives'));

    expect(held.map((c) => c.name)).toEqual(['workbuddy receives hooks']);
    expect(await held[0].check()).toBe(false);
    expect(held[0].fix).toContain(`${path.join(home, '.workbuddy')} exists`);
  });

  it('has nothing to report while the old root is there', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy'));
    expect((await checks()).map((c) => c.name).filter((name) => name.startsWith('workbuddy receives'))).toEqual([]);
  });
});

/**
 * Pull reports rules as synced only when some tool takes them (#1273): none
 * on a member whose only WorkBuddy root is `.workbuddy-ai/`, while a
 * single-file target such as Codex's `AGENTS.md` counts like a rules
 * directory, and a session hook or extension counts like a file.
 */
describe('rulesReceivingTools', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wb-rules-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const localConfig = (): LocalConfig => ({
    repo: { localPath: path.join(root, 'repo'), remote: 'owner/repo' },
    username: 'tester', scope: 'user', additionalRoles: [],
  });
  const teamConfig = (toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig => ({
    team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
    toolPaths,
  });

  it('finds no rules target on a member whose only WorkBuddy root is .workbuddy-ai', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    expect(await rulesReceivingTools(teamConfig({ workbuddy: DEFAULT_TOOL_PATHS.workbuddy }), localConfig())).toEqual([]);
  });

  it.each(['codex', 'pi'] as const)('counts %s, whose session hook or extension adds the rules in a workspace', async (tool) => {
    const projectRoot = path.join(root, 'project');
    await fse.ensureDir(path.join(home, `.${tool}`));
    await fse.ensureDir(path.join(projectRoot, `.${tool}`));
    const workspace: LocalConfig = { ...localConfig(), scope: 'project', projectRoot, enabledAgents: [tool] };
    expect(await rulesReceivingTools(teamConfig({ [tool]: DEFAULT_TOOL_PATHS[tool] }), workspace)).toEqual([tool]);
  });

  it('counts a tool whose rules land in a single file', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    await fse.ensureDir(path.join(home, '.codex'));
    const toolPaths = { workbuddy: DEFAULT_TOOL_PATHS.workbuddy, codex: DEFAULT_TOOL_PATHS.codex };
    expect(await rulesReceivingTools(teamConfig(toolPaths), localConfig())).toEqual(['codex']);
  });
});
