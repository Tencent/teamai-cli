import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
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
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
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
import { log } from '../utils/logger.js';
import { detectProjectConfig, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * WorkBuddy's project rules move from `.workbuddy/rules`, which it never read,
 * to CodeBuddy's `.codebuddy/rules` (#946). The new path has no delivery
 * record, so a pull at an unchanged team revision must still write it.
 */
describe('a pull at an unchanged team revision after WorkBuddy\'s project rules move (#946)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let saved: State;

  const SCOPED = '---\npaths: ["src/**"]\n---\n\nUse named exports.\n';
  const RENDER = '---\nalwaysApply: false\npaths:\n  - "src/**"\n---\n\nUse named exports.\n';
  const oldCopy = () => path.join(projectRoot, '.workbuddy', 'rules', 'scoped.md');
  const newCopy = () => path.join(projectRoot, '.codebuddy', 'rules', 'scoped.md');
  const record = () => Object.values(saved.lastPullByWorkspace ?? {})[0];

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-workbuddy-move-'));
    const homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(detectProjectConfig).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
      enabledAgents: ['workbuddy'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: the verbatim copy in
    // .workbuddy/rules, on record, and nothing in .codebuddy/rules.
    await fse.remove(newCopy());
    await fse.outputFile(oldCopy(), SCOPED);
    const { [newCopy()]: _dropped, ...rest } = record().delivered ?? {};
    record().delivered = { ...rest, [oldCopy()]: sha256(SCOPED) };
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('writes the rule to .codebuddy/rules, records it, and reclaims the .workbuddy/rules copy', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(newCopy(), 'utf8')).toBe(RENDER);
    expect(record().delivered?.[newCopy()]).toBe(sha256(RENDER));
    expect(await fse.pathExists(oldCopy())).toBe(false);
    expect(record().delivered?.[oldCopy()]).toBeUndefined();
    expect(await fse.pathExists(path.dirname(oldCopy()))).toBe(false);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('also writes .codebuddy/rules for a .workbuddy/rules copy the member edited, which it keeps and names', async () => {
    const edited = SCOPED.replace('named', 'my own');
    await fse.writeFile(oldCopy(), edited);

    await pull({});

    expect(await fse.readFile(newCopy(), 'utf8')).toBe(RENDER);
    expect(record().delivered?.[newCopy()]).toBe(sha256(RENDER));
    expect(await fse.readFile(oldCopy(), 'utf8')).toBe(edited);
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${oldCopy()}`))).toHaveLength(1);
  });
});
