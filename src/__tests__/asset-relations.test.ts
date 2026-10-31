/**
 * Tests for the #1552 first slice: declared asset relations (`related:`
 * frontmatter), link-derived REFERENCES, their storage on search-index
 * entries, and the `Related:` lines recall prints for them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ASSET_RELATIONS,
  classifyTreePath,
  normalizeTargetPath,
  parseRelatedBlock,
  relationsFromLinks,
  teamwikiCodebaseSlug,
} from '../asset-relations.js';
import type { RelationSeverity, StoredRelation } from '../asset-relations.js';
import { indexInMemory } from '../utils/search-index.js';
import { localLinkTargets } from '../utils/markdown-links.js';
import { formatResults, relationLines } from '../recall.js';
import type { RelationContext } from '../recall.js';
import type { SearchIndexEntry } from '../types.js';

// ─── normalizeTargetPath ─────────────────────────────────

describe('normalizeTargetPath', () => {
  it('keeps file kinds at their .md form', () => {
    expect(normalizeTargetPath('rules/payments.md')).toBe('rules/payments.md');
    expect(normalizeTargetPath('docs/a/b.md')).toBe('docs/a/b.md');
    expect(normalizeTargetPath('teamwiki/evidence/code/pay/modules/ledger.md')).toBe('teamwiki/evidence/code/pay/modules/ledger.md');
  });

  it('adds .md to a file kind that omits it', () => {
    expect(normalizeTargetPath('rules/payments')).toBe('rules/payments.md');
  });

  it('strips .md from learnings and skills', () => {
    expect(normalizeTargetPath('learnings/ns/some-id.md')).toBe('learnings/ns/some-id');
    expect(normalizeTargetPath('skills/release')).toBe('skills/release');
  });

  it('rejects absolute paths, parents, and unknown prefixes', () => {
    expect(normalizeTargetPath('/etc/passwd')).toBeNull();
    expect(normalizeTargetPath('C:\\docs\\x.md')).toBeNull();
    expect(normalizeTargetPath('../docs/x.md')).toBeNull();
    expect(normalizeTargetPath('docs/../../rules/x.md')).toBeNull();
    expect(normalizeTargetPath('src/foo.ts')).toBeNull();
    expect(normalizeTargetPath('')).toBeNull();
  });
});

describe('classifyTreePath / teamwikiCodebaseSlug', () => {
  it('classifies by prefix', () => {
    expect(classifyTreePath('rules/a.md')).toBe('rule');
    expect(classifyTreePath('docs/a.md')).toBe('doc');
    expect(classifyTreePath('learnings/a')).toBe('learning');
    expect(classifyTreePath('skills/a')).toBe('skill');
    expect(classifyTreePath('teamwiki/a.md')).toBe('teamwiki');
    expect(classifyTreePath('agents/a.md')).toBeNull();
  });

  it('reads the codebase slug out of a teamwiki evidence path', () => {
    expect(teamwikiCodebaseSlug('teamwiki/evidence/code/pay/modules/ledger.md')).toBe('pay');
    expect(teamwikiCodebaseSlug('teamwiki/other/pay/x.md')).toBeNull();
  });
});

// ─── parseRelatedBlock ───────────────────────────────────

function parse(
  rawRelated: unknown,
  sourceKind: 'rule' | 'doc' | 'learning' = 'rule',
  ownTreePath = 'rules/payments.md',
  exists: (kind: string, p: string) => boolean = () => true,
): { relations: StoredRelation[]; findings: Array<{ severity: RelationSeverity; message: string }> } {
  const findings: Array<{ severity: RelationSeverity; message: string }> = [];
  const relations = parseRelatedBlock(rawRelated, sourceKind, ownTreePath, 'fail',
    (kind, p) => exists(kind, p),
    (severity, message) => findings.push({ severity, message }));
  return { relations, findings };
}

describe('parseRelatedBlock — malformed input', () => {
  it('ignores an unknown key and reports it at the structural severity', () => {
    const { relations, findings } = parse({ GOVERNS: 'docs/x.md' });
    expect(relations).toEqual([]);
    expect(findings).toEqual([
      { severity: 'fail', message: '"GOVERNS" is not a relation. Use MAPS_TO, REFERENCES, SUPERSEDES or CONFLICTS_WITH.' },
    ]);
  });

  it('names the code-only relations separately from unknown keys', () => {
    const { relations, findings } = parse({ IMPLEMENTS: 'docs/x.md' });
    expect(relations).toEqual([]);
    expect(findings[0]?.message).toBe(
      'IMPLEMENTS relates code to code and cannot be declared on a rule. Use MAPS_TO, REFERENCES, SUPERSEDES or CONFLICTS_WITH.');
  });

  it('reports a pair outside the table and points a learning at CONFLICTS_WITH', () => {
    const { relations, findings } = parse({ SUPERSEDES: 'rules/payments.md' }, 'learning', 'learnings/some-id');
    expect(relations).toEqual([]);
    expect(findings[0]?.message).toBe(
      'a learning cannot SUPERSEDES a rule (rules/payments.md). Use CONFLICTS_WITH; this relation is ignored.');
  });

  it('ignores all of a `related` block that is not a mapping', () => {
    const { relations, findings } = parse(['MAPS_TO']);
    expect(relations).toEqual([]);
    expect(findings).toHaveLength(1);
  });

  it('ignores a key whose value is neither a string nor a list', () => {
    const { relations, findings } = parse({ REFERENCES: 42 });
    expect(relations).toEqual([]);
    expect(findings).toHaveLength(1);
  });

  it('keeps the strings of a mixed list and reports the rest', () => {
    const { relations, findings } = parse({ REFERENCES: ['docs/x.md', 7] });
    expect(relations).toEqual([{ relation: 'REFERENCES', target: 'docs/x.md', via: 'declared' }]);
    expect(findings).toHaveLength(1);
  });

  it('ignores a path that is absolute, climbs out, or has no known prefix', () => {
    for (const bad of ['/abs/docs/x.md', '../docs/x.md', 'src/x.ts']) {
      const { relations, findings } = parse({ REFERENCES: bad });
      expect(relations).toEqual([]);
      expect(findings).toHaveLength(1);
    }
  });

  it('warns when the path names no asset, at warn severity even in review', () => {
    const { relations, findings } = parse({ REFERENCES: 'docs/missing.md' }, 'rule', 'rules/a.md', () => false);
    expect(relations).toEqual([]);
    expect(findings).toEqual([
      { severity: 'warn', message: 'REFERENCES docs/missing.md names no team asset; this relation is ignored.' },
    ]);
  });

  it('warns and ignores a relation to itself', () => {
    const { relations, findings } = parse({ REFERENCES: 'rules/payments.md' });
    expect(relations).toEqual([]);
    expect(findings[0]?.severity).toBe('warn');
  });

  it('matches keys in any case', () => {
    const { relations } = parse({ references: 'docs/x.md', Maps_To: 'teamwiki/evidence/code/pay/m.md' });
    expect(relations.map((r) => r.relation).sort()).toEqual(['MAPS_TO', 'REFERENCES']);
  });
});

describe('parseRelatedBlock — valid declarations', () => {
  it('keeps the file order and dedupes the same relation+target twice', () => {
    const { relations } = parse({
      MAPS_TO: 'teamwiki/evidence/code/pay/m.md',
      REFERENCES: ['docs/a.md', 'docs/a.md'],
    });
    expect(relations).toEqual([
      { relation: 'MAPS_TO', target: 'teamwiki/evidence/code/pay/m.md', via: 'declared' },
      { relation: 'REFERENCES', target: 'docs/a.md', via: 'declared' },
    ]);
  });

  it('keeps two different relations to the same target', () => {
    const { relations, findings } = parse({ REFERENCES: 'docs/a.md', CONFLICTS_WITH: 'docs/a.md' });
    expect(relations).toHaveLength(2);
    expect(findings).toEqual([]);
  });

  it('enforces the declaration table per source kind', () => {
    // A doc cannot supersede a rule; a rule can.
    expect(parse({ SUPERSEDES: 'rules/r.md' }, 'doc', 'docs/a.md').relations).toEqual([]);
    expect(parse({ SUPERSEDES: 'rules/r.md' }, 'rule', 'rules/b.md').relations).toHaveLength(1);
    // MAPS_TO accepts only a teamwiki page.
    expect(parse({ MAPS_TO: 'docs/a.md' }).relations).toEqual([]);
  });
});

// ─── relationsFromLinks ──────────────────────────────────

describe('relationsFromLinks', () => {
  it('turns a link landing on an asset into REFERENCES, resolved from the file tree path', () => {
    const rels = relationsFromLinks('See [the overview](../docs/payments-overview.md).', 'learnings/some-id', localLinkTargets);
    expect(rels).toEqual([{ relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'link' }]);
  });

  it('resolves a bare relative destination against the linking file directory', () => {
    const rels = relationsFromLinks('[overview](payments-overview.md)', 'docs/payments.md', localLinkTargets);
    expect(rels).toEqual([{ relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'link' }]);
  });

  it('keeps an absolute-in-tree target as written', () => {
    const rels = relationsFromLinks('[x](rules/payments.md)', 'docs/a.md', localLinkTargets);
    expect(rels).toEqual([{ relation: 'REFERENCES', target: 'rules/payments.md', via: 'link' }]);
  });

  it('canonicalizes a link to a skill SKILL.md to the skill directory', () => {
    const rels = relationsFromLinks('[s](../skills/release/SKILL.md)', 'docs/a.md', localLinkTargets);
    expect(rels).toEqual([{ relation: 'REFERENCES', target: 'skills/release', via: 'link' }]);
  });

  it('skips links to URLs, code, and itself; ordinary prose resolves relative and is kept as a candidate', () => {
    const md = '[u](https://x.test/a) [c](`code`) [self](./payments.md) [plain](ordinary-prose)';
    const rels = relationsFromLinks(md, 'rules/payments.md', localLinkTargets);
    // A relative link to something that is not an asset is stored as a
    // candidate; recall prints it only when the target exists in the index.
    expect(rels).toEqual([{ relation: 'REFERENCES', target: 'rules/ordinary-prose.md', via: 'link' }]);
  });
});

describe('normalizeTargetPath — skills', () => {
  it('canonicalizes a declared skills/<dir>/SKILL.md to the skill directory', () => {
    expect(normalizeTargetPath('skills/release/SKILL.md')).toBe('skills/release');
    expect(normalizeTargetPath('skills/pay/release')).toBe('skills/pay/release');
  });
});

// ─── search-index integration ────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-relations-test-'));
}

describe('buildIndex — tree paths and stored relations', () => {
  it('stores the tree path and declared relations on rules, docs and learnings', async () => {
    const tmp = makeTmpDir();
    const rulesDir = path.join(tmp, 'rules');
    const docsDir = path.join(tmp, 'docs');
    const learningsDir = path.join(tmp, 'learnings');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    fs.mkdirSync(learningsDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(rulesDir, 'payments.md'), [
        '---',
        'related:',
        '  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md',
        '  REFERENCES: [docs/payments-overview.md]',
        '---',
        'Every payment goes through ledger receipts.',
        'The flow is in [the overview](../docs/payments-overview.md).',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(docsDir, 'payments-overview.md'), 'How the payment flow works.\n');
      fs.writeFileSync(path.join(learningsDir, 'ledger-timeout.md'), [
        '---',
        'title: Ledger timeout',
        'related:',
        '  SUPERSEDES: docs/payments-overview.md',
        '---',
        'The receipt write times out at 3s; retry once.',
        '',
      ].join('\n'));

      const index = await indexInMemory({
        indexPath: path.join(tmp, 'index.json'),
        rulesDir,
        docsDir,
        learningsDir,
      });

      const rule = index.entries.find((e) => e.filename === 'payments.md');
      expect(rule?.treePath).toBe('rules/payments.md');
      // Declared beats stored as declared; the same link-derived REFERENCES is
      // stored too, and deduplicated by the renderer later.
      expect(rule?.related?.filter((r) => r.via === 'declared')).toEqual([
        { relation: 'MAPS_TO', target: 'teamwiki/evidence/code/pay/modules/ledger-receipts.md', via: 'declared' },
        { relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'declared' },
      ]);
      expect(rule?.related?.filter((r) => r.via === 'link')).toEqual([
        { relation: 'REFERENCES', target: 'docs/payments-overview.md', via: 'link' },
      ]);

      const doc = index.entries.find((e) => e.filename === 'payments-overview.md');
      expect(doc?.treePath).toBe('docs/payments-overview.md');
      expect(doc?.related).toBeUndefined();

      const learning = index.entries.find((e) => e.filename === 'ledger-timeout.md');
      expect(learning?.treePath).toBe('learnings/ledger-timeout');
      expect(learning?.related).toEqual([
        { relation: 'SUPERSEDES', target: 'docs/payments-overview.md', via: 'declared' },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('indexes a delivered namespaced skill directory under its full team-tree path', async () => {
    const tmp = makeTmpDir();
    const skillRoot = path.join(tmp, 'repo', 'skills', 'pay', 'release');
    fs.mkdirSync(skillRoot, { recursive: true });
    try {
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: release\ndescription: d\n---\n\n# Release\n');
      const index = await indexInMemory({
        indexPath: path.join(tmp, 'index.json'),
        skills: { kind: 'dirs', dirs: [skillRoot] },
      });
      const skill = index.entries.find((e) => e.type === 'skills');
      expect(skill?.treePath).toBe('skills/pay/release');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not store declarations outside the table, even when the target exists', async () => {
    const tmp = makeTmpDir();
    const rulesDir = path.join(tmp, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(rulesDir, 'a.md'), [
        '---', 'related:', '  GOVERNS: docs/x.md', '---', 'A rule.', '',
      ].join('\n'));
      fs.writeFileSync(path.join(rulesDir, 'b.md'), [
        '---', 'related:', '  IMPLEMENTS: docs/x.md', '---', 'B rule.', '',
      ].join('\n'));
      fs.writeFileSync(path.join(rulesDir, 'c.md'), [
        '---', 'related:', '  REFERENCES: rules/c.md', '---', 'Self reference.', '',
      ].join('\n'));
      const index = await indexInMemory({ indexPath: path.join(tmp, 'index.json'), rulesDir });
      for (const name of ['a.md', 'b.md', 'c.md']) {
        expect(index.entries.find((e) => e.filename === name)?.related).toBeUndefined();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── recall rendering ────────────────────────────────────

function entry(overrides: Partial<SearchIndexEntry>): SearchIndexEntry {
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

describe('relationLines', () => {
  it('shows → on the declaring hit and ← on the target hit', () => {
    const rule = entry({
      filename: 'payments.md', treePath: 'rules/payments.md', path: '/repo/rules/payments.md',
      related: [{ relation: 'SUPERSEDES', target: 'docs/overview.md', via: 'declared' }],
    });
    const doc = entry({
      filename: 'overview.md', treePath: 'docs/overview.md', path: '/repo/docs/overview.md',
    });
    const context = ctx({
      byTreePath: new Map([
        ['docs/overview.md', doc],
        ['rules/payments.md', rule],
      ]),
      incoming: new Map([['docs/overview.md', [{ from: 'rules/payments.md', relation: 'SUPERSEDES', via: 'declared' }]]]),
    });

    expect(relationLines(context, rule)).toEqual(['Related: → SUPERSEDES /repo/docs/overview.md']);
    expect(relationLines(context, doc)).toEqual(['Related: ← SUPERSEDES /repo/rules/payments.md']);
  });

  it('prints nothing when the other end is not visible in this scope', () => {
    const rule = entry({
      filename: 'payments.md', treePath: 'rules/payments.md',
      related: [{ relation: 'REFERENCES', target: 'docs/missing.md', via: 'declared' }],
    });
    expect(relationLines(ctx(), rule)).toEqual([]);
  });

  it('declared beats link between the same two assets in the same direction', () => {
    const rule = entry({
      filename: 'a.md', treePath: 'rules/a.md',
      related: [
        { relation: 'REFERENCES', target: 'docs/b.md', via: 'declared' },
        { relation: 'REFERENCES', target: 'docs/b.md', via: 'link' },
      ],
    });
    const lines = relationLines(ctx({
      byTreePath: new Map([['docs/b.md', entry({ filename: 'b.md', treePath: 'docs/b.md', path: '/repo/docs/b.md' })]]),
    }), rule);
    expect(lines).toEqual(['Related: → REFERENCES /repo/docs/b.md']);
  });

  it('sorts incoming declared by the source tree path and caps at 5 lines', () => {
    const doc = entry({ filename: 'd.md', treePath: 'docs/d.md', path: '/repo/docs/d.md' });
    const incoming = [
      { from: 'rules/z.md', relation: 'REFERENCES' as const, via: 'declared' as const },
      { from: 'rules/a.md', relation: 'REFERENCES' as const, via: 'declared' as const },
      { from: 'learnings/l1', relation: 'MAPS_TO' as const, via: 'link' as const },
      { from: 'learnings/l2', relation: 'MAPS_TO' as const, via: 'link' as const },
      { from: 'learnings/l3', relation: 'MAPS_TO' as const, via: 'link' as const },
      { from: 'learnings/l4', relation: 'MAPS_TO' as const, via: 'link' as const },
    ];
    const byTreePath = new Map(incoming.map((r) => [r.from, entry({ filename: `${r.from}.md`, treePath: r.from, path: `/repo/${r.from}` })]));
    const lines = relationLines(ctx({ byTreePath, incoming: new Map([['docs/d.md', incoming]]) }), doc);
    expect(lines).toHaveLength(5);
    // Declared incoming sorts by source path: rules/a.md before rules/z.md.
    expect(lines[0]).toContain('rules/a.md');
    expect(lines[1]).toContain('rules/z.md');
  });

  it('resolves a teamwiki target only when the page exists and is not withheld', () => {
    const tmp = makeTmpDir();
    const teamwikiRoot = path.join(tmp, 'teamwiki');
    fs.mkdirSync(path.join(teamwikiRoot, 'evidence', 'code', 'pay'), { recursive: true });
    fs.writeFileSync(path.join(teamwikiRoot, 'evidence', 'code', 'pay', 'm.md'), 'page\n');
    try {
      const rule = entry({
        filename: 'r.md', treePath: 'rules/r.md',
        related: [{ relation: 'MAPS_TO', target: 'teamwiki/evidence/code/pay/m.md', via: 'declared' }],
      });
      const visible = ctx({ teamwikiRoot, withheld: new Set() });
      expect(relationLines(visible, rule)).toEqual([`Related: → MAPS_TO ${path.join(teamwikiRoot, 'evidence', 'code', 'pay', 'm.md')}`]);

      const withheld = ctx({ teamwikiRoot, withheld: new Set(['pay']) });
      expect(relationLines(withheld, rule)).toEqual([]);

      // An unreadable withheld list (null) resolves no teamwiki target.
      const unknown = ctx({ teamwikiRoot, withheld: null });
      expect(relationLines(unknown, rule)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('formatResults — Related: lines', () => {
  const docEntry = entry({
    filename: 'overview.md', treePath: 'docs/overview.md', path: '/repo/docs/overview.md', type: 'docs',
  });

  it('prints Related: after File: on hits of both ends, leaving hits and scores untouched', () => {
    const ruleHit = {
      entry: entry({
        filename: 'payments.md', treePath: 'rules/payments.md', path: '/repo/rules/payments.md',
        related: [{ relation: 'SUPERSEDES', target: 'docs/overview.md', via: 'declared' }],
      }),
      score: 5.1, scope: 'user' as const,
    };
    const docHit = { entry: docEntry, score: 5.0, scope: 'user' as const };
    const relations = new Map<string, RelationContext>([['user', ctx({
      byTreePath: new Map([
        ['docs/overview.md', docEntry],
        ['rules/payments.md', ruleHit.entry],
      ]),
      incoming: new Map([['docs/overview.md', [{ from: 'rules/payments.md', relation: 'SUPERSEDES', via: 'declared' }]]]),
    })]]);

    const plain = formatResults([ruleHit, docHit], undefined);
    const withRelations = formatResults([ruleHit, docHit], undefined, relations);

    expect(withRelations).toContain('Related: → SUPERSEDES /repo/docs/overview.md');
    expect(withRelations).toContain('Related: ← SUPERSEDES /repo/rules/payments.md');
    expect(withRelations.indexOf('Related:')).toBeGreaterThan(withRelations.indexOf('File:'));

    // Hits, order and scores are identical with and without the change:
    // everything the ranking prints is byte-identical once Related: lines drop out.
    const strip = (s: string): string => s.split('\n').filter((l) => !l.startsWith('Related:')).join('\n');
    expect(strip(withRelations)).toBe(plain);
  });

  it('prints no Related: line without a relation context', () => {
    const output = formatResults([
      {
        entry: entry({
          filename: 'payments.md', treePath: 'rules/payments.md',
          related: [{ relation: 'SUPERSEDES', target: 'docs/overview.md', via: 'declared' }],
        }),
        score: 5.1, scope: 'user',
      },
    ]);
    expect(output).not.toContain('Related:');
  });

  it('never borrows another scope context for a hit with an explicit scope', () => {
    // The project index is empty (no project ctx). A user rule's relation must
    // not appear on a workspace teamwiki hit: the project scope sees nothing.
    const userCtx = ctx({
      byTreePath: new Map([['rules/payments.md', entry({ filename: 'payments.md', treePath: 'rules/payments.md', path: '/user/rules/payments.md' })]]),
      incoming: new Map([['teamwiki/evidence/code/pay/m.md', [{ from: 'rules/payments.md', relation: 'MAPS_TO', via: 'declared' }]]]),
    });
    const relations = new Map<string, RelationContext>([['user', userCtx]]);
    const output = formatResults([
      {
        entry: entry({
          filename: 'evidence/code/pay/m.md', treePath: 'teamwiki/evidence/code/pay/m.md',
          path: '/repo/teamwiki/evidence/code/pay/m.md', type: 'docs',
        }),
        score: 6.1, scope: 'project',
      },
    ], undefined, relations);
    expect(output).not.toContain('Related:');
  });
});

describe('ASSET_RELATIONS', () => {
  it('is the four declarable relation names', () => {
    expect(ASSET_RELATIONS).toEqual(['MAPS_TO', 'REFERENCES', 'SUPERSEDES', 'CONFLICTS_WITH']);
  });
});
