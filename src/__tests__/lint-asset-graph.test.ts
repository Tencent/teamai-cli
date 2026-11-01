/**
 * Tests for `teamai codebase --lint` asset-relation counts (#1562 part 1):
 * the pure counting function, and the command's text/JSON output against a
 * team-clone fixture built the way `codebase-reconcile.test.ts` builds one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codebaseCmd } from '../codebase-cmd.js';
import { autoDetectInit, detectProjectConfig, requireInit, type TeamaiInit } from '../config.js';
import { computeLintAssetGraph } from '../lint-asset-graph.js';
import type { LintScopeGraph } from '../lint-asset-graph.js';
import type { RelationContext } from '../recall.js';
import { LocalConfigSchema, TeamaiConfigSchema, type SearchIndexEntry } from '../types.js';
import { createGit } from '../utils/git.js';
import { indexInMemory } from '../utils/search-index.js';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
}));

// ─── computeLintAssetGraph ──────────────────────────────

function entry(overrides: Partial<SearchIndexEntry> = {}): SearchIndexEntry {
  return {
    filename: 'x.md', title: 'X', author: '', date: '', tags: [], tokens: [], votes: 0,
    type: 'rules', ...overrides,
  };
}

function ctx(overrides: Partial<RelationContext> = {}): RelationContext {
  return {
    byTreePath: new Map(),
    incoming: new Map(),
    teamwikiRoot: '/nonexistent-teamwiki',
    withheld: new Set(),
    ...overrides,
  };
}

/** An existence check where every listed path exists on disk, nothing else does. */
function existsOnly(existing: string[]): LintScopeGraph['targetExists'] {
  return (_kind, treePath) => existing.includes(treePath);
}

const PAGE = 'teamwiki/evidence/code/pay/modules/ledger-receipts.md';

/** The #1552 example assets: the payments rule, its doc, a skill and a learning. */
function exampleScope(overrides: Partial<LintScopeGraph> = {}): LintScopeGraph {
  const rule = entry({
    filename: 'payments.md', treePath: 'rules/payments.md',
    related: [
      { relation: 'MAPS_TO', target: PAGE, via: 'declared' },
      { relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'declared' },
      { relation: 'REFERENCES', target: 'skills/release', via: 'declared' },
      // The typo from #1562 part 1: no such doc on disk.
      { relation: 'REFERENCES', target: 'docs/payment-overview.md', via: 'declared' },
    ],
  });
  const doc = entry({ filename: 'payments-overview.md', treePath: 'docs/payments-overview.md', type: 'docs' });
  const skill = entry({ filename: 'release.md', treePath: 'skills/release', type: 'skills' });
  const learning = entry({
    filename: 'ledger-timeout.md', treePath: 'learnings/ledger-timeout', type: 'learnings',
    // The doc is superseded by the learning (#1552's example).
    related: [{ relation: 'SUPERSEDES', target: 'docs/payments-overview.md', via: 'declared' }],
  });
  return {
    ctx: ctx({
      byTreePath: new Map([
        ['rules/payments.md', rule],
        ['docs/payments-overview.md', doc],
        ['skills/release', skill],
        ['learnings/ledger-timeout', learning],
      ]),
    }),
    targetExists: existsOnly(['docs/payments-overview.md', 'skills/release', 'learnings/ledger-timeout', PAGE]),
    ...overrides,
  };
}

describe('computeLintAssetGraph', () => {
  it('counts the #1552 example plus the typo: 4 assets, 4 relations, 0 without, 1 unresolved', () => {
    expect(computeLintAssetGraph([exampleScope()])).toEqual({
      assetCount: 4,
      relationCount: 4,
      withoutRelation: [],
      unresolved: [
        { from: 'rules/payments.md', relation: 'REFERENCES', target: 'docs/payment-overview.md', reason: 'no-asset' },
      ],
    });
  });

  it('counts a relation to a teamwiki page when the page exists and is not withheld', () => {
    // The MAPS_TO to the page is the only relation of a lone rule.
    const rule = entry({
      filename: 'payments.md', treePath: 'rules/payments.md',
      related: [{ relation: 'MAPS_TO', target: PAGE, via: 'declared' }],
    });
    const visible = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/payments.md', rule]]) }),
      targetExists: existsOnly([PAGE]),
    }]);
    expect(visible).toEqual({
      assetCount: 1,
      relationCount: 1,
      withoutRelation: [],
      unresolved: [],
    });
    // A withheld codebase's page gives no relation; a page the clone does not
    // hold resolves for nobody, so the declared relation is unresolved.
    const withheld = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/payments.md', rule]]), withheld: new Set(['pay']) }),
      targetExists: existsOnly([PAGE]),
    }]);
    expect(withheld.relationCount).toBe(0);
    expect(withheld.withoutRelation).toEqual(['rules/payments.md']);
    const missing = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/payments.md', rule]]) }),
      targetExists: existsOnly([]),
    }]);
    expect(missing.relationCount).toBe(0);
    expect(missing.unresolved).toEqual([
      { from: 'rules/payments.md', relation: 'MAPS_TO', target: PAGE, reason: 'no-asset' },
    ]);
  });

  it('declared beats link by target: a link to a declared target is prose', () => {
    const learning = entry({
      filename: 'ledger-timeout.md', treePath: 'learnings/ledger-timeout', type: 'learnings',
      related: [
        { relation: 'SUPERSEDES', target: 'docs/payments-overview.md', via: 'declared' },
        { relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'link' },
      ],
    });
    const doc = entry({ filename: 'payments-overview.md', treePath: 'docs/payments-overview.md', type: 'docs' });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['learnings/ledger-timeout', learning], ['docs/payments-overview.md', doc]]) }),
      targetExists: existsOnly(['docs/payments-overview.md']),
    }]);
    expect(graph.relationCount).toBe(1);
    expect(graph.withoutRelation).toEqual([]);
  });

  it('reports a declared relation to a teamwiki page that does not exist on disk as unresolved', () => {
    const rule = entry({
      filename: 'payments.md', treePath: 'rules/payments.md',
      related: [{ relation: 'MAPS_TO', target: PAGE, via: 'declared' }],
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/payments.md', rule]]) }),
      targetExists: existsOnly([]),
    }]);
    expect(graph.unresolved).toEqual([
      { from: 'rules/payments.md', relation: 'MAPS_TO', target: PAGE, reason: 'no-asset' },
    ]);
  });

  it('lists assets with no resolved relation in either direction', () => {
    const orphan = entry({ filename: 'orphan.md', treePath: 'rules/orphan.md' });
    const byTreePath = new Map(exampleScope().ctx.byTreePath);
    byTreePath.set('rules/orphan.md', orphan);
    const graph = computeLintAssetGraph([{ ...exampleScope(), ctx: ctx({ byTreePath }) }]);
    expect(graph.assetCount).toBe(5);
    expect(graph.withoutRelation).toEqual(['rules/orphan.md']);
  });

  it('counts a link-derived relation, with declared beating link between the same pair', () => {
    const rule = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [
        { relation: 'REFERENCES', target: 'docs/b.md', via: 'declared' },
        { relation: 'REFERENCES', target: 'docs/b.md', via: 'link' },
      ],
    });
    const doc = entry({ filename: 'b.md', treePath: 'docs/b.md', type: 'docs' });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/a.md', rule], ['docs/b.md', doc]]) }),
      targetExists: existsOnly(['docs/b.md']),
    }]);
    expect(graph.relationCount).toBe(1);
    expect(graph.withoutRelation).toEqual([]);
  });

  it('counts A→B and B→A of the same relation as one relation', () => {
    const a = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [{ relation: 'REFERENCES', target: 'rules/b.md', via: 'declared' }],
    });
    const b = entry({
      filename: 'b.md', treePath: 'rules/b.md',
      related: [{ relation: 'REFERENCES', target: 'rules/a.md', via: 'declared' }],
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/a.md', a], ['rules/b.md', b]]) }),
      targetExists: existsOnly([]),
    }]);
    expect(graph.relationCount).toBe(1);
    expect(graph.withoutRelation).toEqual([]);
  });

  it('counts path-derived rule→page edges from the scope code-page pool, with declared beating derived', () => {
    const pool = [{ treePath: PAGE, slug: 'pay', sources: ['src/ledger/receipts.ts'] }];
    const scoped = entry({
      filename: 'ledger-scoped.md', treePath: 'rules/ledger-scoped.md',
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({
        byTreePath: new Map([['rules/ledger-scoped.md', scoped]]),
        ruleGlobs: new Map([['rules/ledger-scoped.md', ['src/ledger/**']]]),
        codePages: pool,
      }),
      targetExists: existsOnly([]),
    }]);
    expect(graph.relationCount).toBe(1);
    expect(graph.withoutRelation).toEqual([]);
  });

  it('a glob spanning two codebases derives no counted edge, as recall renders none', () => {
    const pool = [
      { treePath: PAGE, slug: 'pay', sources: ['src/ledger/receipts.ts'] },
      { treePath: 'teamwiki/evidence/code/shop/modules/till.md', slug: 'shop', sources: ['src/ledger/shop.ts'] },
    ];
    const scoped = entry({ filename: 'ledger-scoped.md', treePath: 'rules/ledger-scoped.md' });
    const graph = computeLintAssetGraph([{
      ctx: ctx({
        byTreePath: new Map([['rules/ledger-scoped.md', scoped]]),
        ruleGlobs: new Map([['rules/ledger-scoped.md', ['src/ledger/**']]]),
        codePages: pool,
      }),
      targetExists: existsOnly([]),
    }]);
    expect(graph.relationCount).toBe(0);
    expect(graph.withoutRelation).toEqual(['rules/ledger-scoped.md']);
  });

  it('a declared relation from the rule to the page beats the derived edge', () => {
    const pool = [{ treePath: PAGE, slug: 'pay', sources: ['src/ledger/receipts.ts'] }];
    const rule = entry({
      filename: 'payments.md', treePath: 'rules/payments.md',
      related: [{ relation: 'MAPS_TO', target: PAGE, via: 'declared' }],
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({
        byTreePath: new Map([['rules/payments.md', rule]]),
        ruleGlobs: new Map([['rules/payments.md', ['src/ledger/**']]]),
        codePages: pool,
      }),
      targetExists: existsOnly([PAGE]),
    }]);
    expect(graph.relationCount).toBe(1); // declared only, not declared + derived
  });

  it('a declared REFERENCES the target links back to counts two: declared + link, as recall prints', () => {
    const rule = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [{ relation: 'REFERENCES', target: 'docs/b.md', via: 'declared' }],
    });
    const doc = entry({
      filename: 'b.md', treePath: 'docs/b.md', type: 'docs',
      related: [{ relation: 'REFERENCES', target: 'rules/a.md', via: 'link' }],
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/a.md', rule], ['docs/b.md', doc]]) }),
      targetExists: existsOnly(['docs/b.md']),
    }]);
    // The count follows what recall renders — one per relation line — not
    // one per unordered pair: the via stays in the key (#1637 review).
    expect(graph.relationCount).toBe(2);
    expect(graph.withoutRelation).toEqual([]);
  });

  it('does not resolve a target that exists on disk but is not in the index, and does not call it unresolved', () => {
    const rule = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [{ relation: 'REFERENCES', target: 'docs/hidden.md', via: 'declared' }],
    });
    const graph = computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/a.md', rule]]) }),
      // The doc exists in the team clone but is not delivered to this member's index.
      targetExists: existsOnly(['docs/hidden.md']),
    }]);
    expect(graph).toEqual({
      assetCount: 1,
      relationCount: 0,
      withoutRelation: ['rules/a.md'],
      unresolved: [],
    });
  });

  it('checks learnings against the learnings roots, with the .md the roots store them under', () => {
    const seen: string[] = [];
    const rule = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [{ relation: 'REFERENCES', target: 'learnings/ledger-timeout', via: 'declared' }],
    });
    const learning = entry({ filename: 'ledger-timeout.md', treePath: 'learnings/ledger-timeout', type: 'learnings' });
    computeLintAssetGraph([{
      ctx: ctx({ byTreePath: new Map([['rules/a.md', rule], ['learnings/ledger-timeout', learning]]) }),
      targetExists: (kind, treePath) => {
        seen.push(`${kind}:${treePath}`);
        return false; // not in the roots → unresolved
      },
    }]);
    expect(seen).toEqual(['learning:learnings/ledger-timeout']);
  });
});

// ─── codebaseCmd integration ────────────────────────────

const temporaryDirectories: string[] = [];
let originalCwd: string;
let stubbedHome: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lint-graph-'));
  temporaryDirectories.push(dir);
  return dir;
}

/** The #1552 example assets in a team clone, with the typo added to the rule (#1562). */
function writeTeamAssets(clone: string, opts: { withTeamwiki?: boolean } = {}): void {
  fs.mkdirSync(path.join(clone, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(clone, 'skills', 'release'), { recursive: true });
  if (opts.withTeamwiki !== false) {
    fs.mkdirSync(path.join(clone, 'teamwiki', 'evidence', 'code', 'pay', 'modules'), { recursive: true });
    fs.writeFileSync(
      path.join(clone, 'teamwiki', 'evidence', 'code', 'pay', 'modules', 'ledger-receipts.md'),
      ['---', 'title: ledger-receipts', 'source:', '  - src/ledger/receipts.ts', '---', '', '# Ledger receipts module', ''].join('\n'),
    );
  }
  fs.writeFileSync(path.join(clone, 'rules', 'payments.md'), [
    '---',
    'related:',
    '  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md',
    '  REFERENCES:',
    '    - docs/payments-overview.md',
    '    - skills/release',
    // The typo from #1562 part 1.
    '    - docs/payment-overview.md',
    '---',
    'Every payment goes through ledger receipts; no direct writes to ledger.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(clone, 'docs', 'payments-overview.md'), 'How the payment flow works.\n');
  fs.writeFileSync(
    path.join(clone, 'skills', 'release', 'SKILL.md'),
    '---\nname: release\ndescription: Release workflow\n---\n\n# Release\n',
  );
}

/** The pending learning queue of the member's install: beside the clone, for git teams. */
function pendingDirOf(clone: string): string {
  return path.join(path.dirname(clone), 'pending-learnings');
}

/** The expected assetGraph of the fixture: 4 assets, 4 relations, 0 without, 1 unresolved. */
const EXPECTED_ASSET_GRAPH = {
  assetCount: 4,
  relationCount: 4,
  withoutRelation: [],
  unresolved: [
    { from: 'rules/payments.md', relation: 'REFERENCES', target: 'docs/payment-overview.md', reason: 'no-asset' },
  ],
};

/**
 * A team clone of a bare remote whose main holds the example assets, a member
 * user-scope config (mocked into the loaders), and the member's recall index
 * built the way pull/contribute build it — the learning pending in the queue.
 */
async function createMemberFixture(withTeamwiki = true): Promise<{ clone: string; remote: string }> {
  const root = makeTmpDir();
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'clone');
  await createGit(root).raw(['init', '--bare', '-b', 'main', remote]);
  await createGit(root).clone(remote, clone);
  const git = createGit(clone);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  writeTeamAssets(clone, { withTeamwiki });
  fs.writeFileSync(path.join(clone, 'teamai.yaml'), 'team: test\n');
  await git.add('.');
  await git.commit('team');
  await git.push(['-u', 'origin', 'main']);

  // The member's learning: pending locally, recall-indexed from the queue (#1562).
  const pendingDir = pendingDirOf(clone);
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'ledger-timeout.md'), [
    '---',
    'title: Ledger timeout',
    'related:',
    '  SUPERSEDES: docs/payments-overview.md',
    '---',
    'The receipt write times out at 3s; retry once.',
    '',
  ].join('\n'));

  const localConfig = LocalConfigSchema.parse({ repo: { localPath: clone, remote }, username: 'member', scope: 'user' });
  const init: TeamaiInit = {
    localConfig,
    teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: remote }),
  };
  vi.mocked(autoDetectInit).mockResolvedValue(init);
  vi.mocked(detectProjectConfig).mockResolvedValue(null);
  vi.mocked(requireInit).mockResolvedValue(init);

  // The member's own recall index, at the user-scope path under the stubbed HOME.
  const index = await indexInMemory({
    indexPath: path.join(stubbedHome, '.teamai', 'search-index.json'),
    learningsDirs: [pendingDir],
    docsDir: path.join(clone, 'docs'),
    rulesDir: path.join(clone, 'rules'),
    skills: { kind: 'dirs', dirs: [path.join(clone, 'skills', 'release')] },
  });
  fs.mkdirSync(path.join(stubbedHome, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(stubbedHome, '.teamai', 'search-index.json'), JSON.stringify(index));
  return { clone, remote };
}

beforeEach(() => {
  originalCwd = process.cwd();
  stubbedHome = makeTmpDir();
  vi.stubEnv('HOME', stubbedHome);
  vi.mocked(autoDetectInit).mockReset();
  vi.mocked(detectProjectConfig).mockReset();
  vi.mocked(requireInit).mockReset();
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('codebase --lint asset counts (#1562 part 1)', () => {
  it('prints the asset line after the report, with exactly the example counts', async () => {
    await createMemberFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true });

    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('Assets: 4, relations: 4, without a relation: 0, unresolved: 1');
    // The graph checks ran too: the fixture's clone has no graph-index.json.
    expect(out).toContain('[graph-missing]');
  });

  it('embeds assetGraph in the JSON report', async () => {
    await createMemberFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true, json: true });

    const report = JSON.parse(String(log.mock.calls[0][0]));
    expect(report.assetGraph).toEqual(EXPECTED_ASSET_GRAPH);
    expect(process.exitCode).toBe(1); // graph-missing stays a high finding; the exit code does not change
  });

  it('still prints the asset line without a teamwiki, and adds no graph-missing findings', async () => {
    await createMemberFixture(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true });

    // The declared MAPS_TO names a page this clone does not hold, so it is
    // unresolved too — the graph checks are skipped, the counts are not.
    expect(log.mock.calls.flat().join('\n')).toBe('Assets: 4, relations: 3, without a relation: 0, unresolved: 2');
  });

  it('still embeds assetGraph in JSON without a teamwiki', async () => {
    await createMemberFixture(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true, json: true });

    const { assetGraph } = JSON.parse(String(log.mock.calls[0][0]));
    expect(assetGraph.assetCount).toBe(4);
    expect(assetGraph.relationCount).toBe(3);
    expect(assetGraph.withoutRelation).toEqual([]);
    expect(assetGraph.unresolved).toEqual([
      { from: 'rules/payments.md', relation: 'MAPS_TO', target: 'teamwiki/evidence/code/pay/modules/ledger-receipts.md', reason: 'no-asset' },
      { from: 'rules/payments.md', relation: 'REFERENCES', target: 'docs/payment-overview.md', reason: 'no-asset' },
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('produces no assetGraph with standalone --output, and leaves the output unchanged', async () => {
    const root = makeTmpDir();
    const wikiRoot = path.join(root, 'standalone', 'teamwiki');
    fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true, output: path.join(root, 'standalone'), json: true });

    const report = JSON.parse(String(log.mock.calls[0][0]));
    expect(report.assetGraph).toBeUndefined();
    expect(report.issues).toBeDefined();
    // No member was loaded: the fixture's index and pending queue stay unread counts, not sources.
    expect(vi.mocked(autoDetectInit)).not.toHaveBeenCalled();
  });

  it('lists the assets behind without a relation', async () => {
    const { clone } = await createMemberFixture();
    // An unpublished rule of another member: indexed (the member saw it), unrelated.
    fs.writeFileSync(path.join(clone, 'rules', 'unrelated.md'), 'A rule about something else.\n');
    const index = await indexInMemory({
      indexPath: path.join(stubbedHome, '.teamai', 'search-index.json'),
      learningsDirs: [pendingDirOf(clone)],
      docsDir: path.join(clone, 'docs'),
      rulesDir: path.join(clone, 'rules'),
      skills: { kind: 'dirs', dirs: [path.join(clone, 'skills', 'release')] },
    });
    fs.writeFileSync(path.join(stubbedHome, '.teamai', 'search-index.json'), JSON.stringify(index));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ lint: true, json: true });

    const report = JSON.parse(String(log.mock.calls[0][0]));
    expect(report.assetGraph.assetCount).toBe(5);
    expect(report.assetGraph.withoutRelation).toEqual(['rules/unrelated.md']);
    expect(report.assetGraph.relationCount).toBe(4);
  });
});
