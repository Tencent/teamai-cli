/**
 * Regression tests: `teamai push` must not open a duplicate PR for resources
 * that are already waiting in an unmerged PR.
 *
 * push detects changes by diffing against the team repo's default branch, so an
 * unmerged resource looks "new" forever. Before this guard, every re-run created
 * another branch (names carry a timestamp) and another PR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { push } from '../push.js';
import {
  findPendingForItem, partiallySelectedEntries, pendingNamespaceFor, planPushGroups,
  prunePendingPushes, recordPendingPush,
} from '../utils/pending-push.js';
import type { PendingPush, ResourceItem, State } from '../types.js';

const mockAutoDetectInit = vi.fn();
const mockPullRepo = vi.fn();
const mockPushRepoBranch = vi.fn();
const mockCheckoutMaster = vi.fn();
const mockGenerateBranchName = vi.fn();
const mockRemoteBranchExists = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();
const mockGetHandler = vi.fn();
const mockCreatePullRequest = vi.fn();
const mockAskSelection = vi.fn();

vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn(() => Promise.resolve('1')),
  askConfirmation: vi.fn(() => Promise.resolve(true)),
  askSelection: (...args: unknown[]) => mockAskSelection(...args),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

vi.mock('../utils/git.js', () => ({
  createGit: vi.fn().mockReturnValue({
    status: vi.fn().mockResolvedValue({
      modified: [], not_added: [], created: [], conflicted: [], staged: [],
    }),
    merge: vi.fn(),
    stash: vi.fn(),
    reset: vi.fn(),
    clean: vi.fn(),
  }),
  pullRepo: (...args: unknown[]) => mockPullRepo(...args),
  pushRepoBranch: (...args: unknown[]) => mockPushRepoBranch(...args),
  checkoutMaster: (...args: unknown[]) => mockCheckoutMaster(...args),
  generateBranchName: (...args: unknown[]) => mockGenerateBranchName(...args),
  remoteBranchExists: (...args: unknown[]) => mockRemoteBranchExists(...args),
  resetToCleanMaster: vi.fn(),
  isDedicatedRepoRoot: vi.fn().mockResolvedValue(true),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  getFileContentAtRev: vi.fn().mockResolvedValue(null),
}));

vi.mock('../resources/index.js', () => ({
  getHandler: (...args: unknown[]) => mockGetHandler(...args),
}));

vi.mock('../resources/skills.js', () => ({
  scanTeamRepoNamespaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    parseRepoInput: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo' }),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
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

function makeItem(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    name: 'hello-skill',
    type: 'skills',
    sourcePath: '/home/u/.cursor/skills/hello-skill',
    relativePath: 'skills/hello-skill',
    status: 'new',
    ...overrides,
  } as ResourceItem;
}

function makeState(pendingPushes: PendingPush[] = []): State {
  return {
    lastPush: null,
    lastPull: null,
    lastPullRev: null,
    pushedRules: [],
    pushedSkills: [],
    pushedEnvVars: [],
    pendingPushes,
    lastUpdateCheck: null,
    availableUpdate: null,
  };
}

function makeEntry(overrides: Partial<PendingPush> = {}): PendingPush {
  return {
    branch: 'teamai/push/testuser/20260827-065032',
    prUrl: 'https://github.com/team/repo/pull/5',
    createdAt: '2026-08-27T06:50:32.000Z',
    items: [{
      type: 'skills', name: 'hello-skill', relativePath: 'skills/js/hello-skill', namespace: 'js',
    }],
    ...overrides,
  };
}

// ─── Pure helpers ────────────────────────────────────────

describe('pending push records', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoteBranchExists.mockResolvedValue(true);
  });

  it('keeps a record whose branch still exists and whose resource is still scanned', async () => {
    const result = await prunePendingPushes('/tmp/repo', [makeEntry()], [makeItem()]);
    expect(result.pending).toHaveLength(1);
    expect(result.changed).toBe(false);
  });

  it('drops a record whose branch is gone from origin (PR merged or closed)', async () => {
    mockRemoteBranchExists.mockResolvedValue(false);
    const result = await prunePendingPushes('/tmp/repo', [makeEntry()], [makeItem()]);
    expect(result.pending).toHaveLength(0);
    expect(result.changed).toBe(true);
  });

  it('keeps records when the remote is unreachable, so duplicates stay blocked', async () => {
    mockRemoteBranchExists.mockResolvedValue(null);
    const result = await prunePendingPushes('/tmp/repo', [makeEntry()], [makeItem()]);
    expect(result.pending).toHaveLength(1);
  });

  it('drops a record whose resources no longer show up in the scan', async () => {
    const result = await prunePendingPushes('/tmp/repo', [makeEntry()], []);
    expect(result.pending).toHaveLength(0);
    expect(mockRemoteBranchExists).not.toHaveBeenCalled();
  });

  it('tolerates a state file written before pendingPushes existed', async () => {
    const result = await prunePendingPushes(
      '/tmp/repo',
      undefined as unknown as PendingPush[],
      [makeItem()],
    );
    expect(result.pending).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('matches a scanned resource by type and name, ignoring destination path', () => {
    const found = findPendingForItem([makeEntry()], makeItem({ relativePath: 'skills/hello-skill' }));
    expect(found).toHaveLength(1);
    expect(findPendingForItem([makeEntry()], makeItem({ name: 'other' }))).toHaveLength(0);
  });

  it('reuses a record when the selection covers all of its resources', () => {
    const entry = makeEntry({
      items: [
        { type: 'skills', name: 'hello-skill', relativePath: 'skills/js/hello-skill' },
        { type: 'rules', name: 'common/test-rule', relativePath: 'rules/common/test-rule.md' },
      ],
    });
    const skill = makeItem();
    const rule = makeItem({ type: 'rules', name: 'common/test-rule', relativePath: 'rules/common/test-rule.md' });

    expect(planPushGroups([skill, rule], [entry])).toEqual([{ items: [skill, rule], reuse: entry }]);
  });

  it('keeps unrelated resources out of the open PR by giving them their own group', () => {
    const extra = makeItem({ name: 'extra' });
    const groups = planPushGroups([makeItem(), extra], [makeEntry()]);
    expect(groups).toHaveLength(2);
    expect(groups[0].reuse?.branch).toBe('teamai/push/testuser/20260827-065032');
    expect(groups[1]).toEqual({ items: [extra] });
  });

  it('opens a new PR for a partial selection rather than dropping the rest', () => {
    const entry = makeEntry({
      items: [
        { type: 'skills', name: 'hello-skill', relativePath: 'skills/js/hello-skill' },
        { type: 'rules', name: 'common/test-rule', relativePath: 'rules/common/test-rule.md' },
      ],
    });
    const skill = makeItem();
    expect(planPushGroups([skill], [entry])).toEqual([{ items: [skill] }]);
    expect(partiallySelectedEntries([skill], [entry])).toEqual([entry]);
  });

  it('gives each open PR its own group', () => {
    const first = makeEntry({ branch: 'b1', createdAt: '2026-08-01T00:00:00.000Z' });
    const second = makeEntry({
      branch: 'b2',
      createdAt: '2026-08-27T00:00:00.000Z',
      items: [{ type: 'rules', name: 'common/test-rule', relativePath: 'rules/common/test-rule.md' }],
    });
    const skill = makeItem();
    const rule = makeItem({ type: 'rules', name: 'common/test-rule', relativePath: 'rules/common/test-rule.md' });

    const groups = planPushGroups([skill, rule], [first, second]);
    // Newest first, then the older record; nothing is left for a new PR.
    expect(groups.map((g) => g.reuse?.branch)).toEqual(['b2', 'b1']);
  });

  it('claims a resource once when two records list it', () => {
    const older = makeEntry({ branch: 'b1', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = makeEntry({ branch: 'b2', createdAt: '2026-08-27T00:00:00.000Z' });
    const groups = planPushGroups([makeItem()], [older, newer]);
    expect(groups).toEqual([{ items: [makeItem()], reuse: newer }]);
  });

  it('recalls the namespace chosen when the PR was opened', () => {
    expect(pendingNamespaceFor(makeEntry(), makeItem())).toBe('js');
  });

  it('replaces the record for a branch instead of appending a second one', () => {
    const state = makeState([makeEntry({ prUrl: 'old' })]);
    recordPendingPush(state, makeEntry({ prUrl: 'new' }));
    expect(state.pendingPushes).toHaveLength(1);
    expect(state.pendingPushes[0].prUrl).toBe('new');
  });
});

// ─── push() flow ─────────────────────────────────────────

function makeLocalConfig() {
  return {
    repo: { localPath: '/tmp/team-repo', remote: 'https://github.com/team/repo.git', kind: 'clone' },
    username: 'testuser',
    updatePolicy: 'auto',
    additionalRoles: [],
    resourceProfileVersion: 1,
    scope: 'user',
  };
}

function makeTeamConfig() {
  return {
    repo: 'https://github.com/team/repo.git',
    provider: 'github',
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    },
    toolPaths: {},
  };
}

describe('push() with an open PR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/testuser/20260827-070000');
    mockRemoteBranchExists.mockResolvedValue(true);
    mockCreatePullRequest.mockResolvedValue('https://github.com/team/repo/pull/9');
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockAskSelection.mockImplementation(
      (_p: string, count: number) => Promise.resolve(Array.from({ length: count }, (__, i) => i)),
    );
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => ({
      scanLocalForPush: vi.fn().mockResolvedValue(type === 'skills' ? [makeItem()] : []),
      pushItem: vi.fn(),
    }));
  });

  it('updates the open PR instead of opening a second one', async () => {
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));

    await push({});

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockPushRepoBranch).toHaveBeenCalledTimes(1);
    const [, , , branch, opts] = mockPushRepoBranch.mock.calls[0];
    expect(branch).toBe('teamai/push/testuser/20260827-065032');
    expect(opts).toEqual({ reuseBranch: true });
    // The namespace recorded with the PR is reused, not re-prompted.
    expect(mockPushRepoBranch.mock.calls[0][2]).toContain('skills/js/hello-skill');
  });

  it('sends unrelated resources to their own PR in the same run', async () => {
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));
    mockGetHandler.mockImplementation((type: string) => ({
      scanLocalForPush: vi.fn().mockResolvedValue(
        type === 'skills' ? [makeItem(), makeItem({ name: 'brand-new' })] : [],
      ),
      pushItem: vi.fn(),
    }));

    await push({});

    expect(mockPushRepoBranch).toHaveBeenCalledTimes(2);
    expect(mockPushRepoBranch.mock.calls[0][3]).toBe('teamai/push/testuser/20260827-065032');
    expect(mockPushRepoBranch.mock.calls[0][4]).toEqual({ reuseBranch: true });
    expect(mockPushRepoBranch.mock.calls[1][3]).toBe('teamai/push/testuser/20260827-070000');
    expect(mockPushRepoBranch.mock.calls[1][4]).toEqual({ reuseBranch: false });
    // Only the new resource needs a PR created; the other one updated its own.
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
    expect(saved.pendingPushes.map((p) => p.branch)).toEqual([
      'teamai/push/testuser/20260827-065032',
      'teamai/push/testuser/20260827-070000',
    ]);
  });

  it('keeps one record per branch across repeated pushes', async () => {
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));

    await push({ all: true });

    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
    expect(saved.pendingPushes).toHaveLength(1);
    expect(saved.pendingPushes[0].prUrl).toBe('https://github.com/team/repo/pull/5');
  });

  it('opens a PR normally when nothing is under review', async () => {
    mockLoadStateForScope.mockResolvedValue(makeState());

    await push({ all: true });

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const [, , , branch, opts] = mockPushRepoBranch.mock.calls[0];
    expect(branch).toBe('teamai/push/testuser/20260827-070000');
    expect(opts).toEqual({ reuseBranch: false });
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
    expect(saved.pendingPushes).toEqual([expect.objectContaining({
      branch: 'teamai/push/testuser/20260827-070000',
      prUrl: 'https://github.com/team/repo/pull/9',
    })]);
  });

  it('re-pushes as a new PR once the recorded branch is gone from origin', async () => {
    mockRemoteBranchExists.mockResolvedValue(false);
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));

    await push({});

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(mockPushRepoBranch.mock.calls[0][3]).toBe('teamai/push/testuser/20260827-070000');
  });

  it('updates the open PR in silent mode rather than duplicating it', async () => {
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));

    await push({ silent: true });

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockPushRepoBranch.mock.calls[0][4]).toEqual({ reuseBranch: true });
  });

  it('reports an unchanged PR without touching its branch', async () => {
    // pushRepoBranch returns false when the rebuilt tree matches the remote.
    mockPushRepoBranch.mockResolvedValue(false);
    mockLoadStateForScope.mockResolvedValue(makeState([makeEntry()]));

    await push({});

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
    expect(saved.pendingPushes).toHaveLength(1);
    expect(saved.pendingPushes[0].branch).toBe('teamai/push/testuser/20260827-065032');
  });

  it('keeps other skills\' open-PR records when pushing a single --skill', async () => {
    // --skill narrows the push to one skill, but the open PRs of the OTHER
    // skills must survive: pruning against the narrowed scan would drop them
    // and the next run would open duplicate PRs for them.
    const targetEntry = makeEntry({
      branch: 'teamai/push/testuser/target-branch',
      prUrl: 'https://github.com/team/repo/pull/1',
      items: [{ type: 'skills', name: 'target', relativePath: 'skills/js/target', namespace: 'js' }],
    });
    const otherEntry = makeEntry({
      branch: 'teamai/push/testuser/other-branch',
      prUrl: 'https://github.com/team/repo/pull/2',
      items: [{ type: 'skills', name: 'other', relativePath: 'skills/js/other', namespace: 'js' }],
    });
    mockLoadStateForScope.mockResolvedValue(makeState([targetEntry, otherEntry]));
    mockGetHandler.mockImplementation((type: string) => ({
      scanLocalForPush: vi.fn().mockResolvedValue(
        type === 'skills'
          ? [makeItem({ name: 'target', sourcePath: '/home/u/.cursor/skills/target' }),
            makeItem({ name: 'other', sourcePath: '/home/u/.cursor/skills/other' })]
          : [],
      ),
      pushItem: vi.fn(),
    }));

    await push({ all: true, skill: 'target' });

    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
    const branches = saved.pendingPushes.map((p) => p.branch).sort();
    expect(branches).toContain('teamai/push/testuser/other-branch');
  });

  describe('force-constructed --skill (scanner returns nothing)', () => {
    let tmpDir: string;
    let skillDir: string;

    beforeEach(() => {
      // A real skill dir on disk: force-construct only runs when the target
      // path exists with a SKILL.md but the scanner returned nothing for it
      // (local content is byte-identical to the team repo, so no diff).
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-force-skill-'));
      skillDir = path.join(tmpDir, 'solo-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# solo\n');
      // Scanner returns nothing → push must force-construct from the path.
      mockGetHandler.mockImplementation(() => ({
        scanLocalForPush: vi.fn().mockResolvedValue([]),
        pushItem: vi.fn(),
      }));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps its own open-PR record instead of reopening a duplicate', async () => {
      const entry = makeEntry({
        branch: 'teamai/push/testuser/solo-branch',
        prUrl: 'https://github.com/team/repo/pull/7',
        items: [{ type: 'skills', name: 'solo-skill', relativePath: 'skills/solo-skill' }],
      });
      mockLoadStateForScope.mockResolvedValue(makeState([entry]));

      await push({ all: true, skill: skillDir });

      // The force-constructed skill is still locally present, so its record
      // must survive the prune and the open PR must be updated, not duplicated.
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockPushRepoBranch.mock.calls[0][3]).toBe('teamai/push/testuser/solo-branch');
      expect(mockPushRepoBranch.mock.calls[0][4]).toEqual({ reuseBranch: true });
      const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as State;
      expect(saved.pendingPushes.map((p) => p.branch)).toContain('teamai/push/testuser/solo-branch');
    });
  });
});
