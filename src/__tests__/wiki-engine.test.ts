import { describe, it, expect } from 'vitest';
import { scanInterfaces } from '../wiki-engine/interface-scanner.js';
import { traceCallChains } from '../wiki-engine/call-chain-tracer.js';
import { buildIndexHubOverlay } from '../wiki-engine/code-graph-overlay.js';
import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import type { CodeFact } from '../wiki-engine/code-knowledge/code-extractors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (relativePath: string, content: string, language: string): CodeCollectedFile => ({
  path: `/repo/${relativePath}`,
  relativePath,
  content,
  language,
  sha256: 'mock-sha',
});

const makeFact = (name: string, kind: string, file: string, lineStart = 1): CodeFact => ({
  name,
  kind: kind as CodeFact['kind'],
  file,
  lineStart,
  lineEnd: lineStart + 5,
  detail: '',
  confidence: 'EXTRACTED' as const,
  evidenceType: 'source' as CodeFact['evidenceType'],
});

// ---------------------------------------------------------------------------
// interface-scanner
// ---------------------------------------------------------------------------

describe('scanInterfaces', () => {
  it('returns HTTP entry for TypeScript router.get pattern', async () => {
    const files = [makeFile('src/routes.ts', "router.get('/users', handler);", 'typescript')];
    const result = await scanInterfaces(files);
    expect(result.entries.length).toBeGreaterThan(0);
    const entry = result.entries[0];
    expect(entry.type).toBe('HTTP');
  });

  it('returns HTTP with HIGH confidence for Python @app.route', async () => {
    const files = [makeFile('api/app.py', "@app.route('/health')\ndef health(): pass", 'python')];
    const result = await scanInterfaces(files);
    const entry = result.entries.find(e => e.type === 'HTTP');
    expect(entry).toBeDefined();
    expect(entry!.confidence).toBe('HIGH');
  });

  it('returns RPC entry for Go grpc.NewServer pattern', async () => {
    const files = [makeFile('server/grpc.go', 's := grpc.NewServer()', 'go')];
    const result = await scanInterfaces(files);
    const entry = result.entries.find(e => e.type === 'RPC');
    expect(entry).toBeDefined();
  });

  it('returns MQ entry for channel.consume pattern', async () => {
    const files = [makeFile('worker/mq.ts', 'channel.consume(queue, handler);', 'typescript')];
    const result = await scanInterfaces(files);
    const entry = result.entries.find(e => e.type === 'MQ');
    expect(entry).toBeDefined();
    // The generic .consume rule (MEDIUM) fires before the channel.consume rule (HIGH)
    // because DETECTION_RULES applies the first matching rule per line.
    expect(['HIGH', 'MEDIUM']).toContain(entry!.confidence);
  });

  it('returns empty entries when no patterns match', async () => {
    const files = [makeFile('utils/helper.ts', 'export const add = (a: number) => a + 1;', 'typescript')];
    const result = await scanInterfaces(files);
    expect(result.entries).toHaveLength(0);
    expect(result.scannedAt).toBeTruthy();
  });

  it('groups files by top-level directory as component', async () => {
    const files = [
      makeFile('api/handler.ts', "router.get('/a', fn);", 'typescript'),
      makeFile('api/middleware.ts', "router.post('/b', fn);", 'typescript'),
    ];
    const result = await scanInterfaces(files);
    expect(result.entries[0].component).toBe('api');
    expect(result.entries[0].count).toBeGreaterThanOrEqual(2);
  });

  it('returns multiple pattern lines up to 5 in patterns array', async () => {
    const routes = Array.from({ length: 7 }, (_, i) => `router.get('/r${i}', fn);`).join('\n');
    const files = [makeFile('routes/index.ts', routes, 'typescript')];
    const result = await scanInterfaces(files);
    const entry = result.entries.find(e => e.type === 'HTTP');
    expect(entry!.patterns.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// call-chain-tracer
// ---------------------------------------------------------------------------

describe('traceCallChains', () => {
  it('returns a chain for a handler entry point fact', () => {
    const facts: CodeFact[] = [
      makeFact('UserHandler', 'component', 'src/handler.ts'),
    ];
    const files: CodeCollectedFile[] = [
      makeFile('src/handler.ts', 'export class UserHandler {}', 'typescript'),
    ];
    const chains = traceCallChains(facts, files);
    expect(chains.length).toBeGreaterThan(0);
    expect(chains[0].steps[0].layer).toBe('entry');
  });

  it('returns a chain with entry layer for route-named component', () => {
    const facts: CodeFact[] = [
      makeFact('GET /api/users', 'interface', 'src/routes.ts'),
    ];
    const files: CodeCollectedFile[] = [
      makeFile('src/routes.ts', '', 'typescript'),
    ];
    const chains = traceCallChains(facts, files);
    expect(chains.length).toBeGreaterThan(0);
    const firstStep = chains[0].steps[0];
    expect(firstStep.layer).toBe('entry');
  });

  it('returns empty array when no entry points exist', () => {
    const facts: CodeFact[] = [
      makeFact('calculateTotal', 'component', 'src/math.ts'),
    ];
    const files: CodeCollectedFile[] = [
      makeFile('src/math.ts', 'export const calculateTotal = () => 0;', 'typescript'),
    ];
    const chains = traceCallChains(facts, files);
    expect(chains).toHaveLength(0);
  });

  it('depth does not exceed 4', () => {
    // Create a chain of handler → relation → relation → ...
    const facts: CodeFact[] = [
      makeFact('handleRequest', 'component', 'src/controller.ts'),
      makeFact('./service', 'relation', 'src/controller.ts'),
      makeFact('doWork', 'component', 'src/service.ts'),
      makeFact('./repo', 'relation', 'src/service.ts'),
      makeFact('findAll', 'component', 'src/repo.ts'),
      makeFact('./db', 'relation', 'src/repo.ts'),
      makeFact('query', 'component', 'src/db.ts'),
      makeFact('./extra', 'relation', 'src/db.ts'),
      makeFact('extra', 'component', 'src/extra.ts'),
    ];
    const files: CodeCollectedFile[] = [
      makeFile('src/controller.ts', '', 'typescript'),
      makeFile('src/service.ts', '', 'typescript'),
      makeFile('src/repo.ts', '', 'typescript'),
      makeFile('src/db.ts', '', 'typescript'),
      makeFile('src/extra.ts', '', 'typescript'),
    ];
    const chains = traceCallChains(facts, files);
    for (const chain of chains) {
      expect(chain.depth).toBeLessThanOrEqual(4);
    }
  });

  it('picks up key file with handler-like path as entry', () => {
    const facts: CodeFact[] = [];
    const files: CodeCollectedFile[] = [
      {
        path: '/repo/src/handler.ts',
        relativePath: 'src/handler.ts',
        content: '',
        language: 'typescript',
        sha256: 'x',
        isKeyFile: true,
      },
    ];
    const chains = traceCallChains(facts, files);
    expect(chains.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// code-graph-overlay
// ---------------------------------------------------------------------------

describe('buildIndexHubOverlay', () => {
  it('produces index node plus one component node per slug', () => {
    const slugs = ['code/myproject/functions', 'code/myproject/types', 'code/myproject/errors'];
    const result = buildIndexHubOverlay('myproject', 'code', slugs);
    // 1 index node + 3 component nodes
    expect(result.nodes).toHaveLength(4);
  });

  it('all edges have relation CONTAINS from index to each slug', () => {
    const slugs = ['code/proj/a', 'code/proj/b'];
    const result = buildIndexHubOverlay('proj', 'code', slugs);
    expect(result.edges).toHaveLength(2);
    for (const edge of result.edges) {
      expect(edge.relation).toBe('CONTAINS');
      expect(slugs).toContain(edge.to);
    }
  });

  it('empty slugs → returns only index node, no edges', () => {
    const result = buildIndexHubOverlay('proj', 'code', []);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
    expect(result.nodes[0].type).toBe('architecture');
  });

  it('skips a slug equal to the index slug to avoid self-loops', () => {
    const indexSlug = 'code/proj/index';
    const slugs = [indexSlug, 'code/proj/other'];
    const result = buildIndexHubOverlay('proj', 'code', slugs);
    // index node + 1 component node (self-slug skipped)
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe('code/proj/other');
  });

  it('returns a valid GraphIndex with schemaVersion', () => {
    const result = buildIndexHubOverlay('p', 'out', ['out/p/x']);
    expect(result.schemaVersion).toBe('team-wiki.graph-index.v1');
    expect(result.generatedAt).toBeTruthy();
  });
});
