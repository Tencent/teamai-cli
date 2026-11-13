/**
 * `recall maintenance --update-quality` writes `<entry>.draft.md` beside a doc,
 * rule or skill in the team repo for a person to review. Until it is renamed it
 * is not team knowledge, so pull delivers none of it and recall never finds it.
 */
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
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({ held: true, value: await body() }),
}));
vi.mock('@teamai/shared/log', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis() })),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { LocalConfigSchema, StateSchema, TeamaiConfigSchema, type State } from '../types.js';

describe('pull and the drafts of --update-quality', () => {
  let tmp: string; let home: string; let repo: string; let saved: State;
  const team = (rel: string, content: string): Promise<void> => fse.outputFile(path.join(repo, rel), content);
  const delivered = (rel: string): Promise<boolean> => fse.pathExists(path.join(home, rel));
  const indexed = async (): Promise<string[]> => {
    const index = await fse.readJson(path.join(home, '.teamai', 'search-index.json')) as { entries: Array<{ filename: string }> };

    return index.entries.map((entry) => entry.filename).sort();
  };

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-drafts-'));
    home = path.join(tmp, 'home'); repo = path.join(home, '.teamai', 'team-repo');
    await team('docs/guide.md', '# Guide\n');
    await team('docs/guide.md.draft.md', '# Guide, updated\n');
    await team('rules/style.md', '# Style\n');
    await team('rules/style.md.draft.md', '# Style, updated\n');
    await team('skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploy the service.\n---\nDeploy.\n');
    await team('skills/deploy/SKILL.md.draft.md', '---\nname: deploy\ndescription: Deploy the service.\n---\nDeploy, updated.\n');
    await fse.ensureDir(path.join(home, '.claude'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    saved = StateSchema.parse({});
    vi.mocked(saveStateForScope).mockImplementation(async (state) => { saved = structuredClone(state); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved));
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => scope === 'user' ? LocalConfigSchema.parse({
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      scope: 'user', enabledAgents: ['claude'],
    }) : null);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(tmp); });

  it('delivers the doc, the rule and the skill, and no draft of them', async () => {
    await pull({});

    expect(await delivered('.teamai/docs/guide.md')).toBe(true);
    expect(await delivered('.claude/rules/style.md')).toBe(true);
    expect(await delivered('.claude/skills/deploy/SKILL.md')).toBe(true);
    expect(await delivered('.teamai/docs/guide.md.draft.md')).toBe(false);
    expect(await delivered('.claude/rules/style.md.draft.md')).toBe(false);
    expect(await delivered('.claude/skills/deploy/SKILL.md.draft.md')).toBe(false);
  });

  it('leaves every draft out of the search index', async () => {
    await pull({});

    expect((await indexed()).filter((file) => file.includes('draft'))).toEqual([]);
  });
});
