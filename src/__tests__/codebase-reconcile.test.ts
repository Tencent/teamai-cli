import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codebaseCmd } from '../codebase-cmd.js';
import { aggregateGlobalGraph } from '../graph-aggregate.js';
import {
  loadGraphIndex,
  validateGraph,
  type GraphIndex,
} from '../wiki-engine/core/graph-index.schema.js';

const fsFailurePaths = vi.hoisted(() => ({ read: '', stat: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === fsFailurePaths.read) return Promise.reject(new Error('read denied'));
      return actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]) === fsFailurePaths.stat) {
        return Promise.reject(Object.assign(new Error('stat denied'), { code: 'EACCES' }));
      }
      return actual.stat(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

function createWikiFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-unit-'));
  temporaryDirectories.push(root);
  const productDir = path.join(root, 'teamwiki', 'product');
  const codeDir = path.join(root, 'teamwiki', 'evidence', 'code', 'auth');
  fs.mkdirSync(productDir, { recursive: true });
  fs.mkdirSync(codeDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, 'login.md'), '# Login\n\n`LoginService` authenticates users.\n');
  fs.writeFileSync(path.join(codeDir, 'component.md'), '# LoginService\n\nLoginService implements authentication.\n');
  return root;
}

afterEach(() => {
  process.exitCode = undefined;
  fsFailurePaths.read = '';
  fsFailurePaths.stat = '';
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('codebase reconciliation', () => {
  it('sets a failing exit code when the requested output has no teamwiki', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-missing-'));
    temporaryDirectories.push(root);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ reconcile: true, output: root });

    expect(process.exitCode).toBe(1);
  });

  it('lists reconciliation in the handler help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({});

    expect(log.mock.calls.flat()).toContain(
      '  teamai codebase --reconcile             Reconcile product and code knowledge',
    );
  });

  it('prints a summary in preview mode and emits JSON while writing the graph', { timeout: 60_000 }, async () => {
    const root = createWikiFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ reconcile: true, output: root, dryRun: true });
    expect(log).toHaveBeenLastCalledWith('Reconciliation complete: mappings=1, gaps=0, conflicts=0');
    expect(fs.existsSync(path.join(root, 'teamwiki', '.indices', 'graph-index.json'))).toBe(false);

    log.mockClear();
    await codebaseCmd({ reconcile: true, output: root, json: true });
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({ mappings: 1 });
    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(graph).not.toBeNull();
    expect(validateGraph(graph as GraphIndex)).toEqual({ valid: true, issues: [] });
  });

  it('replaces stale reconciliation edges when the pages no longer match', async () => {
    const root = createWikiFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ reconcile: true, output: root, json: true });

    fs.writeFileSync(
      path.join(root, 'teamwiki', 'product', 'login.md'),
      '# Login\n\n`SessionManager` authenticates users.\n',
    );
    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(graph?.edges.filter((edge) => edge.source === 'bridge-reconcile')).toEqual([]);
  });

  it('removes stale reconciliation-owned nodes when their pages are deleted', async () => {
    const root = createWikiFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ reconcile: true, output: root, json: true });
    const initialGraph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(initialGraph?.nodes.filter((node) => node.source === 'bridge-reconcile')).toHaveLength(2);
    fs.rmSync(path.join(root, 'teamwiki', 'product', 'login.md'));
    fs.rmSync(path.join(root, 'teamwiki', 'evidence', 'code', 'auth', 'component.md'));

    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(graph?.nodes.filter((node) => node.source === 'bridge-reconcile')).toEqual([]);
  });

  it('preserves a manual mapping with the same endpoints as a generated bridge', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as GraphIndex;
    graph.edges[0].source = 'manual-mapping';
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
    fs.writeFileSync(
      path.join(root, 'teamwiki', 'product', 'login.md'),
      '# Sign In\n\n`LoginService` authenticates users.\n',
    );
    await codebaseCmd({ reconcile: true, output: root, json: true });
    const refreshed = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(refreshed?.nodes).toContainEqual(expect.objectContaining({ slug: 'product/login', title: 'Sign In' }));
    fs.rmSync(path.join(root, 'teamwiki', 'product', 'login.md'));
    await codebaseCmd({ reconcile: true, output: root, json: true });

    const reconciled = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(reconciled?.edges).toContainEqual(expect.objectContaining({ source: 'manual-mapping' }));
    expect(validateGraph(reconciled as GraphIndex)).toEqual({ valid: true, issues: [] });
  });

  it('leaves the existing graph untouched when a page cannot be read', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ reconcile: true, output: root, json: true });
    const originalGraph = fs.readFileSync(graphPath, 'utf8');
    fsFailurePaths.read = path.join(root, 'teamwiki', 'product', 'login.md');

    await expect(codebaseCmd({ reconcile: true, output: root, json: true })).rejects.toThrow('read denied');
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(originalGraph);
  });

  it('leaves the existing graph untouched when a page directory cannot be inspected', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ reconcile: true, output: root, json: true });
    const originalGraph = fs.readFileSync(graphPath, 'utf8');
    fsFailurePaths.stat = path.join(root, 'teamwiki', 'product');

    await expect(codebaseCmd({ reconcile: true, output: root, json: true })).rejects.toThrow('stat denied');
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(originalGraph);
  });

  it('rejects an invalid existing graph without overwriting it', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const invalidGraph = '{"schemaVersion":"wrong","nodes":[],"edges":[]}';
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, invalidGraph);

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(invalidGraph);
    await expect(codebaseCmd({ reconcile: true, output: root })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(invalidGraph);
  });

  it('rejects invalid node metadata without overwriting it', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const invalidGraph = '{"schemaVersion":"team-wiki.graph-index.v1","generatedAt":"bad","nodes":[{"slug":"bad","type":"invalid","confidence":"invalid","title":"Bad"}],"edges":[{"from":"bad","to":"bad","relation":"invalid"}]}';
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, invalidGraph);

    await expect(codebaseCmd({ reconcile: true, output: root })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(invalidGraph);
  });

  it.each([
    ['prototype confidence', { nodes: [{ slug: 'bad', type: 'component', confidence: 'toString', title: 'Bad' }], edges: [] }],
    ['prototype relation', {
      nodes: [
        { slug: 'from', type: 'component', confidence: 'EXTRACTED', title: 'From' },
        { slug: 'to', type: 'component', confidence: 'EXTRACTED', title: 'To' },
      ],
      edges: [{ from: 'from', to: 'to', relation: 'constructor' }],
    }],
  ])('rejects %s metadata without overwriting it', async (_name, contents) => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const invalidGraph = JSON.stringify({
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      ...contents,
    });
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, invalidGraph);

    await expect(codebaseCmd({ reconcile: true, output: root })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(invalidGraph);
  });

  it('normalizes graph variants emitted by legacy aggregation', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const repoGraphPath = path.join(root, 'teamwiki', 'evidence', 'code', 'auth', '.indices', 'graph-index.json');
    const legacyGraph = {
      schemaVersion: 1,
      generatedAt: '2026-01-01',
      nodes: [
        { id: 'a/client', label: 'Client', type: 'module', confidence: 'high' },
      ],
      edges: [{ from: 'a/client', to: 'libs/balance_service.py', relation: 'imports' }],
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fs.mkdirSync(path.dirname(repoGraphPath), { recursive: true });
    fs.writeFileSync(repoGraphPath, JSON.stringify(legacyGraph));
    await aggregateGlobalGraph(path.join(root, 'teamwiki'));

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).resolves.toBeUndefined();
    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(graph?.nodes.map((node) => node.confidence)).toEqual(['EXTRACTED', 'EXTRACTED', 'EXTRACTED', 'EXTRACTED']);
    expect(graph?.nodes).toContainEqual(expect.objectContaining({ slug: 'a/client', type: 'component' }));
    expect(graph?.edges).toContainEqual(expect.objectContaining({ relation: 'DEPENDS_ON', source: 'code-heuristic' }));
  });

  it('repairs missing endpoints from extractor-owned code edges', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const extractorGraph = {
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [
        { slug: 'component/a', title: 'a', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'component/b', title: 'b', type: 'component', confidence: 'EXTRACTED' },
      ],
      edges: [
        { from: 'src/a.ts', to: 'src/b.ts', relation: 'DEPENDS_ON', source: 'code-ast' },
        { from: 'src/a.ts', to: 'component/a', relation: 'REFERENCES', source: 'code-ast' },
      ],
    };
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify(extractorGraph));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(validateGraph(graph as GraphIndex)).toEqual({ valid: true, issues: [] });
    expect(graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'src/a.ts', source: 'code-ast' }),
      expect.objectContaining({ slug: 'src/b.ts', source: 'code-ast' }),
    ]));
  });

  it('replaces legacy bridge edges that upstream persisted without endpoint nodes', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify({
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [],
      edges: [{
        from: 'product/login',
        to: 'evidence/code/auth/component',
        relation: 'MAPS_TO',
        weight: 1,
        source: 'bridge-reconcile',
      }],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ reconcile: true, output: root, json: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(validateGraph(graph as GraphIndex)).toEqual({ valid: true, issues: [] });
    expect(graph?.edges).toContainEqual(expect.objectContaining({
      from: 'product/login',
      to: 'evidence/code/auth/component',
      source: 'bridge-reconcile',
    }));
  });

  it('rejects structural corruption not owned by the extractor', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const invalidGraph = {
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [{ slug: 'manual', title: 'Manual', type: 'component', confidence: 'EXTRACTED' }],
      edges: [{ from: 'manual', to: 'missing', relation: 'MAPS_TO', source: 'manual-mapping' }],
    };
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify(invalidGraph));

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
  });

  it('rejects duplicate persisted nodes before endpoint repair can deduplicate them', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const duplicateGraph = JSON.stringify({
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [
        { slug: 'duplicate', title: 'First', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'duplicate', title: 'Second', type: 'component', confidence: 'EXTRACTED' },
      ],
      edges: [],
    });
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, duplicateGraph);

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    await expect(codebaseCmd({ reconcile: true, output: root })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(duplicateGraph);
  });

  it('rejects duplicate persisted edges before merging can deduplicate them', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const duplicateGraph = JSON.stringify({
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [
        { slug: 'a', title: 'A', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'b', title: 'B', type: 'component', confidence: 'EXTRACTED' },
      ],
      edges: [
        { from: 'a', to: 'b', relation: 'REFERENCES', source: 'manual-mapping' },
        { from: 'a', to: 'b', relation: 'REFERENCES', source: 'doc-semantic' },
      ],
    });
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, duplicateGraph);

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    await expect(codebaseCmd({ reconcile: true, output: root })).rejects.toThrow(
      `Cannot reconcile invalid graph index at ${graphPath}`,
    );
    expect(fs.readFileSync(graphPath, 'utf8')).toBe(duplicateGraph);
  });

  it('does not confuse distinct edge identities containing delimiters', async () => {
    const root = createWikiFixture();
    const graphPath = path.join(root, 'teamwiki', '.indices', 'graph-index.json');
    const graph = {
      schemaVersion: 'team-wiki.graph-index.v1',
      generatedAt: '2026-01-01',
      nodes: [
        { slug: 'a|b', title: 'A pipe B', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'c', title: 'C', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'a', title: 'A', type: 'component', confidence: 'EXTRACTED' },
        { slug: 'b|c', title: 'B pipe C', type: 'component', confidence: 'EXTRACTED' },
      ],
      edges: [
        { from: 'a|b', to: 'c', relation: 'REFERENCES' },
        { from: 'a', to: 'b|c', relation: 'REFERENCES' },
      ],
    };
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify(graph));

    await expect(codebaseCmd({ reconcile: true, output: root, dryRun: true })).resolves.toBeUndefined();
  });

  it('counts distinct mappings whose paths contain delimiters', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-delimiters-'));
    temporaryDirectories.push(root);
    const productDir = path.join(root, 'teamwiki', 'product');
    const codeDir = path.join(root, 'teamwiki', 'evidence', 'code');
    const nestedProduct = path.join(productDir, 'a||evidence', 'code', 'b.md');
    const nestedCode = path.join(codeDir, 'b||evidence', 'code', 'c.md');
    fs.mkdirSync(productDir, { recursive: true });
    fs.mkdirSync(codeDir, { recursive: true });
    fs.mkdirSync(path.dirname(nestedProduct), { recursive: true });
    fs.mkdirSync(path.dirname(nestedCode), { recursive: true });
    fs.writeFileSync(path.join(productDir, 'a.md'), '# A\n\n`ServiceOne` handles A.\n');
    fs.writeFileSync(nestedProduct, '# B\n\n`ServiceTwo` handles B.\n');
    fs.writeFileSync(nestedCode, '# ServiceOne\n\nServiceOne.\n');
    fs.writeFileSync(path.join(codeDir, 'c.md'), '# ServiceTwo\n\nServiceTwo.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ reconcile: true, output: root, dryRun: true, json: true });

    const result = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(result.graphEdges).toHaveLength(2);
    expect(result.mappings).toBe(2);
  });

  it('reconciles a graph containing an extractor-generated same-file IMPLEMENTS self-loop (#475)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-self-loop-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'teamwiki', 'product'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'auth.ts'),
      'export interface AuthService { login(): void; }\nexport class LocalAuth implements AuthService { login(): void {} }\n',
    );
    fs.writeFileSync(path.join(root, 'teamwiki', 'product', 'auth.md'), '# Auth\nUse `AuthService` for login.\n');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ extract: root, project: 'auth', json: true });
    const extracted = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(extracted?.edges).toContainEqual(
      expect.objectContaining({ from: 'src/auth.ts', to: 'src/auth.ts', relation: 'IMPLEMENTS', source: 'code-ast' }),
    );

    await expect(codebaseCmd({ reconcile: true, output: root, json: true })).resolves.toBeUndefined();

    const reconciled = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(reconciled?.edges).toContainEqual(
      expect.objectContaining({ from: 'src/auth.ts', to: 'src/auth.ts', relation: 'IMPLEMENTS' }),
    );
  });
});
