import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

// Mock getFileContentAtRev since test dirs are not real git repos
const mockGetFileContentAtRev = vi.fn<(repoPath: string, rev: string, filePath: string) => Promise<Buffer | null>>();
const mockGetFileContentWhenAdded = vi.fn<(repoPath: string, filePath: string) => Promise<Buffer | null>>()
  .mockResolvedValue(null);
vi.mock('../utils/git.js', () => ({
  getFileContentAtRev: (...args: [string, string, string]) => mockGetFileContentAtRev(...args),
  getFileContentWhenAdded: (...args: [string, string]) => mockGetFileContentWhenAdded(...args),
  createGit: vi.fn(),
  pullRepo: vi.fn(),
  pushRepoBranch: vi.fn(),
  generateBranchName: vi.fn(),
}));

import { syncTeamUpdatesToLocal } from '../utils/pre-push-sync.js';
import { fileHash } from '../utils/fs.js';
import { recordDelivered } from '../resources/delivered-copies.js';
import { teamRuleToCopilotInstructions } from '../resources/copilot-instructions.js';
import { teamRuleToOmpRule } from '../resources/omp-rule.js';
import { teamRuleToKiroSteering } from '../resources/kiro-steering.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('syncTeamUpdatesToLocal — rules', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pre-push-sync-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
        },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    mockGetFileContentAtRev.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync local rule when team repo updated but user did not edit', async () => {
    // Team repo has new version (v2)
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2 content');
    // Local still has old version (v1)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1 content');
    // Old team repo version was also v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v2 content');
  });

  it('records the rule it syncs as delivered, and leaves an edited one on record (#822)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'synced.md'), 'v2 content');
    await fse.writeFile(path.join(repoPath, 'rules', 'edited.md'), 'v2 content');
    const synced = path.join(homeDir, '.claude/rules', 'synced.md');
    const edited = path.join(homeDir, '.claude/rules', 'edited.md');
    await fse.writeFile(synced, 'v1 content');
    await fse.writeFile(edited, 'local edit');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));
    const delivered: Record<string, string> = { [synced]: 'hash-of-v1', [edited]: 'hash-of-v1' };

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', undefined, delivered);

    expect(delivered).toEqual({ [synced]: await fileHash(synced), [edited]: 'hash-of-v1' });
  });

  it('syncs a local rule at any of several bases, and keeps one at none (#812)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'at-older.md'), 'v3 content');
    await fse.writeFile(path.join(repoPath, 'rules', 'edited.md'), 'v3 content');
    // Both local copies differ from the newer base (rev2); only one is at the older (rev1).
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'at-older.md'), 'v1 content');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'edited.md'), 'local edit');
    mockGetFileContentAtRev.mockImplementation(async (_repo, rev) => Buffer.from(`${rev === 'rev2' ? 'v2' : 'v1'} content`));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, ['rev2', 'rev1']);

    expect(await fse.readFile(path.join(homeDir, '.claude/rules', 'at-older.md'), 'utf-8')).toBe('v3 content');
    expect(await fse.readFile(path.join(homeDir, '.claude/rules', 'edited.md'), 'utf-8')).toBe('local edit');
  });

  it('syncs a root-authored rule through its recorded rules/<ns>/ destination', async () => {
    // push placed this rule under rules/fe-know/; the author's copy stayed at
    // the tool's rules root, so there is no rules/my-rule.md to compare against.
    await fse.ensureDir(path.join(repoPath, 'rules', 'fe-know'));
    await fse.writeFile(path.join(repoPath, 'rules/fe-know', 'my-rule.md'), 'teammate v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1 content');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', {
      'my-rule': 'rules/fe-know/my-rule.md',
    });

    // Without the redirect the stale root copy reads as a local modification and
    // the next push sends it over the teammate's update.
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('teammate v2');
    expect(mockGetFileContentAtRev).toHaveBeenCalledWith(repoPath, 'abc1234', './rules/fe-know/my-rule.md');
  });

  it('syncs a placement that landed after the last pull from the version it was added with', async () => {
    // Placed, merged, recorded — and a teammate edits it before the author's
    // next pull. At lastPullRev the file did not exist yet (#649 review).
    await fse.outputFile(path.join(repoPath, 'rules/fe-know', 'my-rule.md'), 'teammate v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'as placed');
    mockGetFileContentAtRev.mockResolvedValue(null);
    mockGetFileContentWhenAdded.mockResolvedValueOnce(Buffer.from('as placed'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', {
      'my-rule': 'rules/fe-know/my-rule.md',
    });

    expect(await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8')).toBe('teammate v2');
    expect(mockGetFileContentWhenAdded).toHaveBeenCalledWith(repoPath, 'rules/fe-know/my-rule.md');
  });

  it('keeps following the record when a shared-root rule with the same name exists', async () => {
    // Both sides must resolve the same file. If the sync compared against
    // rules/my-rule.md while the scanner followed the record, the scan would
    // read the local copy as modified and push it over the placed rule.
    await fse.ensureDir(path.join(repoPath, 'rules', 'fe-know'));
    await fse.writeFile(path.join(repoPath, 'rules/fe-know', 'my-rule.md'), 'teammate v2');
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'somebody else\'s shared rule');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1 content');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', {
      'my-rule': 'rules/fe-know/my-rule.md',
    });

    expect(await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8'))
      .toBe('teammate v2');
    expect(mockGetFileContentAtRev).toHaveBeenCalledWith(repoPath, 'abc1234', './rules/fe-know/my-rule.md');
  });

  it('leaves a root rule alone when no record maps it to a namespaced team rule', async () => {
    await fse.ensureDir(path.join(repoPath, 'rules', 'fe-know'));
    await fse.writeFile(path.join(repoPath, 'rules/fe-know', 'my-rule.md'), 'someone else v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'my own rule');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('my own rule'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', {});

    // A shared basename is not evidence: this machine never pushed that rule.
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('my own rule');
  });

  it('ignores a record whose team file is gone', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1 content');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', {
      'my-rule': 'rules/fe-know/my-rule.md',
    });

    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v1 content');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should NOT sync local rule when user edited it', async () => {
    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2 content');
    // Local has user's custom edit (differs from both old and new team version)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'user custom content');
    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should still have user's edit
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('user custom content');
  });

  it('should NOT sync when both user and team changed the file', async () => {
    // Team repo has v3
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v3 team content');
    // Local has v2 (user edit)
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v2 user content');
    // Old team repo version was v1 (different from local v2)
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should keep v2 (user's edit preserved)
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v2 user content');
  });

  it('should skip files that are already identical (no-op)', async () => {
    const sameContent = 'identical content';
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), sameContent);
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), sameContent);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not call getFileContentAtRev at all (files are equal, skipped early)
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();

    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe(sameContent);
  });

  it('should skip sync entirely when lastPullRev is null', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, null);

    // Local should be unchanged
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v1');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should skip files that are new in team repo since last pull', async () => {
    // Team repo has a new file
    await fse.writeFile(path.join(repoPath, 'rules', 'new-rule.md'), 'new content');
    // Local does NOT have this file
    // Old team repo also didn't have it
    mockGetFileContentAtRev.mockResolvedValue(null);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should still not have the file (sync only handles existing files)
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'new-rule.md'))).toBe(false);
  });

  it('should skip local-only files not in team repo', async () => {
    // Local has a file, team repo does not
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'local-only.md'), 'my local rule');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local file should be untouched
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'local-only.md'), 'utf-8');
    expect(content).toBe('my local rule');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('should handle rules in subdirectories (e.g., python/tencent_standard.md)', async () => {
    // Team repo has updated file in subdirectory
    await fse.ensureDir(path.join(repoPath, 'rules', 'python'));
    await fse.writeFile(path.join(repoPath, 'rules', 'python/tencent_standard.md'), 'v2 standard');

    // Local still has old version
    await fse.ensureDir(path.join(homeDir, '.claude/rules', 'python'));
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'python/tencent_standard.md'), 'v1 standard');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 standard'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(
      path.join(homeDir, '.claude/rules', 'python/tencent_standard.md'),
      'utf-8',
    );
    expect(content).toBe('v2 standard');

    // Should have been called with the correct git path
    expect(mockGetFileContentAtRev).toHaveBeenCalledWith(
      repoPath,
      'abc1234',
      './rules/python/tencent_standard.md',
    );
  });

  it('should sync all installed tool directories', async () => {
    // Add a second tool that takes the team rule verbatim (WorkBuddy now gets
    // CodeBuddy's render, #946)
    await fse.ensureDir(path.join(homeDir, '.tclaude', 'rules'));
    teamConfig.toolPaths.tclaude = { skills: '.tclaude/skills', rules: '.tclaude/rules' };

    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'shared.md'), 'v2');
    // Both tool dirs have v1
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'v1');
    await fse.writeFile(path.join(homeDir, '.tclaude/rules', 'shared.md'), 'v1');
    // Old team repo was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Both should now have v2
    const claudeContent = await fse.readFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'utf-8');
    const wbContent = await fse.readFile(path.join(homeDir, '.tclaude/rules', 'shared.md'), 'utf-8');
    expect(claudeContent).toBe('v2');
    expect(wbContent).toBe('v2');
  });

  it('should skip uninstalled tool directories', async () => {
    // Add a tool that is NOT installed (no .codex/ directory)
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };
    // Note: .codex/ directory does NOT exist

    // Team repo has v2
    await fse.writeFile(path.join(repoPath, 'rules', 'shared.md'), 'v2');
    // Only claude has v1
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'v1');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Claude should be synced
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'utf-8');
    expect(content).toBe('v2');
    // .codex/ should NOT have been created
    expect(await fse.pathExists(path.join(homeDir, '.codex'))).toBe(false);
  });

  it('should not sync built-in rules like teamai-recall', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'teamai-recall.md'), 'v2 recall');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'teamai-recall.md'), 'v1 recall');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not touch teamai-recall — it's excluded
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'teamai-recall.md'), 'utf-8');
    expect(content).toBe('v1 recall');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  // Regression: Cursor rules moved to `.mdc`, and matching only `.md` here made
  // pre-push sync skip them entirely — push then reported the stale local copy
  // as "modified" and sent it upstream, reverting the teammate's update.
  it('should sync a cursor .mdc rule when the team updated it and the user did not', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor', 'rules'));
    teamConfig.toolPaths.cursor = {
      skills: '.cursor/skills',
      rules: '.cursor/rules',
      settings: '.cursor/hooks.json',
    };

    // Team repo has v2, scoped.
    await fse.writeFile(
      path.join(repoPath, 'rules', 'my-rule.md'),
      '---\npaths:\n  - "**/*.ts"\n---\n\nv2 content',
    );
    // Local Cursor copy is still v1, in Cursor's derived-frontmatter form.
    await fse.writeFile(
      path.join(homeDir, '.cursor/rules', 'my-rule.mdc'),
      '---\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\nv1 content',
    );
    mockGetFileContentAtRev.mockResolvedValue(
      Buffer.from('---\npaths:\n  - "**/*.ts"\n---\n\nv1 content'),
    );

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    const content = await fse.readFile(path.join(homeDir, '.cursor/rules', 'my-rule.mdc'), 'utf-8');
    expect(content).toContain('v2 content');
    // Refreshed in Cursor's format, not as a raw copy of the team `.md`.
    expect(content).toContain('globs: "**/*.ts"');
    expect(content).not.toContain('paths:');
  });

  it('should NOT sync a cursor .mdc rule the user edited', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor', 'rules'));
    teamConfig.toolPaths.cursor = {
      skills: '.cursor/skills',
      rules: '.cursor/rules',
      settings: '.cursor/hooks.json',
    };

    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2 content');
    await fse.writeFile(
      path.join(homeDir, '.cursor/rules', 'my-rule.mdc'),
      '---\nalwaysApply: true\n---\n\nuser custom content',
    );
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    const content = await fse.readFile(path.join(homeDir, '.cursor/rules', 'my-rule.mdc'), 'utf-8');
    expect(content).toContain('user custom content');
  });

  it('should treat a clean pull of a cursor rule as a no-op', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor', 'rules'));
    teamConfig.toolPaths.cursor = {
      skills: '.cursor/skills',
      rules: '.cursor/rules',
      settings: '.cursor/hooks.json',
    };

    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'same content');
    const mdcPath = path.join(homeDir, '.cursor/rules', 'my-rule.mdc');
    await fse.writeFile(mdcPath, '---\nalwaysApply: true\n---\n\nsame content\n');
    const before = await fse.readFile(mdcPath, 'utf-8');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    expect(await fse.readFile(mdcPath, 'utf-8')).toBe(before);
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('refreshes an unedited Kiro render to the team update, in Kiro\'s format (#946)', async () => {
    await fse.ensureDir(path.join(homeDir, '.kiro', 'steering'));
    teamConfig.toolPaths.kiro = { rules: '.kiro/steering' };
    const oldRule = '---\npaths: ["src/**"]\n---\n\nv1 content\n';
    const newRule = '---\npaths: ["src/**"]\n---\n\nv2 content\n';
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), newRule);
    const localFile = path.join(homeDir, '.kiro/steering', 'my-rule.md');
    await fse.writeFile(localFile, teamRuleToKiroSteering(oldRule));
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from(oldRule));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    expect(await fse.readFile(localFile, 'utf-8')).toBe(teamRuleToKiroSteering(newRule));
  });

  it('leaves a member flat-name file alone even when its body matches an older team rule (#946)', async () => {
    await fse.ensureDir(path.join(homeDir, '.omp', 'agent', 'rules'));
    teamConfig.toolPaths.omp = { rules: '.omp/rules', userScope: { rules: '.omp/agent/rules' } };
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), 'v2 content\n');
    const localFile = path.join(homeDir, '.omp/agent/rules', 'fe.style.md');
    const personal = teamRuleToOmpRule('v1 content\n');
    await fse.writeFile(localFile, personal);
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content\n'));
    const delivered = {};

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', undefined, delivered);

    expect(await fse.readFile(localFile, 'utf-8')).toBe(personal);
    expect(delivered).toEqual({});
  });

  it('refreshes an unedited flat OMP copy of a namespaced rule from rules/<ns>/<name>.md (#946)', async () => {
    await fse.ensureDir(path.join(homeDir, '.omp', 'agent', 'rules'));
    teamConfig.toolPaths.omp = { rules: '.omp/rules', userScope: { rules: '.omp/agent/rules' } };
    await fse.outputFile(path.join(repoPath, 'rules', 'fe', 'style.md'), 'v2 content\n');
    const localFile = path.join(homeDir, '.omp/agent/rules', 'fe.style.md');
    await fse.writeFile(localFile, teamRuleToOmpRule('v1 content\n'));
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 content\n'));

    const delivered = {};
    await recordDelivered(delivered, localFile);
    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', undefined, delivered);

    expect(await fse.readFile(localFile, 'utf-8')).toBe(teamRuleToOmpRule('v2 content\n'));
  });

  describe.each(['project', 'user'] as const)('Copilot rules in %s scope', (scope) => {
    let instructionsDir: string;
    const oldRule = '---\npaths: ["src/**/*.ts"]\n---\n\nv1 content\n';
    const newRule = '---\npaths: ["lib/**/*.ts"]\n---\n\nv2 content\n';

    beforeEach(() => {
      const copilotHome = path.join(tmpDir, 'custom-copilot-home');
      vi.stubEnv('COPILOT_HOME', copilotHome);
      mockGetFileContentAtRev.mockResolvedValue(Buffer.from(oldRule));
      localConfig.scope = scope;
      localConfig.projectRoot = scope === 'project' ? homeDir : undefined;
      localConfig.enabledAgents = ['copilot'];
      teamConfig.toolPaths = {
        copilot: { rules: '.github/instructions', userScope: { rules: 'instructions' } },
      };
      instructionsDir = scope === 'project'
        ? path.join(homeDir, '.github/instructions')
        : path.join(copilotHome, 'instructions');
    });

    it.each(['enabledAgents', 'disabledAgents'] as const)('does not touch rules excluded by %s', async (setting) => {
      localConfig[setting] = setting === 'enabledAgents' ? ['claude'] : ['copilot'];
      // Installation is independent of permission to sync this tool.
      await fse.ensureDir(process.env.COPILOT_HOME!);
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const original = teamRuleToCopilotInstructions(oldRule).replace('src/**/*.ts', 'custom/**/*.ts');
      await fse.outputFile(localFile, original);
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(original);
      expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
    });

    it('updates an unedited old body and regenerates applyTo from the current team rule', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      await fse.outputFile(localFile, teamRuleToCopilotInstructions(oldRule));
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);
      mockGetFileContentAtRev.mockResolvedValue(Buffer.from(oldRule));

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(teamRuleToCopilotInstructions(newRule));
      expect(mockGetFileContentAtRev).toHaveBeenCalledWith(repoPath, 'abc1234', './rules/my-rule.md');
    });

    it('records the Copilot rule it syncs as delivered (#822)', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      await fse.outputFile(localFile, teamRuleToCopilotInstructions(oldRule));
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);
      const delivered: Record<string, string> = { [localFile]: 'hash-of-v1' };

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', undefined, delivered);

      expect(delivered).toEqual({ [localFile]: await fileHash(localFile) });
    });

    it('refreshes applyTo when only the team paths change', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const pathsOnlyUpdate = oldRule.replace('src/**/*.ts', 'lib/**/*.ts');
      await fse.outputFile(localFile, teamRuleToCopilotInstructions(oldRule));
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), pathsOnlyUpdate);

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(teamRuleToCopilotInstructions(pathsOnlyUpdate));
    });

    it('keeps a locally edited header when only the team paths change', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const edited = teamRuleToCopilotInstructions(oldRule).replace('src/**/*.ts', 'custom/**/*.ts');
      await fse.outputFile(localFile, edited);
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), oldRule.replace('src/**/*.ts', 'lib/**/*.ts'));

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(edited);
    });

    it('preserves a genuine local body edit', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const edited = teamRuleToCopilotInstructions('my local edit\n');
      await fse.outputFile(localFile, edited);
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);
      mockGetFileContentAtRev.mockResolvedValue(Buffer.from(oldRule));

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(edited);
    });

    it('leaves a current body alone without consulting history', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const current = teamRuleToCopilotInstructions(newRule);
      await fse.outputFile(localFile, current);
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(current);
      expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
    });

    it('keeps the local copy when its base cannot be read', async () => {
      const localFile = path.join(instructionsDir, 'my-rule.instructions.md');
      const original = teamRuleToCopilotInstructions(oldRule);
      await fse.outputFile(localFile, original);
      await fse.writeFile(path.join(repoPath, 'rules/my-rule.md'), newRule);
      mockGetFileContentAtRev.mockResolvedValue(null);

      await syncTeamUpdatesToLocal(teamConfig, localConfig, 'missing-base');

      expect(await fse.readFile(localFile, 'utf-8')).toBe(original);
    });
  });

  it('should skip sync when getFileContentAtRev returns null (rev invalid)', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), 'v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'v1');
    // Simulate invalid/missing rev
    mockGetFileContentAtRev.mockResolvedValue(null);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'bad-rev');

    // Local should be unchanged (conservative: don't sync if we can't verify)
    const content = await fse.readFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'utf-8');
    expect(content).toBe('v1');
  });
});

describe('syncTeamUpdatesToLocal — skills', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pre-push-sync-skills-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
        },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    mockGetFileContentAtRev.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync skill dir when team repo updated but user did not edit', async () => {
    // Team repo: flat skill with SKILL.md v2
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');

    // Local: same skill with v1
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('v2 skill');
  });

  it('records the team files of a skill it syncs as delivered, not the member\'s own (#822)', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.outputFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');
    await fse.outputFile(path.join(teamSkillDir, 'CONTRIBUTORS'), 'alice\n');
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.outputFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');
    await fse.outputFile(path.join(localSkillDir, 'notes.md'), 'mine');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));
    const delivered: Record<string, string> = { [path.join(localSkillDir, 'SKILL.md')]: 'hash-of-v1' };

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234', undefined, delivered);

    expect(delivered).toEqual({ [path.join(localSkillDir, 'SKILL.md')]: await fileHash(path.join(localSkillDir, 'SKILL.md')) });
  });

  it('should NOT sync skill dir when user edited any file', async () => {
    // Team repo: skill with SKILL.md v2
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');

    // Local: user edited SKILL.md
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'user modified skill');

    // Old team repo version was v1 (different from local user edit)
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should keep user's edit
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('user modified skill');
  });

  it('should handle namespaced skills', async () => {
    // Team repo: namespaced skill ns/my-skill
    const teamSkillDir = path.join(repoPath, 'skills', 'ns', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 namespaced');

    // Local: same skill (local dirs are flat, not namespaced)
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v1 namespaced');

    // Old team repo version was v1
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 namespaced'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Local should now have v2
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('v2 namespaced');
  });

  it('should skip skill dirs that are already identical', async () => {
    const sameContent = 'identical skill content';
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), sameContent);

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), sameContent);

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });

  it('syncs a skill whose files are all at one of several bases (#812)', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v3 skill');
    await fse.writeFile(path.join(teamSkillDir, 'notes.md'), 'v3 notes');

    // Local is still what the last pull delivered (rev1); the push base (rev2) is newer.
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');
    await fse.writeFile(path.join(localSkillDir, 'notes.md'), 'v1 notes');

    mockGetFileContentAtRev.mockImplementation(async (_repo, rev, file) => (
      Buffer.from(`${rev === 'rev2' ? 'v2' : 'v1'} ${file.endsWith('SKILL.md') ? 'skill' : 'notes'}`)
    ));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, ['rev2', 'rev1']);

    expect(await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8')).toBe('v3 skill');
    expect(await fse.readFile(path.join(localSkillDir, 'notes.md'), 'utf-8')).toBe('v3 notes');
  });

  it('does not sync a skill whose files come from different bases (#812)', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), 'v3 skill');
    await fse.writeFile(path.join(teamSkillDir, 'notes.md'), 'v3 notes');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'v2 skill');
    await fse.writeFile(path.join(localSkillDir, 'notes.md'), 'v1 notes');

    mockGetFileContentAtRev.mockImplementation(async (_repo, rev, file) => (
      Buffer.from(`${rev === 'rev2' ? 'v2' : 'v1'} ${file.endsWith('SKILL.md') ? 'skill' : 'notes'}`)
    ));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, ['rev2', 'rev1']);

    expect(await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8')).toBe('v2 skill');
    expect(await fse.readFile(path.join(localSkillDir, 'notes.md'), 'utf-8')).toBe('v1 notes');
  });

  it('keeps files only the member has when it syncs a skill (#823)', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.outputFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');
    const skillsDir = path.join(homeDir, '.claude/skills');
    const localSkillDir = path.join(skillsDir, 'my-skill');
    await fse.outputFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');
    await fse.outputFile(path.join(localSkillDir, 'scratch', 'mine.md'), 'my notes');
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    expect(await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8')).toBe('v2 skill');
    expect(await fse.readFile(path.join(localSkillDir, 'scratch', 'mine.md'), 'utf-8')).toBe('my notes');
    expect(await fse.readdir(skillsDir)).toEqual(['my-skill']);
  });

  it.skipIf(process.getuid?.() === 0)('leaves a read-only skill as it was, with nothing beside it (#823)', async () => {
    const teamSkillDir = path.join(repoPath, 'skills', 'my-skill');
    await fse.outputFile(path.join(teamSkillDir, 'SKILL.md'), 'v2 skill');
    const skillsDir = path.join(homeDir, '.claude/skills');
    const localSkillDir = path.join(skillsDir, 'my-skill');
    await fse.outputFile(path.join(localSkillDir, 'SKILL.md'), 'v1 skill');
    await fse.chmod(path.join(localSkillDir, 'SKILL.md'), 0o444);
    await fse.chmod(localSkillDir, 0o555);
    mockGetFileContentAtRev.mockResolvedValue(Buffer.from('v1 skill'));

    try {
      await expect(syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234')).rejects.toThrow();
      expect(await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8')).toBe('v1 skill');
      expect(await fse.readdir(skillsDir)).toEqual(['my-skill']);
    } finally {
      await fse.chmod(localSkillDir, 0o755);
    }
  });

  it('should skip skills that only exist locally (not in team repo)', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'local-only');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), 'local skill');

    await syncTeamUpdatesToLocal(teamConfig, localConfig, 'abc1234');

    // Should not touch local-only skills
    const content = await fse.readFile(path.join(localSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe('local skill');
    expect(mockGetFileContentAtRev).not.toHaveBeenCalled();
  });
});
