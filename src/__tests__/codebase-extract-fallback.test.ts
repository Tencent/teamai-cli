import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the AI client so extract/deep-enrich cannot hang on a live CLI.
vi.mock('../utils/ai-client.js', () => ({
  getAICliName: () => 'mock-cli',
  callClaude: vi.fn(async () => {
    throw new Error('mock: AI unavailable');
  }),
  callClaudeParallel: vi.fn(async () => {
    throw new Error('mock: AI batch unavailable');
  }),
}));

import { callClaudeParallel } from '../utils/ai-client.js';
import { extractCodebase } from '../codebase-extract.js';
import { repoIdentity } from '../utils/git.js';
import { codebaseCmd } from '../codebase-cmd.js';
import { runHiddenDeepEnrich } from '../deep-enrich.js';
import { scopeGlobalGraph } from '../graph-aggregate.js';
import { loadGraphIndex } from '../wiki-engine/core/graph-index.schema.js';
import {
  buildFallbackManifest,
  describeEvidenceManifest,
  groupFactsByModule,
} from '../enrich-with-ai.js';
import type { CodeFact } from '../wiki-engine/code-knowledge/code-extractors.js';

const temporaryDirectories: string[] = [];

const WIDGET_SOURCE = 'export class Widget {\n  render() { return "hi"; }\n}\n';

function createWidgetFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'widget.ts'), WIDGET_SOURCE);
  return root;
}

function initializeGit(root: string, remote: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root, stdio: 'ignore' });
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readEvidenceManifest(root: string, project: string): {
  schemaVersion?: string;
  components: Array<{ slug?: string; docPath?: string; category?: string; responsibilities?: string[] }>;
} {
  const manifestPath = path.join(root, 'teamwiki', 'evidence', 'code', project, '_manifest.json');
  expect(fs.existsSync(manifestPath), `missing ${manifestPath}`).toBe(true);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    schemaVersion?: string;
    components: Array<{ slug?: string; docPath?: string; category?: string; responsibilities?: string[] }>;
  };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('extract writes a fallback evidence manifest (#508)', () => {
  it('describes fallback and missing-manifest outcomes in English', () => {
    expect(describeEvidenceManifest('fallback', 1)).toBe(
      'Wrote fallback _manifest.json (1 component, no AI enrich)',
    );
    expect(describeEvidenceManifest('fallback', 2)).toBe(
      'Wrote fallback _manifest.json (2 components, no AI enrich)',
    );
    expect(describeEvidenceManifest('none', 0)).toBe(
      'AI enrich produced no manifest; deep-enrich will have no components',
    );
    expect(describeEvidenceManifest('ai', 3)).toBeUndefined();
  });

  it('builds fallback components from top-level modules, then component facts', () => {
    const moduleFacts: CodeFact[] = [
      {
        kind: 'component',
        name: 'Widget',
        file: 'src/widget.ts',
        lineStart: 1,
        detail: 'export class Widget',
        confidence: 'EXTRACTED',
      },
    ];
    const fromModules = buildFallbackManifest({
      project: 'widget',
      facts: moduleFacts,
      modules: groupFactsByModule(moduleFacts),
    });
    expect(fromModules?.components).toEqual([
      expect.objectContaining({
        slug: 'src',
        docPath: 'evidence/code/widget/src.md',
      }),
    ]);

    const rootFacts: CodeFact[] = [
      {
        kind: 'component',
        name: 'Widget',
        file: 'widget.ts',
        lineStart: 1,
        detail: 'export class Widget',
        confidence: 'EXTRACTED',
      },
    ];
    // Force the component-name path: empty modules, leftover component facts.
    const fromNames = buildFallbackManifest({
      project: 'widget',
      facts: rootFacts,
      modules: new Map(),
    });
    expect(fromNames?.components).toEqual([
      expect.objectContaining({
        slug: 'Widget',
        docPath: 'evidence/code/widget/Widget.md',
      }),
    ]);

    expect(buildFallbackManifest({ project: 'widget', facts: [], modules: new Map() })).toBeNull();
  });

  it('writes _manifest.json with components for the offline Widget fixture', async () => {
    const root = createWidgetFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true });

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      facts: { byKind: Record<string, number> };
      manifest: { written: boolean; source: string; components: number; note?: string };
    };
    expect(report.facts.byKind.component).toBeGreaterThanOrEqual(1);
    expect(report.manifest.written).toBe(true);
    expect(report.manifest.source).toBe('fallback');
    expect(report.manifest.components).toBeGreaterThanOrEqual(1);
    expect(report.manifest.note).toMatch(/Wrote fallback _manifest\.json/);
    expect(report.manifest.note).toMatch(/no AI enrich/);

    expect(fs.existsSync(path.join(root, 'teamwiki', 'source-manifest.json'))).toBe(true);

    const manifest = readEvidenceManifest(root, 'widget');
    expect(manifest.schemaVersion).toBe('team-wiki.codebase-output-manifest.v2');
    expect(manifest.components.length).toBeGreaterThanOrEqual(1);
    for (const component of manifest.components) {
      expect(component.slug).toEqual(expect.any(String));
      expect(component.slug?.length).toBeGreaterThan(0);
      expect(component.docPath).toEqual(expect.any(String));
      expect(component.docPath?.length).toBeGreaterThan(0);
    }
  });

  it('writes the same fallback when --skip-enrich is set', async () => {
    const root = createWidgetFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      manifest: { written: boolean; source: string; components: number; note?: string };
    };
    expect(report.manifest).toMatchObject({ written: true, source: 'fallback' });
    expect(report.manifest.components).toBeGreaterThanOrEqual(1);
    expect(report.manifest.note).toMatch(/Wrote fallback _manifest\.json/);

    const manifest = readEvidenceManifest(root, 'widget');
    expect(manifest.components.length).toBeGreaterThanOrEqual(1);
    expect(manifest.components[0]?.slug).toBeTruthy();
    expect(manifest.components[0]?.docPath).toBeTruthy();
  });

  it('stores a credential-free per-codebase baseline for subdirectory extracts and refreshes it fully', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-manifest-repo-'));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-manifest-output-'));
    temporaryDirectories.push(repo, output);
    const sourceRoot = path.join(repo, 'packages', 'api');
    const sourceFile = path.join(sourceRoot, 'src', 'auth.ts');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    const original = 'export const token = "before";\n';
    fs.writeFileSync(sourceFile, original);
    const remote = 'https://alice:secret-token@github.com/acme/orders.git';
    initializeGit(repo, remote);

    await extractCodebase({ path: sourceRoot, outputRoot: output, project: 'orders-api', json: true, skipEnrich: true });

    const wikiRoot = path.join(output, 'teamwiki');
    const projectManifestPath = path.join(wikiRoot, 'evidence', 'code', 'orders-api', 'source-manifest.json');
    const first = JSON.parse(fs.readFileSync(projectManifestPath, 'utf8')) as {
      project: string;
      repoUrl: string;
      repoIdentity: string;
      sourceSubdir: string;
      files: Array<{ relativePath: string; sha256: string }>;
    };
    expect(first).toMatchObject({
      project: 'orders-api',
      repoIdentity: repoIdentity('https://github.com/acme/orders.git'),
      sourceSubdir: 'packages/api',
      files: [{ relativePath: 'src/auth.ts', sha256: hashText(original) }],
    });
    expect(first.repoUrl).not.toContain('alice');
    expect(first.repoUrl).not.toContain('secret-token');
    expect(JSON.parse(fs.readFileSync(path.join(wikiRoot, 'source-manifest.json'), 'utf8'))).toEqual(first);

    const changed = 'export const token = "after";\n';
    fs.writeFileSync(sourceFile, changed);
    await extractCodebase({
      path: sourceRoot,
      outputRoot: output,
      project: 'orders-api',
      json: true,
      skipEnrich: true,
      incremental: true,
    });

    const refreshed = JSON.parse(fs.readFileSync(projectManifestPath, 'utf8')) as typeof first;
    expect(refreshed.files).toEqual([{ relativePath: 'src/auth.ts', sha256: hashText(changed), language: 'typescript' }]);
  });

  it('does not mix another repository manifest or facts cache into incremental extraction', async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-multi-source-output-'));
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-a-'));
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-b-'));
    temporaryDirectories.push(output, repoA, repoB);
    const fileA = 'export class Alpha { value() { return "a"; } }\n';
    const fileB = 'export class Beta { value() { return "b"; } }\n';
    fs.mkdirSync(path.join(repoA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoB, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoA, 'src', 'a.ts'), fileA);
    fs.writeFileSync(path.join(repoB, 'src', 'b.ts'), fileB);
    initializeGit(repoA, 'https://github.com/acme/repo-a.git');
    initializeGit(repoB, 'https://github.com/acme/repo-b.git');

    await extractCodebase({ path: repoA, outputRoot: output, project: 'repo-a', json: true, skipEnrich: true });
    await extractCodebase({ path: repoB, outputRoot: output, project: 'repo-b', json: true, skipEnrich: true });
    const changedA = 'export class Alpha { value() { return "updated"; } }\n';
    fs.writeFileSync(path.join(repoA, 'src', 'a.ts'), changedA);
    await extractCodebase({
      path: repoA,
      outputRoot: output,
      project: 'repo-a',
      json: true,
      skipEnrich: true,
      incremental: true,
    });

    const wikiRoot = path.join(output, 'teamwiki');
    const manifest = JSON.parse(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', 'repo-a', 'source-manifest.json'), 'utf8')) as {
      files: Array<{ relativePath: string; sha256: string }>;
    };
    expect(manifest.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(manifest.files[0]?.sha256).toBe(hashText(changedA));
    const cachedFacts = JSON.parse(fs.readFileSync(path.join(wikiRoot, '.indices', 'facts-cache.json'), 'utf8')) as Array<{ file: string }>;
    expect(new Set(cachedFacts.map((fact) => fact.file))).toEqual(new Set(['src/a.ts']));
  });

  it('treats malformed repository metadata as an unavailable incremental baseline', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-malformed-source-repo-'));
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-malformed-source-output-'));
    temporaryDirectories.push(repo, output);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export class App {}\n');
    initializeGit(repo, 'https://github.com/acme/malformed.git');
    const wikiRoot = path.join(output, 'teamwiki');
    fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', 'malformed'), { recursive: true });
    const malformed = { project: 'malformed', repoUrl: 42, repoIdentity: null, sourceSubdir: '', files: [] };
    fs.writeFileSync(path.join(wikiRoot, 'source-manifest.json'), JSON.stringify(malformed));
    fs.writeFileSync(path.join(wikiRoot, 'evidence', 'code', 'malformed', 'source-manifest.json'), JSON.stringify(malformed));

    await expect(extractCodebase({
      path: repo,
      outputRoot: output,
      project: 'malformed',
      json: true,
      skipEnrich: true,
      incremental: true,
    })).resolves.toBeUndefined();

    const refreshed = JSON.parse(fs.readFileSync(path.join(wikiRoot, 'source-manifest.json'), 'utf8')) as {
      repoIdentity?: string;
      files?: Array<{ relativePath: string }>;
    };
    expect(refreshed.repoIdentity).toBe(repoIdentity('https://github.com/acme/malformed.git'));
    expect(refreshed.files?.map((file) => file.relativePath)).toEqual(['src/app.ts']);
  });

  it('refuses to write codebase sidecars through an evidence directory junction outside teamwiki', async ({ skip }) => {
    const source = createWidgetFixture();
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sidecar-output-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sidecar-outside-'));
    temporaryDirectories.push(output, outside);
    await extractCodebase({ path: source, outputRoot: output, project: 'widget', json: true, skipEnrich: true });

    const evidenceDir = path.join(output, 'teamwiki', 'evidence', 'code', 'widget');
    fs.rmSync(evidenceDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, evidenceDir, 'junction');
    } catch {
      skip();
      return;
    }

    await expect(extractCodebase({
      path: source,
      outputRoot: output,
      project: 'widget',
      json: true,
      skipEnrich: true,
    })).rejects.toThrow(/Path traversal detected/);
    expect(fs.existsSync(path.join(outside, 'overview.md'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'source-manifest.json'))).toBe(false);
  });

  it('writes a fallback when AI enrich is attempted and fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-ai-fail-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      [
        'export class Alpha { a() { return 1; } }',
        'export class Beta { b() { return 2; } }',
        'export class Gamma { c() { return 3; } }',
        'export class Delta { d() { return 4; } }',
        'export class Epsilon { e() { return 5; } }',
        '',
      ].join('\n'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true });

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      manifest: { written: boolean; source: string; components: number; note?: string };
    };
    expect(report.manifest.written).toBe(true);
    expect(report.manifest.source).toBe('fallback');
    expect(report.manifest.note).toMatch(/Wrote fallback _manifest\.json/);
    expect(readEvidenceManifest(root, 'widget').components.length).toBeGreaterThanOrEqual(1);
  });

  it('prints English fallback text when not using --json', async () => {
    const root = createWidgetFixture();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await extractCodebase({ path: root, project: 'widget' });

    const output = lines.join('\n');
    expect(output).toMatch(/\[extract\] widget complete/);
    expect(output).toMatch(/Wrote fallback _manifest\.json/);
    expect(output).toMatch(/no AI enrich/);
    expect(output).not.toMatch(/AI enrich produced no manifest; deep-enrich will have no components/);
  });

  it('does not abort deep-enrich for empty evidence after a successful extract', async () => {
    const root = createWidgetFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });
    process.exitCode = undefined;

    await codebaseCmd({ deepEnrich: true, project: 'widget', output: root, json: true });

    const output = vi.mocked(console.log).mock.calls.flat().map(String).join('\n');
    expect(output).not.toMatch(/No components in evidence/);
    expect(output).not.toMatch(/No components in _manifest\.json/);
    expect(output).not.toMatch(/Run `teamai codebase --extract` first/);

    const lastJson = [...vi.mocked(console.log).mock.calls]
      .map(call => String(call[0]))
      .reverse()
      .find(text => text.trim().startsWith('{'));
    expect(lastJson).toBeTruthy();
    const report = JSON.parse(lastJson!) as { complete?: boolean; missingComponents?: string[] };
    expect(report.complete).toBe(false);
    expect(report.missingComponents?.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it('hidden deep-enrich after extract does not abort for missing components', async () => {
    const root = createWidgetFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });
    process.exitCode = undefined;

    const result = await runHiddenDeepEnrich({
      project: 'widget',
      wikiRoot: path.join(root, 'teamwiki'),
    });

    expect(result.complete).toBe(false);
    expect(result.missingComponents.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it('does not overwrite a successful AI enrich with the fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-ai-ok-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'app.ts'),
      [
        'export class Alpha { a() { return 1; } }',
        'export class Beta { b() { return 2; } }',
        'export class Gamma { c() { return 3; } }',
        'export class Delta { d() { return 4; } }',
        'export class Epsilon { e() { return 5; } }',
        '',
      ].join('\n'),
    );
    vi.mocked(callClaudeParallel).mockImplementation(async (tasks) =>
      tasks.map((task) =>
        task.parse(
          '{"domain":"widgets","responsibilities":["render"],"layer":"service","summary":"ui","description":"ui kit","keywords":["widget"]}',
        ),
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'widget', json: true });

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      manifest: { written: boolean; source: string; note?: string };
    };
    expect(report.manifest.written).toBe(true);
    expect(report.manifest.source).toBe('ai');
    expect(report.manifest.note).toBeUndefined();

    const manifest = readEvidenceManifest(root, 'widget');
    expect(manifest.components.length).toBeGreaterThanOrEqual(1);
    expect(manifest.components[0]?.category).toBe('service');
    expect(manifest.components[0]?.responsibilities).toEqual(['render']);
  });

  it('says so when extractable files yield no components to put in a manifest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-none-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'empty.ts'), '// no extractable symbols\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await extractCodebase({ path: root, project: 'empty', json: true, skipEnrich: true });

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      status?: string;
      facts?: { total: number };
      manifest?: { written: boolean; source: string; note?: string };
    };
    expect(report.status).not.toBe('no-files');
    expect(report.facts?.total ?? 0).toBe(0);
    expect(report.manifest).toMatchObject({ written: false, source: 'none' });
    expect(report.manifest?.note).toBe('AI enrich produced no manifest; deep-enrich will have no components');
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'empty', '_manifest.json'))).toBe(false);
  });
});

describe('a direct `teamai codebase --extract` stamps origin on the graph it writes (#974 review round 19 P1)', () => {
  it('tags every node and edge it writes straight to teamwiki/.indices/graph-index.json with the project slug', async () => {
    const root = createWidgetFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // A standalone extract (no `teamai import`) writes directly to the real
    // teamwiki root's global graph file — there is no later
    // aggregateGlobalGraph call to tag it, since this bypasses import's
    // orchestration entirely.
    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    const graph = await loadGraphIndex(path.join(root, 'teamwiki'));
    expect(graph?.nodes.length).toBeGreaterThan(0);
    for (const node of graph?.nodes ?? []) expect(node.origin).toBe('widget');
    for (const edge of graph?.edges ?? []) expect(edge.origin).toBe('widget');
  });

  it("lets scopeGlobalGraph withhold the freshly re-extracted content correctly even though the project's own evidence/code/widget/.indices/graph-index.json per-repo file was never touched by this direct extract and stays stale", async () => {
    const root = createWidgetFixture();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Simulate a stale per-repo file left over from an earlier `teamai
    // import` run, describing different (older) content than what this
    // direct re-extraction is about to write to the global graph.
    const staleRepoGraphDir = path.join(root, 'teamwiki', 'evidence', 'code', 'widget', '.indices');
    fs.mkdirSync(staleRepoGraphDir, { recursive: true });
    fs.writeFileSync(path.join(staleRepoGraphDir, 'graph-index.json'), JSON.stringify({
      schemaVersion: 1, generatedAt: '2025-01-01',
      nodes: [{ slug: 'old/stale-component', title: 'StaleComponent', type: 'component', confidence: 'high' }],
      edges: [],
    }));

    await extractCodebase({ path: root, project: 'widget', json: true, skipEnrich: true });

    const scoped = await scopeGlobalGraph(path.join(root, 'teamwiki'), new Set(['widget']));
    // Fully tag-covered by the fresh extract's own origin stamps — the
    // stale per-repo file is never even read for this.
    expect(scoped?.nodes ?? []).toHaveLength(0);
    expect(scoped?.edges ?? []).toHaveLength(0);
  });
});
