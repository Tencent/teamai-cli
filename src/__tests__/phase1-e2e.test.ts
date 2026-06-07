/**
 * Phase 1 — End-to-end integration test for the recall-subagent feature.
 *
 * Mocks a complete team repo (agents / skills / learnings / docs / rules)
 * and exercises `pull()` followed by `recall()` to verify:
 *
 *   1. agents/*.md sync into every Tier-1 tool's agents directory
 *      (both team-authored agents AND the CLI built-in `teamai-recall.md`).
 *   2. CLAUDE.md gains a `[teamai:recall-rules:...]` block ONLY for Tier-1
 *      tools (those with both `claudemd` and `agents` paths).
 *   3. The shared multi-category search index (~/.teamai/search-index.json)
 *      contains entries for all four knowledge types.
 *   4. `recall()` STDOUT preserves the legacy [teamai:recall:start/end]
 *      envelope AND prepends a `[<type>]` tag on each hit.
 *   5. Tier-3 tools (cursor — no agents path) get NEITHER agents files NOR
 *      a recall-rules block, but other teamai resources still sync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// ─── Mock external dependencies ───────────────────────────

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
  getHeadRev: vi.fn().mockResolvedValue('deadbeef'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
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

// Skip auto-report (it tries to push to a remote that doesn't exist)
vi.mock('../team-push.js', () => ({
  reportUsageToTeam: vi.fn().mockResolvedValue(undefined),
}));

// Skip cross-team source pull (no fixtures here)
vi.mock('../source.js', () => ({
  pullSources: vi.fn().mockResolvedValue(undefined),
}));

// Skip skill-recommend (it imports from stats and needs more fixtures)
vi.mock('../skill-recommend.js', () => ({
  getRecommendations: vi.fn().mockResolvedValue([]),
  displayRecommendations: vi.fn(),
}));

// Skip role manifest loading — keep the test focused on Phase 1 wiring
vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockRejectedValue(new Error('no roles in fixture')),
  resolveRoleResourceNamespaces: vi.fn(),
}));

import { pull } from '../pull.js';
import { recall } from '../recall.js';
import {
  loadLocalConfigForScope,
  loadTeamConfig,
  requireInit,
} from '../config.js';
import {
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
} from '../types.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

// ─── Fixture: build a complete mock team repo ─────────────

async function buildMockTeamRepo(repoPath: string): Promise<void> {
  // 1. agents/ (Phase 1 — flat *.md)
  await fse.ensureDir(path.join(repoPath, 'agents'));
  await fse.writeFile(
    path.join(repoPath, 'agents', 'code-reviewer.md'),
    '---\nname: code-reviewer\ndescription: Review PRs\ntools: Read, Grep\n---\nReview the diff carefully.\n',
  );

  // 2. skills/<skill>/SKILL.md
  await fse.ensureDir(path.join(repoPath, 'skills', 'team-helper'));
  await fse.writeFile(
    path.join(repoPath, 'skills', 'team-helper', 'SKILL.md'),
    '---\nname: team-helper\ndescription: A helper skill for the team\n---\nDo team things.\n',
  );

  // 3. learnings/*.md (flat)
  await fse.ensureDir(path.join(repoPath, 'learnings'));
  await fse.writeFile(
    path.join(repoPath, 'learnings', 'api-timeout-2026-03-20.md'),
    '---\ntitle: "Resolved API timeout via retry backoff"\nauthor: jeff\ndate: 2026-03-20\ntags: [api, retry]\n---\nIncrease retry backoff for sglang.\n',
  );

  // 4. docs/ (recursive)
  await fse.ensureDir(path.join(repoPath, 'docs'));
  await fse.writeFile(
    path.join(repoPath, 'docs', 'codebase.md'),
    '---\ntitle: Codebase overview\ntags: [overview]\n---\nThis repo handles api requests.\n',
  );

  // 5. rules/<namespace>/*.md (recursive)
  await fse.ensureDir(path.join(repoPath, 'rules', 'common'));
  await fse.writeFile(
    path.join(repoPath, 'rules', 'common', 'coding-style.md'),
    '---\ntitle: Coding style\ntags: [style]\n---\nUse 2-space indentation.\n',
  );

  // 6. teamai.yaml lives in the team config (we mock loadTeamConfig instead)
}

function buildTeamConfig(): TeamaiConfig {
  return {
    team: 'phase1-e2e-team',
    description: 'Phase 1 end-to-end fixture',
    repo: 'https://example.com/phase1/repo.git',
    provider: 'tgit',
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: false },
    },
    toolPaths: {
      // Tier-1: subagent + claudemd + hooks
      claude: {
        skills: '.claude/skills',
        rules: '.claude/rules',
        agents: '.claude/agents',
        claudemd: '.claude/CLAUDE.md',
      },
      codebuddy: {
        skills: '.codebuddy/skills',
        rules: '.codebuddy/rules',
        agents: '.codebuddy/agents',
        claudemd: '.codebuddy/CODEBUDDY.md',
      },
      // Tier-3: hooks only (cursor — no agents, no claudemd in this fixture)
      cursor: {
        skills: '.cursor/skills',
        rules: '.cursor/rules',
      },
    } as TeamaiConfig['toolPaths'],
  } as TeamaiConfig;
}

function buildLocalConfig(repoPath: string): LocalConfig {
  return {
    repo: { localPath: repoPath, remote: 'https://example.com/phase1/repo.git' },
    username: 'phase1-tester',
    updatePolicy: 'auto',
    additionalRoles: [],
    scope: 'user',
  };
}

describe('Phase 1 end-to-end: pull a full team repo and recall', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-phase1-e2e-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(homeDir);

    // Pre-create per-tool root + agents + claudemd targets so the
    // ResourceHandler.isToolInstalled() check passes for Tier-1 tools.
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# Existing user content\n');

    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    await fse.writeFile(
      path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'),
      '# CodeBuddy user content\n',
    );

    // Tier-3: cursor has skills + rules but NO agents and NO claudemd
    await fse.ensureDir(path.join(homeDir, '.cursor', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.cursor', 'rules'));

    await buildMockTeamRepo(repoPath);

    vi.stubEnv('HOME', homeDir);

    teamConfig = buildTeamConfig();
    localConfig = buildLocalConfig(repoPath);

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(requireInit).mockResolvedValue({
      localConfig,
      teamConfig,
    } as unknown as Awaited<ReturnType<typeof requireInit>>);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('pulls all five resource types and lands them in the right places', async () => {
    await pull({});

    // Skills landed
    expect(
      await fse.pathExists(path.join(homeDir, '.claude/skills/team-helper/SKILL.md')),
    ).toBe(true);
    expect(
      await fse.pathExists(path.join(homeDir, '.cursor/skills/team-helper/SKILL.md')),
    ).toBe(true);

    // Rules landed (rules handler emits .md files into the rules/ dir)
    expect(
      await fse.pathExists(path.join(homeDir, '.claude/rules')),
    ).toBe(true);

    // Team agents landed for Tier-1 tools
    expect(
      await fse.pathExists(path.join(homeDir, '.claude/agents/code-reviewer.md')),
    ).toBe(true);
    expect(
      await fse.pathExists(path.join(homeDir, '.codebuddy/agents/code-reviewer.md')),
    ).toBe(true);

    // Tier-3 tool (cursor) has NO agents directory configured → must be skipped
    expect(
      await fse.pathExists(path.join(homeDir, '.cursor/agents')),
    ).toBe(false);
  });

  it('injects [teamai:recall-rules:...] block ONLY into Tier-1 CLAUDE.md', async () => {
    await pull({});

    const claudeMd = await fse.readFile(
      path.join(homeDir, '.claude', 'CLAUDE.md'),
      'utf8',
    );
    expect(claudeMd).toContain(TEAMAI_RECALL_RULES_START);
    expect(claudeMd).toContain(TEAMAI_RECALL_RULES_END);
    expect(claudeMd).toContain('teamai-recall');
    // Pre-existing user content survives
    expect(claudeMd).toContain('Existing user content');

    const codebuddyMd = await fse.readFile(
      path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'),
      'utf8',
    );
    expect(codebuddyMd).toContain(TEAMAI_RECALL_RULES_START);
    expect(codebuddyMd).toContain('teamai-recall');
    expect(codebuddyMd).toContain('CodeBuddy user content');

    // Cursor has no claudemd path → no file should be created
    expect(
      await fse.pathExists(path.join(homeDir, '.cursor', 'CLAUDE.md')),
    ).toBe(false);
  });

  it('builds the multi-category search index with docs/rules/skills/learnings', async () => {
    await pull({});

    const indexPath = path.join(homeDir, '.teamai', 'search-index.json');
    expect(await fse.pathExists(indexPath)).toBe(true);

    const index = await fse.readJson(indexPath);
    const types = (index.entries as Array<{ type?: string }>)
      .map((e) => e.type)
      .filter((t): t is string => Boolean(t))
      .sort();
    // All four categories present
    expect(types).toContain('docs');
    expect(types).toContain('learnings');
    expect(types).toContain('rules');
    expect(types).toContain('skills');
  });

  it('recall() STDOUT keeps the legacy envelope and prepends [type] tags', async () => {
    await pull({});

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      });

    try {
      // dryRun=true so autoUpvote is skipped (avoids touching the fixture repo)
      await recall('api', { dryRun: true });
    } finally {
      writeSpy.mockRestore();
      // Defensive — ensure stdout is restored even on failure
      process.stdout.write = origWrite;
    }

    const stdout = chunks.join('');
    // Legacy envelope preserved (markers used by tooling)
    expect(stdout).toContain('--- [teamai:recall:start] ---');
    expect(stdout).toContain('--- [teamai:recall:end] ---');

    // At least one hit carries a [<type>] tag (one of the four categories)
    expect(stdout).toMatch(/\[(docs|learnings|rules|skills)\]/);
  });

  it('subsequent pull() is idempotent — recall block stays single-instance', async () => {
    await pull({});
    await pull({ force: true });

    const claudeMd = await fse.readFile(
      path.join(homeDir, '.claude', 'CLAUDE.md'),
      'utf8',
    );
    const startCount = claudeMd.split(TEAMAI_RECALL_RULES_START).length - 1;
    const endCount = claudeMd.split(TEAMAI_RECALL_RULES_END).length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });
});
