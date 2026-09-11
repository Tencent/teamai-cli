import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { codebaseCmd } from '../codebase-cmd.js';
import { runHiddenDeepEnrich } from '../deep-enrich.js';
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
