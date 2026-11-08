import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));

vi.mock('../workflow-commands.js', () => ({ runShortcut: vi.fn() }));

import { codebaseCmd, hiddenDeepEnrichTarget, startDeepEnrich } from '../codebase-cmd.js';
import { DeepEnrich, type DeepEnrichEnd, type DocReply } from '../deep-enrich.js';
import { runShortcut } from '../workflow-commands.js';
import { autoDetectInit, NotInitializedError } from '../config.js';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';
import { createGit } from '../utils/git.js';

const temporaryDirectories: string[] = [];

function createEnrichFixture(project = 'faketest'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-unit-'));
  temporaryDirectories.push(root);
  const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', project);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, '_manifest.json'),
    JSON.stringify({
      schemaVersion: 'team-wiki.codebase-output-manifest.v2',
      project,
      generatedAt: '2026-01-01T00:00:00Z',
      components: [
        {
          slug: 'Auth',
          docPath: `evidence/code/${project}/Auth.md`,
          title: 'Auth',
          category: 'component',
          confidence: 'INFERRED',
          responsibilities: ['Authenticate users'],
          entrypoints: [],
        },
      ],
      edges: [{ from: 'Auth', to: 'Store', relation: 'DEPENDS_ON' }],
    }, null, 2),
  );
  return root;
}

const UNAVAILABLE: DocReply = { text: '', failure: 'mock: AI unavailable' };

/**
 * The steps of teamai-codebase-deep-enrich over `<root>/teamwiki`, in the order the workflow runs them, with `answer`
 * for what the tool answers for each component, `architecture` and `scenarios`. Undefined when the plan step refuses.
 */
async function deepEnrichSteps(root: string, answer: (doc: string) => DocReply = () => UNAVAILABLE, project = 'faketest'): Promise<DeepEnrichEnd | undefined> {
  const target = { project, wikiRoot: path.join(root, 'teamwiki') };
  const planned = await DeepEnrich.plan(target);

  if (!planned) return undefined;

  for (const component of planned.components) await DeepEnrich.write(target, { kind: 'component', slug: component.slug }, answer(component.slug));

  if (planned.architecture.needed) await DeepEnrich.write(target, { kind: 'architecture' }, answer('architecture'));
  const { scenarios } = await DeepEnrich.graph(target);

  return DeepEnrich.finish(target, scenarios.needed ? answer('scenarios') : { text: '', failure: '' });
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('codebase deep-enrich', () => {
  it('sets a failing exit code when the requested output has no teamwiki', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-missing-'));
    temporaryDirectories.push(root);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root });

    expect(process.exitCode).toBe(1);
  });

  it('lists deep-enrich in the handler help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({});

    expect(log.mock.calls.flat()).toContain(
      '  teamai codebase --deep-enrich           Generate deep knowledge from extracted evidence',
    );
  });

  it('writes deterministic graph docs from extracted evidence when AI is unavailable', async () => {
    const root = createEnrichFixture();

    const report = await deepEnrichSteps(root);

    expect(report).toEqual({
      text: 'Deep enrichment incomplete: project=faketest, missing component docs: Auth, missing architecture.md',
      exit_code: 1,
      complete: false,
      missing_components: ['Auth'],
      missing_architecture: true,
    });

    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    expect(fs.existsSync(path.join(docsDir, 'graph-g1-relations.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'graph-g2-dataflow.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'graph-g3-interfaces.md'))).toBe(true);
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8').length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
  });

  it('writes G6 as confidence-labelled knowledge graph triples with a multi-hop index', async () => {
    const root = createEnrichFixture();
    const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    const manifestPath = path.join(evidenceDir, '_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { edges: unknown[] };
    manifest.edges = [
      { from: 'Api', to: 'Service', relation: 'CALLS', protocol: 'HTTP', confidence: 'EXTRACTED', weight: 0.9 },
      { from: 'Service', to: 'Store', relation: 'WRITES', confidence: 'INFERRED', weight: 0.75 },
      { from: 'Worker', to: 'Queue', relation: 'PUBLISHES', confidence: 'AMBIGUOUS' },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await deepEnrichSteps(root);

    const docsDir = path.join(evidenceDir, 'docs');
    const g6 = fs.readFileSync(path.join(docsDir, 'graph-g6-triples.md'), 'utf8');
    expect(g6).toContain('# faketest — Knowledge Graph Triples');
    expect(g6).toContain('## Ontology definition');
    expect(g6).toContain('## Explicit triples');
    expect(g6).toContain('| Api | CALLS | Service | HTTP | EXTRACTED | 0.90 |');
    expect(g6).toContain('| Service | WRITES | Store | — | INFERRED | 0.75 |');
    expect(g6).toContain('| Worker | PUBLISHES | Queue | — | AMBIGUOUS | 0.30 |');
    expect(g6).toContain('Api → (CALLS) → Service → (WRITES) → Store');
    expect(g6).toContain('## Reverse reachability index');
    expect(g6).not.toContain('3-hop BFS');

    const readme = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');
    expect(readme).toContain('[graph-g6-triples.md](./graph-g6-triples.md)');
  });

  it('preserves transitive paths, reverse reachability, and renderable graph reports', async () => {
    const root = createEnrichFixture();
    const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    const manifestPath = path.join(evidenceDir, '_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { edges: unknown[] };
    manifest.edges = [
      { from: 'Api', to: 'Service', relation: 'CALLS', confidence: 'EXTRACTED', weight: 0.9 },
      { from: 'Service', to: 'Store', relation: 'WRITES', confidence: 'INFERRED', weight: 0.8 },
      { from: 'Api', to: 'Store', relation: 'READS', confidence: 'EXTRACTED', weight: 0.7 },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const docsDir = path.join(evidenceDir, 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'graph-g6-multihop.md'), 'stale G6 output');

    await deepEnrichSteps(root);

    const g6 = fs.readFileSync(path.join(docsDir, 'graph-g6-triples.md'), 'utf8');
    expect(g6).toContain('Api → (CALLS) → Service → (WRITES) → Store');
    expect(g6).toContain('| Store | 2 | Service, Api | Service → (WRITES) → Store; Api → (CALLS) → Service → (WRITES) → Store |');
    expect(g6).not.toContain('No indirect dependency path was extracted');
    expect(g6).toContain('| EXTRACTED | 0.90 |');
    expect(fs.existsSync(path.join(docsDir, 'graph-g6-multihop.md'))).toBe(false);

    for (const file of ['graph-g4-errors.md', 'graph-g7-risks.md', 'graph-g8-config.md', 'graph-g9-constraints.md', 'graph-coverage.md']) {
      const content = fs.readFileSync(path.join(docsDir, file), 'utf8');
      expect(content).not.toContain('\\n');
      expect(content).toContain('\n');
    }
    const k3 = fs.readFileSync(path.join(evidenceDir, '_review', 'k3-consistency-check.md'), 'utf8');
    expect(k3).toContain('Contradiction comparison: deferred');
    expect(k3).not.toContain('Contradictions: 0 detected');
  });

  it('labels G2 call-chain steps but not the dependency-paths intro', async () => {
    const root = createEnrichFixture();
    const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    fs.writeFileSync(path.join(evidenceDir, 'dependency-paths.md'), [
      '---',
      'title: faketest dependency paths',
      'domain: code-knowledge',
      '---',
      '',
      '# Dependency Paths',
      '',
      'Static import dependency paths (not runtime call traces).',
      '',
      '1 dependency path(s) traced from entry points (max depth 4).',
      '',
      '## POST /orders',
      '',
      '- [entry] `createOrder` ← src/api.ts:10',
      '    - [service] `placeOrder` ← src/service.ts:20',
      '',
    ].join('\n'));

    await deepEnrichSteps(root);

    const g2 = fs.readFileSync(path.join(evidenceDir, 'docs', 'graph-g2-dataflow.md'), 'utf8');
    expect(g2).toContain('## POST /orders');
    // Each step stays a Markdown list item, with the label after the marker.
    expect(g2).toMatch(/^- \[EXTRACTED\] \[entry\] `createOrder` ← src\/api\.ts:10$/m);
    expect(g2).toMatch(/^- \[EXTRACTED\] \[service\] `placeOrder` ← src\/service\.ts:20$/m);
    expect(g2).not.toContain('[EXTRACTED] Static import');
    expect(g2).not.toContain('[EXTRACTED] 1 dependency path(s)');
    expect(g2).not.toContain('## Dependency Paths');
  });

  it('writes every graph doc table with a header delimiter row', async () => {
    const withEvidence = createEnrichFixture();
    const withEvidenceDir = path.join(withEvidence, 'teamwiki', 'evidence', 'code', 'faketest');
    fs.writeFileSync(path.join(withEvidenceDir, 'dependency-paths.md'), [
      '## POST /orders',
      '',
      '- [entry] `createOrder` ← src/api.ts:10',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(withEvidenceDir, 'interfaces.md'), [
      '| Component | Type | Count | Confidence | Patterns |',
      '|-----------|------|-------|------------|----------|',
      '| Auth | http | 1 | EXTRACTED | `GET /login` |',
      '',
    ].join('\n'));
    const withoutEdges = createEnrichFixture();
    const withoutEdgesDir = path.join(withoutEdges, 'teamwiki', 'evidence', 'code', 'faketest');
    const manifestPath = path.join(withoutEdgesDir, '_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), edges: [] }));

    await deepEnrichSteps(withEvidence);
    await deepEnrichSteps(withoutEdges);

    // A Markdown table renders only when its second row is the delimiter row.
    const tablesWithoutDelimiter: string[] = [];
    for (const docsDir of [path.join(withEvidenceDir, 'docs'), path.join(withoutEdgesDir, 'docs')]) {
      for (const file of fs.readdirSync(docsDir).filter(name => name.startsWith('graph-'))) {
        const docLines = fs.readFileSync(path.join(docsDir, file), 'utf8').split('\n');
        docLines.forEach((line, index) => {
          const startsTable = line.startsWith('|') && !docLines[index - 1]?.startsWith('|');
          if (startsTable && !/^\|(\s*:?-+:?\s*\|)+$/.test(docLines[index + 1] ?? '')) {
            tablesWithoutDelimiter.push(`${file}: ${line}`);
          }
        });
      }
    }
    expect(tablesWithoutDelimiter).toEqual([]);
  });

  it('bounds reverse reachability output for a layered DAG', async () => {
    const root = createEnrichFixture();
    const evidenceDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    const manifestPath = path.join(evidenceDir, '_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { edges: unknown[] };
    const layers = [['Root']];
    for (let layer = 1; layer <= 18; layer++) {
      layers.push([`L${layer}A`, `L${layer}B`]);
    }
    const edges: Array<{ from: string; to: string; relation: string }> = [];
    for (let layer = 1; layer < layers.length; layer++) {
      for (const from of layers[layer - 1]) {
        for (const to of layers[layer]) {
          edges.push({ from, to, relation: 'DEPENDS_ON' });
        }
      }
    }
    expect(layers.flat()).toHaveLength(37);
    expect(edges).toHaveLength(70);
    manifest.edges = edges;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await deepEnrichSteps(root);

    const g6 = fs.readFileSync(path.join(evidenceDir, 'docs', 'graph-g6-triples.md'), 'utf8');
    expect(g6.length).toBeLessThan(60_000);
    const lastRow = g6.split('\n').find(line => line.startsWith('| L18A |'));
    expect(lastRow).toMatch(/^\| L18A \| 35 \| L17A, L17B, L16A, L16B, .*, L2A, L2B, … \(\+3 more\) \| /);
    expect(lastRow).toContain('; L14B → (DEPENDS_ON) → L15A → (DEPENDS_ON) → L16A → (DEPENDS_ON) → L17A → (DEPENDS_ON) → L18A; … 8 of 35 routes shown |');
    expect(lastRow).not.toContain('Root');
  });

  it.skipIf(process.platform === 'win32')('does not overwrite a file outside the teamwiki through a docs symlink', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    const outside = path.join(root, 'outside.md');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(outside, 'keep this content');
    fs.symlinkSync(outside, path.join(docsDir, 'graph-g1-relations.md'), 'file');

    await expect(DeepEnrich.plan({ project: 'faketest', wikiRoot: path.join(root, 'teamwiki') }))
      .rejects.toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep this content');
  });

  it('does not write docs through a symlinked docs directory', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, docsDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(DeepEnrich.plan({ project: 'faketest', wikiRoot: path.join(root, 'teamwiki') }))
      .rejects.toThrow(`Cannot deep-enrich through a symbolic link: ${docsDir}. Replace it with a regular file or directory before retrying.`);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not write docs through a symlinked evidence directory', async () => {
    const root = createEnrichFixture();
    const wikiRoot = path.join(root, 'teamwiki');
    const evidenceDir = path.join(wikiRoot, 'evidence', 'code', 'faketest');
    const outside = path.join(root, 'outside');
    fs.renameSync(evidenceDir, outside);
    fs.symlinkSync(outside, evidenceDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(DeepEnrich.plan({ project: 'faketest', wikiRoot }))
      .rejects.toThrow(/symbolic link/i);
    expect(fs.existsSync(path.join(outside, 'docs'))).toBe(false);
  });

  it('does not write progress through a symlinked review directory', async () => {
    const root = createEnrichFixture();
    const wikiRoot = path.join(root, 'teamwiki');
    const reviewDir = path.join(wikiRoot, 'evidence', 'code', 'faketest', '_review');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, reviewDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(DeepEnrich.plan({ project: 'faketest', wikiRoot }))
      .rejects.toThrow(/symbolic link/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not overwrite an outside file through a progress symlink', async () => {
    const root = createEnrichFixture();
    const wikiRoot = path.join(root, 'teamwiki');
    const reviewDir = path.join(wikiRoot, 'evidence', 'code', 'faketest', '_review');
    const outside = path.join(root, 'outside.json');
    fs.mkdirSync(reviewDir);
    fs.writeFileSync(outside, 'keep this content');
    fs.symlinkSync(outside, path.join(reviewDir, 'progress.json'), 'file');

    await expect(DeepEnrich.plan({ project: 'faketest', wikiRoot }))
      .rejects.toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep this content');
  });

  it('does not report success when the evidence dir has no components', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-empty-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    expect(runShortcut).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('No components in _manifest.json');
    expect(log.mock.calls.flat().join('\n')).not.toContain('Run `teamai codebase --extract` first');
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs'))).toBe(false);
  });

  it('previews without writing when --dry-run is set', async () => {
    const root = createEnrichFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true, dryRun: true });

    expect(process.exitCode).toBeUndefined();
    expect(runShortcut).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      project: 'faketest',
      dryRun: true,
    });
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs'))).toBe(false);
  });

  it('retries missing AI docs after recovery without wiping graph docs', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');

    const first = await deepEnrichSteps(root);
    expect(first).toMatchObject({ exit_code: 1, complete: false, missing_components: ['Auth'], missing_architecture: true });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
    const graphBefore = fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8');

    const answers: Record<string, string> = { Auth: '# Auth\n\nAuthenticates users.\n', architecture: '# Architecture\n\nAuth sits at the edge.\n' };
    const recovered = await deepEnrichSteps(root, (doc) => ({ text: answers[doc] ?? '', failure: '' }));

    expect(recovered).toMatchObject({ exit_code: 0, complete: true, missing_components: [], missing_architecture: false });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toContain('Authenticates users');
    expect(fs.readFileSync(path.join(docsDir, 'architecture.md'), 'utf8')).toContain('Auth sits at the edge');
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8')).toBe(graphBefore);

    expect(await deepEnrichSteps(root)).toMatchObject({ exit_code: 0, complete: true });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toContain('Authenticates users');
    expect(fs.readFileSync(path.join(docsDir, 'architecture.md'), 'utf8')).toContain('Auth sits at the edge');
  });

  it('preserves a completed component doc when architecture generation still fails', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'Auth.md'), '# Auth\n\nKeep me.\n');

    expect(await deepEnrichSteps(root)).toMatchObject({
      exit_code: 1,
      complete: false,
      missing_components: [],
      missing_architecture: true,
    });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toBe('# Auth\n\nKeep me.\n');
    expect(fs.existsSync(path.join(docsDir, 'graph-g1-relations.md'))).toBe(true);
  });

  it('still reports remaining missing AI work when a later retry also fails', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');

    expect((await deepEnrichSteps(root))?.complete).toBe(false);
    const graphBefore = fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8');

    const second = await deepEnrichSteps(root);

    expect(second).toEqual({
      text: 'Deep enrichment incomplete: project=faketest, missing component docs: Auth, missing architecture.md',
      exit_code: 1,
      complete: false,
      missing_components: ['Auth'],
      missing_architecture: true,
    });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8')).toBe(graphBefore);
  });

  it('regenerates component and architecture docs when the extract manifest is newer', async () => {
    const root = createEnrichFixture();
    const evidence = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    const docsDir = path.join(evidence, 'docs');
    fs.mkdirSync(path.join(evidence, '_review'), { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(evidence, '_manifest.json'), 'utf8')) as {
      generatedAt: string;
      components: Array<{ responsibilities: string[] }>;
    };
    manifest.generatedAt = '2026-09-11T00:00:00Z';
    manifest.components[0].responsibilities = ['NEW OAuth flow'];
    fs.writeFileSync(path.join(evidence, '_manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(evidence, '_review', 'progress.json'), JSON.stringify({
      project: 'faketest',
      phase: 'done',
      componentsDone: ['Auth'],
      componentsPending: [],
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    fs.writeFileSync(path.join(docsDir, 'Auth.md'), '# OLD password flow');
    fs.writeFileSync(path.join(docsDir, 'architecture.md'), '# OLD architecture');
    fs.writeFileSync(path.join(docsDir, 'graph-g1-relations.md'), '# graph placeholder\n');
    fs.writeFileSync(path.join(docsDir, 'graph-g5-scenarios.md'), '# OLD G5');
    const target = { project: 'faketest', wikiRoot: path.join(root, 'teamwiki') };

    const planned = await DeepEnrich.plan(target);

    expect(planned?.components.map((component) => [component.slug, component.responsibilities])).toEqual([['Auth', 'NEW OAuth flow']]);
    expect(planned?.architecture.needed).toBe(true);
    await DeepEnrich.write(target, { kind: 'component', slug: 'Auth' }, { text: '# NEW Auth\n', failure: '' });
    await DeepEnrich.write(target, { kind: 'architecture' }, { text: '# NEW architecture\n', failure: '' });
    expect((await DeepEnrich.graph(target)).scenarios.needed).toBe(false);
    expect(await DeepEnrich.finish(target, { text: '', failure: '' })).toMatchObject({ complete: true });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toContain('NEW Auth');
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).not.toContain('OLD password flow');
    expect(fs.readFileSync(path.join(docsDir, 'architecture.md'), 'utf8')).toContain('NEW architecture');
    expect(fs.existsSync(path.join(docsDir, 'graph-g1-relations.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'graph-g5-scenarios.md'))).toBe(false);
  });

  it('does not report complete with stale AI docs after a newer extract when AI still fails', async () => {
    const root = createEnrichFixture();
    const evidence = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    const docsDir = path.join(evidence, 'docs');
    fs.mkdirSync(path.join(evidence, '_review'), { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(evidence, '_manifest.json'), 'utf8')) as {
      generatedAt: string;
    };
    manifest.generatedAt = '2026-09-11T00:00:00Z';
    fs.writeFileSync(path.join(evidence, '_manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(evidence, '_review', 'progress.json'), JSON.stringify({
      project: 'faketest',
      phase: 'done',
      componentsDone: ['Auth'],
      componentsPending: [],
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    fs.writeFileSync(path.join(docsDir, 'Auth.md'), '# OLD password flow');
    fs.writeFileSync(path.join(docsDir, 'architecture.md'), '# OLD architecture');

    expect(await deepEnrichSteps(root)).toMatchObject({
      complete: false,
      missing_components: ['Auth'],
      missing_architecture: true,
    });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
  });

  it('refuses to plan when _manifest.json has no components, and writes nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hidden-deep-enrich-empty-'));
    temporaryDirectories.push(root);
    const wikiRoot = path.join(root, 'teamwiki');
    fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', 'widget'), { recursive: true });

    expect(await DeepEnrich.plan({ project: 'widget', wikiRoot })).toBeUndefined();
    expect(fs.readdirSync(path.join(wikiRoot, 'evidence', 'code', 'widget'))).toEqual([]);
  });

  it('names why a component or the architecture overview has no doc', async () => {
    const root = createEnrichFixture();
    const target = { project: 'faketest', wikiRoot: path.join(root, 'teamwiki') };
    const warned: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });

    expect(await DeepEnrich.write(target, { kind: 'component', slug: 'Auth' }, { text: '', failure: 'AI call failed (tool: claude): Authentication failed' })).toEqual({ written: false });
    expect(await DeepEnrich.write(target, { kind: 'component', slug: '../Auth' }, { text: '# Auth', failure: '' })).toEqual({ written: false });
    expect(await DeepEnrich.write(target, { kind: 'architecture' }, { text: ' \n', failure: '' })).toEqual({ written: false });
    expect(await DeepEnrich.write(target, { kind: 'architecture' }, { text: '', failure: 'AI call timed out after 600s (tool: claude)' })).toEqual({ written: false });

    expect(warned.join('\n')).toContain('deep-enrich[faketest]: Skipping component Auth: AI call failed (tool: claude): Authentication failed');
    expect(warned.join('\n')).toContain('deep-enrich[faketest]: Skipping unsafe component slug "../Auth"');
    expect(warned.join('\n')).toContain('deep-enrich[faketest]: Architecture overview: AI returned empty, skipping write');
    expect(warned.join('\n')).toContain('deep-enrich[faketest]: Architecture overview generation failed, skipping: AI call timed out after 600s (tool: claude)');
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs'))).toBe(false);
  });

  it('asks for G5 once two modules and the architecture doc exist, and writes what the tool answered', async () => {
    const root = createEnrichFixture();
    const evidence = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest');
    fs.mkdirSync(path.join(evidence, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'modules', 'Auth.md'), '# Auth\n');
    fs.writeFileSync(path.join(evidence, 'modules', 'Store.md'), '# Store\n');
    const answers: Record<string, string> = { Auth: '# Auth doc', architecture: '# Architecture doc', scenarios: '# Scenarios doc' };

    expect(await deepEnrichSteps(root, (doc) => ({ text: answers[doc] ?? '', failure: '' }))).toMatchObject({ complete: true });

    const docsDir = path.join(evidence, 'docs');
    expect(fs.readFileSync(path.join(docsDir, 'graph-g5-scenarios.md'), 'utf8')).toBe('# Scenarios doc');
    expect(fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8')).toContain('graph-g5-scenarios.md');
    expect((await DeepEnrich.graph({ project: 'faketest', wikiRoot: path.join(root, 'teamwiki') })).scenarios.needed).toBe(false);
  });

  it('covers only the first max-modules components, in every step', async () => {
    const root = createEnrichFixture();
    const manifestPath = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', '_manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { components: Array<{ slug: string }> };
    manifest.components.push({ ...manifest.components[0], slug: 'Store' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const target = { project: 'faketest', wikiRoot: path.join(root, 'teamwiki'), maxModules: 1 };

    expect((await DeepEnrich.plan(target))?.components.map((component) => component.slug)).toEqual(['Auth']);
    await DeepEnrich.graph(target);

    expect(await DeepEnrich.finish(target, { text: '', failure: '' })).toMatchObject({ missing_components: ['Auth'] });
  });

  it('starts teamai-codebase-deep-enrich on an --output teamwiki', async () => {
    const root = createEnrichFixture();
    vi.mocked(runShortcut).mockResolvedValue({ run: 'r1', outcome: 'succeeded', outputs: { exit_code: 1 } });

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root });

    expect(runShortcut).toHaveBeenCalledWith({
      workflow: 'teamai-codebase-deep-enrich',
      inputs: { wiki_root: path.join(root, 'teamwiki'), project: 'faketest', max_modules: 0, concurrency: 5 },
      command: 'teamai codebase --deep-enrich --project faketest',
      json: false,
    });
  });

  it('starts teamai-codebase-deep-enrich on a hidden --wiki-root with no teamai init', async () => {
    const root = createEnrichFixture();
    vi.mocked(autoDetectInit).mockRejectedValue(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));
    vi.mocked(runShortcut).mockResolvedValue({ run: 'r1', outcome: 'succeeded', outputs: { exit_code: 0 } });
    const wikiRoot = path.join(root, 'teamwiki');

    const ended = await startDeepEnrich({ target: await hiddenDeepEnrichTarget(wikiRoot), project: 'faketest', json: false, command: 'teamai deep-enrich --project faketest' });

    expect(ended).toEqual({ run: 'r1', outcome: 'succeeded', outputs: { exit_code: 0 } });
    expect(runShortcut).toHaveBeenCalledWith(expect.objectContaining({ inputs: { wiki_root: wikiRoot, project: 'faketest', max_modules: 0, concurrency: 5 } }));
  });

  it('rejects a codebase outside evidence/code/ and a max-modules that is not a whole number', () => {
    expect(DeepEnrich.targetOf({ wikiRoot: '/wiki', codebase: '..', maxModules: '0' }).ok).toBe(false);
    expect(DeepEnrich.targetOf({ wikiRoot: '/wiki', codebase: 'api', maxModules: 'two' })).toEqual({ ok: false, message: '--max-modules two is not a whole number from 0. Pass 0 to take every component.' });
    expect(DeepEnrich.targetOf({ wikiRoot: '/wiki', codebase: 'api', maxModules: '2' })).toEqual({ ok: true, target: { project: 'api', wikiRoot: path.resolve('/wiki'), maxModules: 2 } });
  });

  it('rejects a project slug that escapes the evidence directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-escape-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'teamwiki'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: '..', output: root });

    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toMatch(/outside|traversal/i);
  });
});

function writeDeepEnrichManifest(evidenceDir: string, project: string): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, '_manifest.json'),
    JSON.stringify({
      schemaVersion: 'team-wiki.codebase-output-manifest.v2',
      project,
      generatedAt: '2026-01-01T00:00:00Z',
      components: [
        {
          slug: 'Auth',
          docPath: `evidence/code/${project}/Auth.md`,
          title: 'Auth',
          category: 'component',
          confidence: 'INFERRED',
          responsibilities: ['Authenticate users'],
          entrypoints: [],
        },
      ],
      edges: [],
    }, null, 2),
  );
}

/** Team clone of a bare remote with extracted evidence, as after `teamai import`. */
async function createTeamDeepEnrichFixture(project = 'auth'): Promise<{ clone: string; remote: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-team-'));
  temporaryDirectories.push(root);
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'clone');
  await createGit(root).raw(['init', '--bare', '-b', 'main', remote]);
  await createGit(root).clone(remote, clone);
  const git = createGit(clone);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  fs.mkdirSync(path.join(clone, 'teamwiki'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'teamwiki', 'router.md'), '# Router\n');
  fs.writeFileSync(path.join(clone, 'teamwiki', 'index.md'), '# Index\n');
  writeDeepEnrichManifest(path.join(clone, 'teamwiki', 'evidence', 'code', project), project);
  fs.writeFileSync(path.join(clone, 'teamai.yaml'), 'team: test\n');
  await git.add('.');
  await git.commit('team');
  await git.push(['-u', 'origin', 'main']);
  vi.mocked(autoDetectInit).mockResolvedValue({
    localConfig: LocalConfigSchema.parse({ repo: { localPath: clone, remote }, username: 'member', scope: 'user' }),
    teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: remote }),
  });
  return { clone, remote };
}

describe('codebase deep-enrich in a team repo', () => {
  it('starts teamai-codebase-deep-enrich on the team teamwiki, five components at a time, whose run publishes what it wrote', async () => {
    const { clone, remote } = await createTeamDeepEnrichFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const wikiRoot = path.join(clone, 'teamwiki');
    vi.mocked(runShortcut).mockImplementation(async () => {
      await deepEnrichSteps(clone, () => UNAVAILABLE, 'auth');
      await DeepEnrich.publish({ project: 'auth', wikiRoot });

      return { run: 'r1', outcome: 'succeeded', outputs: { exit_code: 1 } };
    });

    await codebaseCmd({ deepEnrich: true, project: 'auth' });

    expect(runShortcut).toHaveBeenCalledWith({
      workflow: 'teamai-codebase-deep-enrich',
      inputs: { wiki_root: wikiRoot, project: 'auth', max_modules: 0, concurrency: 5, publish: true },
      command: 'teamai codebase --deep-enrich --project auth',
      json: false,
    });
    expect((await createGit(clone).status()).isClean()).toBe(true);
    expect(log.mock.calls.flat().join('\n')).toContain(`Pushed to team knowledge repo (${remote})`);
    for (const name of ['graph-g1-relations.md', 'graph-g2-dataflow.md', 'graph-g3-interfaces.md']) {
      expect(await createGit(remote).raw(['cat-file', '-e', `main:teamwiki/evidence/code/auth/docs/${name}`])).toBe('');
    }
  });

  it('publishes nothing when the run did not succeed', async () => {
    const { clone, remote } = await createTeamDeepEnrichFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const head = await createGit(remote).raw(['rev-parse', 'main']);
    vi.mocked(runShortcut).mockResolvedValue({ run: 'r1', outcome: 'failed' });

    await codebaseCmd({ deepEnrich: true, project: 'auth' });

    expect(await createGit(remote).raw(['rev-parse', 'main'])).toBe(head);
    expect((await createGit(clone).status()).isClean()).toBe(true);
  });

  it('does not publish when previewing with --dry-run', async () => {
    const { clone, remote } = await createTeamDeepEnrichFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const head = await createGit(remote).raw(['rev-parse', 'main']);

    await codebaseCmd({ deepEnrich: true, project: 'auth', dryRun: true });

    expect(runShortcut).not.toHaveBeenCalled();
    expect(await createGit(remote).raw(['rev-parse', 'main'])).toBe(head);
    expect((await createGit(clone).status()).isClean()).toBe(true);
  });
});
