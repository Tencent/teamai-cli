import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', async (importOriginal) => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  // A pull records a tool's moved home under this lock.
  withFileLock: (await importOriginal<typeof import('../update.js')>()).withFileLock,
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { pull } from '../pull.js';
import { uninstall } from '../uninstall.js';
import { AgentsHandler } from '../resources/agents.js';
import { autoDetectInit, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';

/** A rule folder whose rule names its support file (#1787). */
const RULE = 'Before adding an endpoint, read ${TEAMAI_RULE_DIR}/checklist.md.\n';

describe('the Claude Code grant of the rule folders a pull delivers (#1787)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let saved: State;

  const settingsFile = () => path.join(homeDir, '.claude', 'settings.json');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-grant-pull-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputJson(path.join(homeDir, '.claude', 'settings.json'), { permissions: { additionalDirectories: ['/member/dir'] } });
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.md'), RULE);
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'checklist.md'), '- Plural names.\n');
    vi.stubEnv('HOME', homeDir);
    resetWarnOnce();
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['claude'],
    } as LocalConfig);
  });

  afterEach(async () => {
    const { resetToolInstancesForTests } = await import('../tool-instances.js');
    resetToolInstancesForTests();
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('adds the data home once, after the member\'s entries, and keeps it on the next pull', async () => {
    await pull({});
    await pull({ force: true });

    expect(await fse.readJson(settingsFile())).toMatchObject({
      permissions: { additionalDirectories: ['/member/dir', path.join(homeDir, '.teamai', 'rules')] },
    });
  });

  it('takes it back once the team has no rule folder left', async () => {
    await pull({});
    await fse.remove(path.join(repoPath, 'rules', 'api-style'));
    await fse.outputFile(path.join(repoPath, 'rules', 'style.md'), 'Use named exports.\n');

    await pull({ force: true });

    expect(await fse.readJson(settingsFile())).toMatchObject({ permissions: { additionalDirectories: ['/member/dir'] } });
  });

  it('grants Claude Code the folders in the settings of the root its variable moved, and uninstall takes them back there', async () => {
    const root = path.join(homeDir, '.claude-work');
    await fse.outputJson(path.join(root, 'settings.json'), { permissions: { additionalDirectories: ['/member/dir'] } });
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' }, username: 'u', updatePolicy: 'auto', additionalRoles: [], scope: 'user',
      enabledAgents: ['claude'], toolRoots: { claude: '~/.claude-work' },
    } as LocalConfig);

    await pull({});
    const granted = (await fse.readJson(path.join(root, 'settings.json'))).permissions.additionalDirectories;
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: await loadLocalConfigForScope('user'), teamConfig: await loadTeamConfig(repoPath) } as never);
    await uninstall({ agent: 'claude', force: true });

    expect(granted).toEqual(['/member/dir', path.join(homeDir, '.teamai', 'rules')]);
    expect(await fse.readJson(path.join(root, 'settings.json'))).toMatchObject({ permissions: { additionalDirectories: ['/member/dir'] } });
    expect(await fse.readJson(settingsFile())).toEqual({ permissions: { additionalDirectories: ['/member/dir'] } });
  });

  it('grants a Claude Code instance the folders in the settings of its own home, where its variable moves it, and its own uninstall takes them back there only', async () => {
    const moved = path.join(tmpDir, 'acme');
    vi.stubEnv('ACME_CLAUDE_CONFIG_DIR', moved);
    await fse.outputJson(path.join(moved, 'settings.json'), { permissions: { additionalDirectories: ['/member/dir'] } });
    await fse.outputFile(path.join(repoPath, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\nhome: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }\n');
    const { withToolInstances } = await import('../tool-instances.js');
    vi.mocked(loadTeamConfig).mockImplementation(async () => withToolInstances(repoPath, TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' })));
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' }, username: 'u', updatePolicy: 'auto', additionalRoles: [], scope: 'user', enabledAgents: ['claude', 'acme-claude'],
    } as LocalConfig);

    await pull({});
    const granted = (await fse.readJson(path.join(moved, 'settings.json'))).permissions.additionalDirectories;
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: await loadLocalConfigForScope('user'), teamConfig: await loadTeamConfig(repoPath) } as never);
    await uninstall({ agent: 'acme-claude', force: true });

    expect(granted).toEqual(['/member/dir', path.join(homeDir, '.teamai', 'rules')]);
    expect(await fse.readJson(path.join(moved, 'settings.json'))).toMatchObject({ permissions: { additionalDirectories: ['/member/dir'] } });
    expect(await fse.readJson(settingsFile())).toMatchObject({ permissions: { additionalDirectories: ['/member/dir', path.join(homeDir, '.teamai', 'rules')] } });
  });

  it('keeps the grant in the settings a Claude Code instance shares with Claude Code when only the instance is uninstalled', async () => {
    await fse.outputFile(path.join(repoPath, 'tools', 'acme-claude.yaml'), 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\ncommand: acme-claude\n');
    const { withToolInstances } = await import('../tool-instances.js');
    vi.mocked(loadTeamConfig).mockImplementation(async () => withToolInstances(repoPath, TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' })));
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' }, username: 'u', updatePolicy: 'auto', additionalRoles: [], scope: 'user', enabledAgents: ['claude', 'acme-claude'],
    } as LocalConfig);

    await pull({});
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: await loadLocalConfigForScope('user'), teamConfig: await loadTeamConfig(repoPath) } as never);
    await uninstall({ agent: 'acme-claude', force: true });

    expect(await fse.readJson(settingsFile())).toMatchObject({ permissions: { additionalDirectories: ['/member/dir', path.join(homeDir, '.teamai', 'rules')] } });
  });

  describe('with an agent folder', () => {
    const agentFolder = () => path.join(homeDir, '.teamai', 'agents', 'reviewer');
    const agentCopy = () => path.join(homeDir, '.claude', 'agents', 'reviewer.md');

    /** What `teamai remove agents reviewer` leaves in the team repo. */
    const removeAgent = async (): Promise<void> => {
      await fse.remove(path.join(repoPath, 'agents', 'reviewer'));
      await fse.outputFile(path.join(repoPath, 'agents', '.removed'), 'reviewer\n');
    };

    beforeEach(async () => {
      await fse.outputFile(path.join(repoPath, 'agents', 'reviewer', 'AGENT.md'), '---\nname: reviewer\ndescription: Reviews.\n---\nApply ${TEAMAI_AGENT_DIR}/rubric.md.\n');
      await fse.outputFile(path.join(repoPath, 'agents', 'reviewer', 'rubric.md'), '- Name what breaks.\n');
    });

    it('adds the agents directory after the rules one, and takes it back with the folder once the team drops the agent', async () => {
      await pull({});
      const granted = (await fse.readJson(settingsFile())).permissions.additionalDirectories;
      const delivered = await fse.pathExists(path.join(agentFolder(), 'rubric.md'));
      await removeAgent();

      await pull({ force: true });

      expect([granted, delivered]).toEqual([['/member/dir', path.join(homeDir, '.teamai', 'rules'), path.join(homeDir, '.teamai', 'agents')], true]);
      expect([await fse.pathExists(agentCopy()), await fse.pathExists(agentFolder())]).toEqual([false, false]);
      expect(await fse.readJson(settingsFile())).toMatchObject({ permissions: { additionalDirectories: ['/member/dir', path.join(homeDir, '.teamai', 'rules')] } });
    });

    it('is removed by teamai remove agents, from the team repo, the tools and the data home', async () => {
      await pull({});
      const localConfig = await loadLocalConfigForScope('user');

      await new AgentsHandler().removeItem('reviewer', TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }), localConfig as LocalConfig);

      expect([
        await fse.pathExists(path.join(repoPath, 'agents', 'reviewer')),
        await fse.pathExists(agentCopy()),
        await fse.pathExists(agentFolder()),
      ]).toEqual([false, false, false]);
    });

    it('removes the copies of a namespace\'s agents once it holds AGENT.md, keeps an edited one, and says why once', async () => {
      const copy = (name: string): string => path.join(homeDir, '.claude', 'agents', `${name}.md`);
      await fse.outputFile(path.join(repoPath, 'agents', 'payments', 'vr.md'), 'Review screenshots.\n');
      await fse.outputFile(path.join(repoPath, 'agents', 'payments', 'tf.md'), 'Review plans.\n');
      await pull({});
      await fse.appendFile(copy('tf'), 'My own note.\n');
      await fse.outputFile(path.join(repoPath, 'agents', 'payments', 'AGENT.md'), 'Pay with ${TEAMAI_AGENT_DIR}/vr.md.\n');
      vi.mocked(log.warn).mockClear();

      await pull({ force: true });
      await pull({ force: true });

      expect([await fse.pathExists(copy('vr')), await fse.pathExists(copy('tf')), await fse.pathExists(copy('payments'))]).toEqual([false, true, true]);
      expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).filter((message) => message.includes('agents/payments/'))).toEqual([
        'agents/payments/ holds AGENT.md, so it is one folder, and tf.md, vr.md in it are its files, no longer read on their own.',
      ]);
    });

    it('keeps the folder of an agent the team removed while the member keeps an edited copy, and removes it with the copy', async () => {
      await pull({});
      await fse.appendFile(agentCopy(), 'My own note.\n');
      await removeAgent();

      await pull({ force: true });
      const kept = await fse.pathExists(path.join(agentFolder(), 'rubric.md'));
      await fse.remove(agentCopy());
      await pull({ force: true });

      expect([kept, await fse.pathExists(agentFolder())]).toEqual([true, false]);
      expect(await fse.readJson(settingsFile())).toMatchObject({ permissions: { additionalDirectories: ['/member/dir', path.join(homeDir, '.teamai', 'rules')] } });
    });
  });
});
