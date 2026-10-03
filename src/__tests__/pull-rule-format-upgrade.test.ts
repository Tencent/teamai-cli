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

// Pass-through, so a test can count how often a pull resolves the rules:
// each resolve filters the team rules by tag once.
vi.mock('../utils/tags.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/tags.js')>();
  return { ...original, filterByTags: vi.fn(original.filterByTags) };
});

import { pull } from '../pull.js';
import { filterByTags } from '../utils/tags.js';
import { log } from '../utils/logger.js';
import { loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A CLI upgrade that gives a tool its own rules format must reach a machine
 * whose team revision has not moved, or its rules stay verbatim until the
 * team next changes (#946).
 */
describe('a pull at an unchanged team revision after the rule formats change (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;

  const SCOPED = '---\npaths:\n  - "src/**"\n---\n\nUse named exports.\n';
  const KIRO = '---\ninclusion: fileMatch\nfileMatchPattern: ["src/**"]\n---\n\nUse named exports.\n';
  const kiroCopy = () => path.join(homeDir, '.kiro', 'steering', 'scoped.md');
  const qoderCopy = () => path.join(homeDir, '.qoder', 'rules', 'scoped.md');
  const delivered = () => Object.values(saved.lastPullByWorkspace ?? {})[0]?.delivered ?? {};

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-format-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.kiro'));
    await fse.ensureDir(path.join(homeDir, '.qoder'));
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
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['kiro', 'qoder'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: the team rule verbatim, on
    // record as delivered; the member then edited the Qoder copy.
    for (const copy of [kiroCopy(), qoderCopy()]) await fse.writeFile(copy, SCOPED);
    const record = Object.values(saved.lastPullByWorkspace ?? {})[0];
    record.delivered = { ...record.delivered, [kiroCopy()]: sha256(SCOPED), [qoderCopy()]: sha256(SCOPED) };
    await fse.writeFile(qoderCopy(), 'My own wording.\n');
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('re-renders the unedited copy, records it, and leaves the edited one', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(kiroCopy(), 'utf8')).toBe(KIRO);
    expect(await fse.readFile(qoderCopy(), 'utf8')).toBe('My own wording.\n');
    expect(delivered()[kiroCopy()]).toBe(sha256(KIRO));
    expect(delivered()[qoderCopy()]).toBe(sha256(SCOPED));
    expect(successes).toContain('[user] Rewrote 1 rule(s) in their tool\'s own format: scoped');
    // Kept and named, as a full sync names it (#822).
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${qoderCopy()}`))).toHaveLength(1);
  });
});

/**
 * OMP reads only the top of its rules directory, so a namespaced rule moved
 * from `fe/style.md` to `fe.style.md`. The new path has no record, so the
 * re-render above cannot reach it; the old copy is what moves it.
 */
describe('a pull at an unchanged team revision after OMP rules go flat (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;

  const NS = 'Namespaced rule.\n';
  const OMP_NS = '---\nalwaysApply: true\n---\n\nNamespaced rule.\n';
  const rulesDir = () => path.join(homeDir, '.omp', 'agent', 'rules');
  const record = () => Object.values(saved.lastPullByWorkspace ?? {})[0];

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-flat-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(rulesDir());
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), NS);
    await fse.outputFile(path.join(repoPath, 'rules', 'be', 'api.md'), 'Backend rule.\n');
    vi.stubEnv('HOME', homeDir);
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
      enabledAgents: ['omp'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: each rule verbatim and nested,
    // on record; the member then edited the backend copy.
    const delivered: Record<string, string> = {};
    for (const name of ['fe.style.md', 'be.api.md']) await fse.remove(path.join(rulesDir(), name));
    for (const [rel, text] of [['fe/style.md', NS], ['be/api.md', 'Backend rule.\n']]) {
      await fse.outputFile(path.join(rulesDir(), rel), text);
      delivered[path.join(rulesDir(), rel)] = sha256(text);
    }
    record().delivered = delivered;
    await fse.writeFile(path.join(rulesDir(), 'be', 'api.md'), 'My own backend wording.\n');
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('writes the flat copy OMP reads, and reclaims the nested one unless the member edited it', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    const flat = path.join(rulesDir(), 'fe.style.md');
    expect(await fse.readFile(flat, 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(rulesDir(), 'fe'))).toBe(false);
    // The member's edit stays where it is; the flat copy still gets the team rule.
    expect(await fse.readFile(path.join(rulesDir(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'be.api.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nBackend rule.\n');
    expect(record().delivered?.[flat]).toBe(sha256(OMP_NS));
    expect(record().delivered?.[path.join(rulesDir(), 'fe', 'style.md')]).toBeUndefined();
    // The edited nested copy is named: OMP does not read it.
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${path.join(rulesDir(), 'be', 'api.md')}`))).toHaveLength(1);
  });

  it('does the same on a machine an older CLI left with no delivery record', async () => {
    delete record().delivered;
    // A root rule's verbatim copy too: the team rule's own bytes, so unedited.
    await fse.outputFile(path.join(tmpDir, 'team-repo', 'rules', 'root.md'), 'Root rule.\n');
    await fse.outputFile(path.join(rulesDir(), 'root.md'), 'Root rule.\n');
    await fse.outputFile(path.join(rulesDir(), 'mine.md'), 'Not a team rule.\n');

    await pull({});

    expect(await fse.readFile(path.join(rulesDir(), 'root.md'), 'utf8')).toBe('---\nalwaysApply: true\n---\n\nRoot rule.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'mine.md'), 'utf8')).toBe('Not a team rule.\n');
    expect(await fse.readFile(path.join(rulesDir(), 'fe.style.md'), 'utf8')).toBe(OMP_NS);
    expect(await fse.pathExists(path.join(rulesDir(), 'fe'))).toBe(false);
    expect(await fse.readFile(path.join(rulesDir(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
  });
});

/**
 * Kiro reads only the top of its steering directory (kirodotdev/Kiro#10448),
 * so a namespaced rule moved from `fe/style.md` to `fe.style.md`, as OMP's did.
 */
describe('a pull at an unchanged team revision after Kiro steering goes flat (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;

  const NS = 'Namespaced rule.\n';
  const KIRO_NS = '---\ninclusion: always\n---\n\nNamespaced rule.\n';
  const steering = () => path.join(homeDir, '.kiro', 'steering');
  const record = () => Object.values(saved.lastPullByWorkspace ?? {})[0];

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-flat-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(steering());
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), NS);
    await fse.outputFile(path.join(repoPath, 'rules', 'be', 'api.md'), 'Backend rule.\n');
    vi.stubEnv('HOME', homeDir);
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
      enabledAgents: ['kiro'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: each rule verbatim and nested,
    // on record; the member then edited the backend copy.
    const delivered: Record<string, string> = {};
    for (const name of ['fe.style.md', 'be.api.md']) await fse.remove(path.join(steering(), name));
    for (const [rel, text] of [['fe/style.md', NS], ['be/api.md', 'Backend rule.\n']]) {
      await fse.outputFile(path.join(steering(), rel), text);
      delivered[path.join(steering(), rel)] = sha256(text);
    }
    record().delivered = delivered;
    await fse.writeFile(path.join(steering(), 'be', 'api.md'), 'My own backend wording.\n');
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('writes the flat file Kiro reads, and reclaims the nested one unless the member edited it', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    const flat = path.join(steering(), 'fe.style.md');
    expect(await fse.readFile(flat, 'utf8')).toBe(KIRO_NS);
    expect(await fse.pathExists(path.join(steering(), 'fe'))).toBe(false);
    expect(await fse.readFile(path.join(steering(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
    expect(await fse.readFile(path.join(steering(), 'be.api.md'), 'utf8')).toBe('---\ninclusion: always\n---\n\nBackend rule.\n');
    expect(record().delivered?.[flat]).toBe(sha256(KIRO_NS));
    expect(record().delivered?.[path.join(steering(), 'fe', 'style.md')]).toBeUndefined();
    // The edited nested copy is named: Kiro does not read it.
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${path.join(steering(), 'be', 'api.md')}`))).toHaveLength(1);
  });

  it('does the same on a machine an older CLI left with no delivery record', async () => {
    delete record().delivered;

    await pull({});

    expect(await fse.readFile(path.join(steering(), 'fe.style.md'), 'utf8')).toBe(KIRO_NS);
    expect(await fse.pathExists(path.join(steering(), 'fe'))).toBe(false);
    expect(await fse.readFile(path.join(steering(), 'be', 'api.md'), 'utf8')).toBe('My own backend wording.\n');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${path.join(steering(), 'be', 'api.md')}`))).toHaveLength(1);
  });
});

/**
 * JoyCode got Cursor's `.mdc`, whose quoted globs it never matches; a project
 * whose team revision has not moved must still get JoyCode's own render (#946).
 */
describe('a pull at an unchanged team revision after JoyCode gets its own render (#946)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let saved: State;

  const SCOPED = '---\npaths:\n  - "src/**"\n  - "test/**"\n---\n\nUse named exports.\n';
  const CURSOR = '---\nglobs: "src/**, test/**"\nalwaysApply: false\n---\n\nUse named exports.\n';
  const JOYCODE = '---\nglobs: src/**, test/**\nalwaysApply: false\n---\n\nUse named exports.\n';
  const copy = (name: string) => path.join(projectRoot, '.joycode', 'rules', `${name}.mdc`);
  const delivered = () => Object.values(saved.lastPullByWorkspace ?? {})[0]?.delivered ?? {};

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-joycode-upgrade-'));
    projectRoot = path.join(tmpDir, 'project');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(projectRoot, '.joycode'));
    for (const name of ['scoped', 'edited']) await fse.outputFile(path.join(repoPath, 'rules', `${name}.md`), SCOPED);
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
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
      scope: 'project',
      projectRoot,
      enabledAgents: ['joycode'],
    } as LocalConfig);
    await pull({});
    // What an older CLI left at this revision: Cursor's render, on record as
    // delivered; the member then edited one copy.
    const record = Object.values(saved.lastPullByWorkspace ?? {})[0];
    for (const name of ['scoped', 'edited']) {
      await fse.writeFile(copy(name), CURSOR);
      record.delivered = { ...record.delivered, [copy(name)]: sha256(CURSOR) };
    }
    await fse.writeFile(copy('edited'), CURSOR.replace('Use named exports.', 'My own wording.'));
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('re-renders the unedited copy for JoyCode, and keeps and names the edited one', async () => {
    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(copy('scoped'), 'utf8')).toBe(JOYCODE);
    expect(delivered()[copy('scoped')]).toBe(sha256(JOYCODE));
    expect(await fse.readFile(copy('edited'), 'utf8')).toContain('My own wording.');
    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes(`Kept ${copy('edited')}`))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes(copy('edited')) && message.includes('JoyCode never matches'))).toHaveLength(1);
    expect(warnings.some((message) => message.includes(copy('scoped')))).toBe(false);
  });

  it('says why the kept copy applies to no file on a full sync too', async () => {
    await pull({ force: true });

    const warnings = vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
    expect(await fse.readFile(copy('edited'), 'utf8')).toContain('My own wording.');
    expect(warnings.filter((message) => message.includes(copy('edited')) && message.includes('JoyCode never matches'))).toHaveLength(1);
  });
});

/**
 * A CLI upgrade that moves OpenCode's rules globs must reach a machine whose
 * team revision has not moved, or OpenCode keeps loading through the old
 * entry until the team next changes (#946).
 */
describe('a pull at an unchanged team revision after the OpenCode rules globs move (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  let saved: State;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-glob-upgrade-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(path.join(homeDir, '.config', 'opencode'));
    await fse.ensureDir(path.join(projectRoot, '.opencode'));
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  /** Pull once at revision abc1234, then put back what an older CLI left there. */
  async function pullThenDowngrade(scope: 'user' | 'project', configFile: string, old: unknown): Promise<void> {
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'rules', 'team-rule.md'), 'Use named exports.\n');
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope,
      projectRoot: scope === 'project' ? projectRoot : undefined,
      enabledAgents: ['opencode'],
    } as LocalConfig);
    await pull({});
    await fse.outputJson(configFile, old);
    vi.mocked(log.success).mockClear();
  }

  const alreadySynced = (): boolean => vi.mocked(log.success).mock.calls
    .some(([message]) => String(message).includes('Already synced at abc1234'));

  it('user scope: replaces the old relative glob with the absolute one', async () => {
    const config = path.join(homeDir, '.config', 'opencode', 'opencode.json');
    await pullThenDowngrade('user', config, { model: 'mine', instructions: ['rules/*.md'] });

    await pull({});

    expect(alreadySynced()).toBe(true);
    const rules = path.join(homeDir, '.config', 'opencode', 'rules');
    expect(await fse.readJson(config)).toEqual({ model: 'mine', instructions: [`${rules}/*.md`] });
  });

  it('project scope: moves the glob from the root opencode.json to .opencode/opencode.json', async () => {
    const root = path.join(projectRoot, 'opencode.json');
    const dot = path.join(projectRoot, '.opencode', 'opencode.json');
    await pullThenDowngrade('project', root, { theme: 'dark', instructions: ['.opencode/rules/*.md'] });
    await fse.outputJson(dot, {});

    await pull({});

    expect(alreadySynced()).toBe(true);
    expect(await fse.readJson(dot)).toEqual({ instructions: ['.opencode/rules/**/*.md'] });
    expect(await fse.readJson(root)).toEqual({ theme: 'dark' });
  });
});

/**
 * When no team rule reaches a tool any more, the copies teamai delivered go,
 * including the ones an older CLI wrote before the tool got its own render
 * (#946).
 */
describe('a rules sync that delivers no rule reclaims an older-format copy (#946)', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('removes the verbatim Kiro copy of a rule this member no longer receives, and keeps an edited one', async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-unselected-old-render-'));
    const homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    const SCOPED = '---\npaths:\n  - "src/**"\n---\n\nUse named exports.\n';
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), SCOPED);
    await fse.outputFile(path.join(repoPath, 'rules', 'other.md'), 'Other rule.\n');
    const old = path.join(homeDir, '.kiro', 'steering', 'scoped.md');
    const edited = path.join(homeDir, '.kiro', 'steering', 'other.md');
    await fse.outputFile(old, SCOPED);
    await fse.outputFile(edited, 'Other rule, my way.\n');
    vi.stubEnv('HOME', homeDir);
    const { RulesHandler } = await import('../resources/rules.js');
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['kiro'],
    } as LocalConfig;

    await new RulesHandler().pullAllRules(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }), localConfig, [],
    );

    expect(await fse.pathExists(old)).toBe(false);
    expect(await fse.readFile(edited, 'utf8')).toBe('Other rule, my way.\n');
  });
});

/**
 * An older CLI let a project pull rewrite the global SOUL.md block with the
 * project's rules. The upgrade must repair it on the next user pull, even
 * at an unchanged team revision (#946).
 */
describe('a user pull at an unchanged team revision repairs the Hermes SOUL.md block (#946)', () => {
  let tmpDir: string;
  let homeDir: string;
  let saved: State;
  const soul = () => path.join(homeDir, '.hermes', 'SOUL.md');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-soul-repair-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.hermes'));
    await fse.outputFile(path.join(repoPath, 'rules', 'codeword.md'), 'The user codeword is HERON-7.\n');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('HERMES_HOME', '');
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
      enabledAgents: ['hermes'],
    } as LocalConfig);
    await pull({});
    vi.mocked(log.success).mockClear();
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('rewrites a block an older project pull filled with the project\'s rules', async () => {
    const before = await fse.readFile(soul(), 'utf8');
    expect(before).toContain('HERON-7');
    await fse.writeFile(soul(), before.replace('The user codeword is HERON-7.', 'The project codeword is OTTER-9.'));

    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
    expect(await fse.readFile(soul(), 'utf8')).toBe(before);
  });
});

/**
 * OMP writes namespaced rules flat, and judges a clash of flat names among
 * the rules this member receives. Pull already holds that list, so the
 * number of times it resolves the rules must not grow with the rules (#946).
 */
describe('a pull for OMP with namespaced rules resolves the rules a fixed number of times (#946)', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  async function resolvesFor(namespaced: number): Promise<number> {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-resolves-'));
    const homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.omp', 'agent'));
    await fse.outputFile(path.join(repoPath, 'rules', 'root.md'), 'Root rule.\n');
    for (let i = 0; i < namespaced; i++) await fse.outputFile(path.join(repoPath, 'rules', 'fe', `r${i}.md`), `Rule ${i}.\n`);
    vi.stubEnv('HOME', homeDir);
    let saved = {} as State;
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
      enabledAgents: ['omp'],
    } as LocalConfig);
    vi.mocked(filterByTags).mockClear();

    await pull({ force: true });

    expect(await fse.pathExists(path.join(homeDir, '.omp', 'agent', 'rules', 'fe.r0.md'))).toBe(true);
    const calls = vi.mocked(filterByTags).mock.calls.filter((call) => call[3] === 'rules').length;
    await fse.remove(tmpDir);
    return calls;
  }

  it('resolves as often with five namespaced rules as with one', async () => {
    const one = await resolvesFor(1);
    const five = await resolvesFor(5);

    expect(five).toBe(one);
  });
});
