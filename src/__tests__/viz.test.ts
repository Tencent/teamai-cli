// -*- coding: utf-8 -*-
/**
 * Tests for viz.ts aggregation logic and viz-render.ts HTML output.
 *
 * Pure-function and tmpdir-based tests only — no real ~/.teamai access.
 * buildCoverage / buildTrend / buildAuthors are private helpers inlined in buildVizData
 * and cannot be tested independently without hitting real I/O; their logic is therefore
 * covered indirectly through renderReport assertions on a hand-crafted VizData fixture.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { aggregateTeamVotes, resolveVizRoot, buildVizData } from '../viz.js';
import { renderReport } from '../viz-render.js';
import type { VizData } from '../viz.js';
import { buildIndex } from '../utils/search-index.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { getProjectSearchIndexPath, type LocalConfig } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a complete minimal VizData fixture, allowing partial overrides. */
function makeVizData(overrides: Partial<VizData> = {}): VizData {
  return {
    generatedAt: '2026-08-31T00:00:00.000Z',
    root: '/tmp/teamai-test',
    source: { scope: 'local', label: 'Local ~/.teamai · your recalls only' },
    totalEntries: 0,
    totalRecalls: 0,
    overallCoveragePct: 0,
    contributorCount: 0,
    coverage: [],
    topRecalled: [],
    silent: [],
    relations: {
      assetCount: 0,
      relationCount: 0,
      withoutRelation: [],
      unresolved: [],
      silentAndWithoutRelation: [],
    },
    trend: [],
    authors: [],
    maintenance: { promote: [], prune: [], stale: [] },
    ...overrides,
  };
}

/** Create a YAML string in the v2 votes format expected by loadUserVotes. */
function votesYaml(
  entries: Record<string, { recalled_count: number; upvoted_count: number; last_recalled_at: string | null }>,
): string {
  const lines = ['version: 2', 'votes:'];
  for (const [docId, e] of Object.entries(entries)) {
    lines.push(`  ${docId}:`);
    lines.push(`    recalled_count: ${e.recalled_count}`);
    lines.push(`    upvoted_count: ${e.upvoted_count}`);
    lines.push(`    last_recalled_at: ${e.last_recalled_at ? `"${e.last_recalled_at}"` : 'null'}`);
  }
  lines.push('deltas: {}');
  return lines.join('\n') + '\n';
}

// ─── aggregateTeamVotes ────────────────────────────────────────────────────────

describe('aggregateTeamVotes', () => {
  const tmpBase = path.join(os.tmpdir(), 'teamai-viz-test');
  const votesDir = path.join(tmpBase, 'votes');

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('accumulates recalled_count and takes the larger last_recalled_at across two users', async () => {
    await fs.mkdir(votesDir, { recursive: true });

    // User A: doc-abc recalled 3 times, upvoted 1, older timestamp
    await fs.writeFile(
      path.join(votesDir, 'user-a.yaml'),
      votesYaml({
        'doc-abc': { recalled_count: 3, upvoted_count: 1, last_recalled_at: '2026-01-10T08:00:00Z' },
      }),
      'utf-8',
    );

    // User B: doc-abc recalled 5 times, upvoted 2, newer timestamp
    await fs.writeFile(
      path.join(votesDir, 'user-b.yaml'),
      votesYaml({
        'doc-abc': { recalled_count: 5, upvoted_count: 2, last_recalled_at: '2026-06-20T12:00:00Z' },
      }),
      'utf-8',
    );

    const result = await aggregateTeamVotes(votesDir);

    expect(result.byDoc['doc-abc']).toBeDefined();
    // recalled_count should be summed: 3 + 5 = 8
    expect(result.byDoc['doc-abc'].recalledCount).toBe(8);
    // upvoted_count should be summed: 1 + 2 = 3
    expect(result.byDoc['doc-abc'].upvotedCount).toBe(3);
    // last_recalled_at should be the larger value
    expect(result.byDoc['doc-abc'].lastRecalledAt).toBe('2026-06-20T12:00:00Z');
  });

  it('returns {} when the votes directory does not exist', async () => {
    const missing = path.join(tmpBase, 'no-such-dir');
    const result = await aggregateTeamVotes(missing);
    expect(result.byDoc).toEqual({});
    expect(result.activeContributors).toBe(0);
  });

  it('handles a doc present in only one user file and null last_recalled_at in one file', async () => {
    await fs.mkdir(votesDir, { recursive: true });

    await fs.writeFile(
      path.join(votesDir, 'user-a.yaml'),
      votesYaml({
        'doc-solo': { recalled_count: 2, upvoted_count: 0, last_recalled_at: null },
      }),
      'utf-8',
    );

    await fs.writeFile(
      path.join(votesDir, 'user-b.yaml'),
      votesYaml({
        'doc-solo': { recalled_count: 1, upvoted_count: 1, last_recalled_at: '2026-03-01T00:00:00Z' },
      }),
      'utf-8',
    );

    const result = await aggregateTeamVotes(votesDir);

    expect(result.byDoc['doc-solo'].recalledCount).toBe(3);
    expect(result.byDoc['doc-solo'].upvotedCount).toBe(1);
    // null should lose to any non-null timestamp
    expect(result.byDoc['doc-solo'].lastRecalledAt).toBe('2026-03-01T00:00:00Z');
  });

  it('counts only users with at least one recalled_count > 0 as active contributors', async () => {
    await fs.mkdir(votesDir, { recursive: true });

    // User A: has recalls
    await fs.writeFile(
      path.join(votesDir, 'user-a.yaml'),
      votesYaml({
        'doc-x': { recalled_count: 2, upvoted_count: 0, last_recalled_at: null },
      }),
      'utf-8',
    );

    // User B: no recalls at all
    await fs.writeFile(
      path.join(votesDir, 'user-b.yaml'),
      votesYaml({
        'doc-x': { recalled_count: 0, upvoted_count: 0, last_recalled_at: null },
      }),
      'utf-8',
    );

    const result = await aggregateTeamVotes(votesDir);
    expect(result.activeContributors).toBe(1);
  });
});

// ─── renderReport ─────────────────────────────────────────────────────────────

describe('renderReport', () => {
  it('returns a string that starts with <!DOCTYPE html', () => {
    const html = renderReport(makeVizData());
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html/i);
  });

  it('contains key section headings', () => {
    const html = renderReport(makeVizData());
    expect(html).toContain('Coverage by Type');
    expect(html).toContain('Top Recalled Entries');
    expect(html).toContain('Maintenance Console');
    expect(html).toContain('Overview');
    expect(html).toContain('Author Contributions');
  });

  it('escapes XSS in EntryMetric.title (topRecalled)', () => {
    const xssTitle = '<script>alert(1)</script>';
    const data = makeVizData({
      topRecalled: [
        {
          docId: 'xss-doc',
          title: xssTitle,
          type: 'learnings',
          author: 'tester',
          date: '2026-01-01',
          tags: [],
          recalledCount: 5,
          upvotedCount: 1,
          lastRecalledAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const html = renderReport(data);
    // Raw script tag must not appear in the output
    expect(html).not.toContain('<script>alert(1)</script>');
    // The title should be escaped instead
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS in EntryMetric.title (silent entries)', () => {
    const xssTitle = '<img src=x onerror=alert(1)>';
    const data = makeVizData({
      silent: [
        {
          docId: 'xss-silent',
          title: xssTitle,
          type: 'docs',
          author: 'tester',
          date: '2026-01-01',
          tags: [],
          recalledCount: 0,
          upvotedCount: 0,
          lastRecalledAt: null,
        },
      ],
    });

    const html = renderReport(data);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('shows "None right now." for all three empty maintenance sub-blocks', () => {
    const html = renderReport(makeVizData({ maintenance: { promote: [], prune: [], stale: [] } }));
    // Each of the three blocks emits "None right now." when empty
    const occurrences = (html.match(/None right now\./g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it('shows "All entries have been recalled at least once." when silent is empty', () => {
    const html = renderReport(makeVizData({ silent: [] }));
    expect(html).toContain('All entries have been recalled at least once.');
  });

  it('renders the relations section with the counts headline and the assets behind each count (#1562 part 2)', () => {
    const html = renderReport(makeVizData({
      relations: {
        assetCount: 4,
        relationCount: 4,
        withoutRelation: [],
        unresolved: ['rules/payments.md REFERENCES docs/payment-overview.md'],
        silentAndWithoutRelation: [],
      },
    }));
    expect(html).toContain('id="relations"');
    expect(html).toContain('4 assets · 4 relations · 0 without a relation · 1 unresolved');
    expect(html).toContain('rules/payments.md REFERENCES docs/payment-overview.md');
    expect(html).toContain('Silent and without a relation');
    // The counts say which scope they were resolved for, as the header labels its data.
    expect(html).toContain('Resolved for');
    expect(html).toContain('source-local');
  });

  it('prints "none" only for the silent-and-without-relation intersection, and lists the other counts', () => {
    const html = renderReport(makeVizData({
      relations: {
        assetCount: 3,
        relationCount: 1,
        withoutRelation: ['docs/orphan.md'],
        unresolved: [],
        silentAndWithoutRelation: ['docs/orphan.md'],
      },
    }));
    expect(html).toContain('3 assets · 1 relations · 1 without a relation · 0 unresolved');
    expect(html).toContain('docs/orphan.md');
    expect(html).not.toContain(': <span data-i18n>none</span>');
  });

  it('escapes XSS in relation list paths', () => {
    const html = renderReport(makeVizData({
      relations: {
        assetCount: 1,
        relationCount: 0,
        withoutRelation: ['docs/<script>bad</script>'],
        unresolved: [],
        silentAndWithoutRelation: [],
      },
    }));
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('reflects totalEntries and overallCoveragePct in the output', () => {
    const html = renderReport(makeVizData({ totalEntries: 42, overallCoveragePct: 75 }));
    expect(html).toContain('42');
    expect(html).toContain('75%');
  });
});

// ─── resolveVizRoot + buildVizData integration ────────────────────────────────

describe('buildVizData with explicit --repo', () => {
  let tmpRepo: string;

  afterEach(async () => {
    if (tmpRepo) {
      await fs.rm(tmpRepo, { recursive: true, force: true });
    }
  });

  it('sources corpus from the given repo and does not fall back to global index', async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-viz-repo-'));

    // Create a skill: skills/team-only-skill/SKILL.md
    const skillDir = path.join(tmpRepo, 'skills', 'team-only-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'title: "TEAM ONLY skill"',
        'author: alice',
        'tags: [team]',
        '---',
        '',
        'This skill belongs to the team repo only.',
      ].join('\n'),
      'utf-8',
    );

    // Create an empty votes directory so aggregateTeamVotes gets a valid path
    await fs.mkdir(path.join(tmpRepo, 'votes'), { recursive: true });

    const paths = await resolveVizRoot({ repo: tmpRepo });

    // Bug A: explicit --repo must not fall back to the global user index
    expect(paths.indexPath).toBeUndefined();
    expect(paths.source.scope).toBe('team');

    const data = await buildVizData(paths);

    expect(data.source.scope).toBe('team');
    expect(data.totalEntries).toBeGreaterThanOrEqual(1);

    // The skill title must appear somewhere in the report corpus
    const allTitles = [
      ...data.topRecalled.map((e) => e.title),
      ...data.silent.map((e) => e.title),
    ];
    expect(allTitles.some((t) => t.includes('TEAM ONLY skill'))).toBe(true);
  });
});

// ─── Relation counts in the KB health view (#1562 part 2) ─────────────────────

describe('buildVizData relation counts', () => {
  let tmpRepo: string;

  afterEach(async () => {
    if (tmpRepo) {
      await fs.rm(tmpRepo, { recursive: true, force: true });
    }
  });

  const write = async (rel: string, content: string): Promise<void> => {
    const file = path.join(tmpRepo, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf-8');
  };

  it('counts the #1552 example plus a typo\'d declared target like codebase --lint would', async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-viz-relations-'));
    // The #1552 fixture: a declared REFERENCES with the same link target
    // (declared beats link), a MAPS_TO to a teamwiki page, a SUPERSEDES from a
    // learning — plus a typo'd declared target that names nothing on disk.
    await write('rules/payments.md', [
      '---',
      'related:',
      '  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md',
      '  REFERENCES: [docs/payments-overview.md, docs/payment-overview.md, skills/pay/release, learnings/ledger-timeout]',
      '---',
      'Every payment goes through ledger receipts.',
      'The flow is in [the overview](../docs/payments-overview.md).',
      '',
    ].join('\n'));
    await write('teamwiki/evidence/code/pay/modules/ledger-receipts.md', 'Wiki page.\n');
    await write('docs/payments-overview.md', 'How the payment flow works.\n');
    await write('skills/pay/release/SKILL.md', '---\nname: release\ndescription: d\n---\n\n# Release\n');
    await write('learnings/ledger-timeout.md', [
      '---',
      'title: Ledger timeout',
      'related:',
      '  SUPERSEDES: docs/payments-overview.md',
      '---',
      'The receipt write times out at 3s; retry once.',
      '',
    ].join('\n'));
    await fs.mkdir(path.join(tmpRepo, 'votes'), { recursive: true });

    const data = await buildVizData(await resolveVizRoot({ repo: tmpRepo }));

    // rules/payments.md, docs/payments-overview.md, skills/pay/release,
    // learnings/ledger-timeout — teamwiki pages are not assets.
    expect(data.relations.assetCount).toBe(4);
    // REFERENCES doc + skill + learning + SUPERSEDES from the learning; the
    // MAPS_TO to a teamwiki page resolves for recall but a page is a target,
    // not an asset, so it does not count — and the rule's link to the doc
    // deduplicates under its declared REFERENCES.
    expect(data.relations.relationCount).toBe(4);
    expect(data.relations.withoutRelation).toEqual([]);
    expect(data.relations.unresolved).toEqual(['rules/payments.md REFERENCES docs/payment-overview.md']);
    // No votes anywhere: every asset is silent, and every asset has a relation.
    expect(data.relations.silentAndWithoutRelation).toEqual([]);

    const html = renderReport(data);
    expect(html).toContain('4 assets · 4 relations · 0 without a relation · 1 unresolved');
    expect(html).toContain('rules/payments.md REFERENCES docs/payment-overview.md');
  });

  it('lists silent assets without a relation by team-tree path and honors votes', async () => {
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-viz-relations-'));
    await write('docs/a.md', [
      '---',
      'related:',
      '  REFERENCES: docs/b.md',
      '---',
      'A.',
      '',
    ].join('\n'));
    await write('docs/b.md', 'B.\n');
    await write('docs/orphan.md', 'Orphan.\n');
    await fs.mkdir(path.join(tmpRepo, 'votes'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRepo, 'votes', 'user-a.yaml'),
      votesYaml({ b: { recalled_count: 2, upvoted_count: 0, last_recalled_at: '2026-06-20T12:00:00Z' } }),
      'utf-8',
    );

    const data = await buildVizData(await resolveVizRoot({ repo: tmpRepo }));

    expect(data.relations.assetCount).toBe(3);
    expect(data.relations.relationCount).toBe(1);
    expect(data.relations.withoutRelation).toEqual(['docs/orphan.md']);
    // docs/orphan.md is silent; docs/a.md is connected but silent too.
    expect(data.silent.map((m) => m.docId).sort()).toEqual(['a', 'orphan']);
    expect(data.relations.silentAndWithoutRelation).toEqual(['docs/orphan.md']);
  });
});

/**
 * The dashboard's own index build, when none was built by pull (#823 item 16):
 * it reads the active projects' learnings namespaces, as recall and pull do,
 * and never another project's.
 */
describe('buildVizData without a prebuilt index', () => {
  let tmp: string;
  let teamRepo: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-viz-ns-'));
    teamRepo = path.join(tmp, 'team-repo');
    realHome = process.env.HOME;
    process.env.HOME = path.join(tmp, 'home');
    await fs.mkdir(path.join(teamRepo, 'manifest'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = realHome;
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const learning = async (rel: string, title: string): Promise<void> => {
    const file = path.join(teamRepo, 'learnings', rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\ntitle: "${title}"\nauthor: alice\n---\n\nBody.\n`, 'utf-8');
  };
  const titles = (data: VizData): string[] => [...data.topRecalled, ...data.silent].map((entry) => entry.title);
  const configFor = (scope: 'user' | 'project') => ({
    repo: { localPath: teamRepo, kind: 'http' as const, remote: 'https://example.invalid/team' },
    username: 'alice',
    additionalRoles: [],
    projects: ['alpha'],
    scope,
    ...(scope === 'project' ? { projectRoot: path.join(tmp, 'proj'), dataHome: path.join(tmp, 'partition') } : {}),
  });

  it.each(['user', 'project'] as const)('shows the active project\'s learnings and not another project\'s (%s scope)', async (scope) => {
    await fs.writeFile(
      path.join(teamRepo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n'
        + '  - id: beta\n    name: Beta\n    resources:\n      learnings: [beta]\n',
    );
    await learning('shared.md', 'Shared learning');
    await learning('alpha/x.md', 'Alpha learning');
    await learning('beta/y.md', 'Beta learning');

    const data = await buildVizData(await resolveVizRoot({ config: configFor(scope) }));

    expect(titles(data)).toEqual(expect.arrayContaining(['Shared learning', 'Alpha learning']));
    expect(titles(data)).not.toContain('Beta learning');
  });

  it('shows the shared learnings, and says why no more, when projects.yaml does not parse', async () => {
    await fs.writeFile(path.join(teamRepo, 'manifest', 'projects.yaml'), 'projects: [unclosed\n');
    await learning('shared.md', 'Shared learning');
    await learning('alpha/x.md', 'Alpha learning');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const data = await buildVizData(await resolveVizRoot({ config: configFor('user') }));

    expect(titles(data)).toContain('Shared learning');
    expect(titles(data)).not.toContain('Alpha learning');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shared learnings only: Invalid projects manifest YAML/));
  });

  it('shows a queued learning, as recall finds it, but leaves the queue out of promotion and pruning (#823 item 16)', async () => {
    const queue = path.join(tmp, 'pending-learnings');
    await fs.mkdir(queue, { recursive: true });
    await fs.writeFile(path.join(queue, 'queued.md'), '---\ntitle: "Queued learning"\nauthor: alice\n---\n\nBody.\n', 'utf-8');

    const paths = await resolveVizRoot({ config: configFor('user') });
    const data = await buildVizData(paths);

    expect(titles(data)).toContain('Queued learning');
    expect(paths.learningsDirs).not.toContain(queue);
  });

  it('rebuilds the index pull built when a workspace child has changed what it selects since (#913)', async () => {
    await fs.writeFile(
      path.join(teamRepo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    resources:\n      learnings: [alpha]\n'
        + '  - id: beta\n    resources:\n      learnings: [beta]\n',
    );
    await learning('alpha/x.md', 'Alpha learning');
    await learning('beta/y.md', 'Beta learning');
    const config = { ...configFor('project'), projects: [] } as LocalConfig;
    const childConfig = path.join(config.projectRoot!, 'child', '.teamai', 'config.yaml');
    await fs.mkdir(path.dirname(childConfig), { recursive: true });
    const select = (project: string): Promise<void> => fs.writeFile(childConfig,
      `scope: workspace\nusername: alice\nprojects: [${project}]\nrepo:\n  kind: http\n  localPath: ${teamRepo}\n  remote: https://example.invalid/team\n`);
    await select('alpha');
    const before = await readWorkspaceChildren(config);
    await buildIndex({
      learningsDirs: [path.join(teamRepo, 'learnings')], learningsNamespaces: ['alpha'],
      indexPath: getProjectSearchIndexPath(config), children: before.children?.fingerprint,
    });
    await select('beta');

    const data = await buildVizData(await resolveVizRoot({ config }));

    expect(titles(data)).toContain('Beta learning');
    expect(titles(data)).not.toContain('Alpha learning');
  });

  it('rebuilds that index from what the children deliver now, not every skill in the team repo (#913)', async () => {
    await fs.writeFile(path.join(teamRepo, 'teamai.yaml'), 'team: viz\nrepo: https://example.invalid/team\nprovider: git\nreviewers: []\n');
    await fs.writeFile(
      path.join(teamRepo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    resources:\n      skills: [alpha]\n'
        + '  - id: beta\n    resources:\n      skills: [beta]\n',
    );
    for (const [namespace, name] of [['alpha', 'alpha-tool'], ['beta', 'beta-tool'], ['gamma', 'gamma-tool']]) {
      await fs.mkdir(path.join(teamRepo, 'skills', namespace, name), { recursive: true });
      await fs.writeFile(path.join(teamRepo, 'skills', namespace, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
    }
    const config = { ...configFor('project'), projects: [] } as LocalConfig;
    const childConfig = path.join(config.projectRoot!, 'child', '.teamai', 'config.yaml');
    await fs.mkdir(path.dirname(childConfig), { recursive: true });
    const select = (project: string): Promise<void> => fs.writeFile(childConfig,
      `scope: workspace\nusername: alice\nprojects: [${project}]\nrepo:\n  kind: http\n  localPath: ${teamRepo}\n  remote: https://example.invalid/team\n`);
    await select('alpha');
    const before = await readWorkspaceChildren(config);
    await buildIndex({
      learningsDirs: [], learningsNamespaces: [], indexPath: getProjectSearchIndexPath(config), children: before.children?.fingerprint,
      skillsDir: path.join(teamRepo, 'skills'), skills: { kind: 'dirs', dirs: [path.join(teamRepo, 'skills', 'alpha', 'alpha-tool')] },
    });
    await select('beta');

    const data = await buildVizData(await resolveVizRoot({ config }));

    const docs = [...data.topRecalled, ...data.silent].map((entry) => entry.docId);
    expect(docs.some((doc) => doc.includes('beta-tool'))).toBe(true);
    expect(docs.some((doc) => doc.includes('gamma-tool'))).toBe(false);
    expect(docs.some((doc) => doc.includes('alpha-tool'))).toBe(false);
  });

  describe('with skills in three namespaces and no index yet', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(teamRepo, 'teamai.yaml'), 'team: viz\nrepo: https://example.invalid/team\nprovider: git\nreviewers: []\n');
      await fs.writeFile(
        path.join(teamRepo, 'manifest', 'projects.yaml'),
        'version: 1\nprojects:\n  - id: alpha\n    resources:\n      skills: [alpha]\n'
          + '  - id: beta\n    resources:\n      skills: [beta]\n',
      );
      for (const [namespace, name] of [['alpha', 'alpha-tool'], ['beta', 'beta-tool'], ['gamma', 'gamma-tool']]) {
        await fs.mkdir(path.join(teamRepo, 'skills', namespace, name), { recursive: true });
        await fs.writeFile(path.join(teamRepo, 'skills', namespace, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
      }
    });
    const skills = (data: VizData): string[] => ['alpha-tool', 'beta-tool', 'gamma-tool']
      .filter((name) => [...data.topRecalled, ...data.silent].some((entry) => entry.docId.includes(name)));

    it('builds it from what the children of a workspace deliver (#913)', async () => {
      const config = { ...configFor('project'), projects: [] } as LocalConfig;
      const childConfig = path.join(config.projectRoot!, 'child', '.teamai', 'config.yaml');
      await fs.mkdir(path.dirname(childConfig), { recursive: true });
      await fs.writeFile(childConfig,
        `scope: workspace\nusername: alice\nprojects: [alpha]\nrepo:\n  kind: http\n  localPath: ${teamRepo}\n  remote: https://example.invalid/team\n`);

      const data = await buildVizData(await resolveVizRoot({ config }));

      expect(skills(data)).toEqual(['alpha-tool']);
    });

    it('builds it from every skill in the team repo for a scope without children, as before', async () => {
      const data = await buildVizData(await resolveVizRoot({ config: configFor('project') as LocalConfig }));

      expect(skills(data)).toEqual(['alpha-tool', 'beta-tool', 'gamma-tool']);
    });
  });
});
