import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The fallback manifest itself needs no AI at all, but `deep-enrich` does call
// out to the CLI. Make those calls fail instantly so the integration cases
// assert on the manifest plumbing instead of waiting on real 600s timeouts.
vi.mock('../utils/ai-client.js', () => ({
  getAICliName: () => 'mock-cli',
  callClaude: vi.fn(async () => {
    throw new Error('mock: AI unavailable');
  }),
  callClaudeParallel: vi.fn(async () => {
    throw new Error('mock: AI batch unavailable');
  }),
}));

import { buildFallbackManifest } from '../enrich-with-ai.js';
import { codebaseCmd } from '../codebase-cmd.js';
import { extractCodebase } from '../codebase-extract.js';
import type { CodeFact } from '../wiki-engine/adapters/index.js';

const temporaryDirectories: string[] = [];

function fact(partial: Partial<CodeFact> & Pick<CodeFact, 'kind' | 'file'>): CodeFact {
  return {
    name: 'Widget',
    lineStart: 1,
    detail: '',
    confidence: 'EXTRACTED',
    ...partial,
  };
}

/** A one-file repo: a single component fact, so no module reaches the 5-fact threshold. */
function createSmallRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-extract-fallback-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'widget.ts'),
    'export class Widget {\n  render() { return "hi"; }\n}\n',
  );
  return root;
}

function manifestPathFor(root: string, project: string): string {
  return path.join(root, 'teamwiki', 'evidence', 'code', project, '_manifest.json');
}

/** Silence the CLI and return a joined view of everything it printed. */
function captureOutput() {
  const calls: string[] = [];
  const record = (...args: unknown[]) => {
    calls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return () => calls.join('\n');
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('buildFallbackManifest', () => {
  it('derives one component per module that has a component fact', () => {
    const manifest = buildFallbackManifest('proj', [
      fact({ kind: 'component', file: 'src/widget.ts', name: 'Widget' }),
      fact({ kind: 'component', file: 'src/button.ts', name: 'Button' }),
      fact({ kind: 'component', file: 'lib/util.ts', name: 'Util' }),
    ]);

    expect(manifest.schemaVersion).toBe('team-wiki.codebase-output-manifest.v2');
    expect(manifest.project).toBe('proj');
    expect(manifest.edges).toEqual([]);
    expect(manifest.components.map((c) => c.slug)).toEqual(['src', 'lib']);
  });

  it('deduplicates modules that appear in several component facts', () => {
    const manifest = buildFallbackManifest('proj', [
      fact({ kind: 'component', file: 'src/a.ts' }),
      fact({ kind: 'component', file: 'src/b.ts' }),
      fact({ kind: 'component', file: 'src/c.ts' }),
    ]);

    expect(manifest.components.map((c) => c.slug)).toEqual(['src']);
  });

  it('maps a file with no directory to the _root module', () => {
    const manifest = buildFallbackManifest('proj', [fact({ kind: 'component', file: 'index.ts' })]);

    expect(manifest.components.map((c) => c.slug)).toEqual(['_root']);
  });

  it('ignores facts that are not components', () => {
    const manifest = buildFallbackManifest('proj', [
      fact({ kind: 'interface', file: 'src/api.ts' }),
      fact({ kind: 'relation', file: 'src/widget.ts' }),
      fact({ kind: 'config', file: 'src/config.ts' }),
    ]);

    expect(manifest.components).toEqual([]);
  });

  it('produces schema-conformant components', () => {
    const [component] = buildFallbackManifest('proj', [
      fact({ kind: 'component', file: 'src/widget.ts' }),
    ]).components;

    expect(component).toEqual({
      slug: 'src',
      docPath: 'evidence/code/proj/src.md',
      title: 'src',
      category: 'unknown',
      confidence: 'EXTRACTED',
    });
  });

  it('stamps a parseable generatedAt', () => {
    const { generatedAt } = buildFallbackManifest('proj', []);

    expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
  });
});

describe('extract gives deep-enrich something to work with', () => {
  it('writes a minimal _manifest.json when no module reaches the 5-fact threshold', async () => {
    const root = createSmallRepo();
    captureOutput();

    await codebaseCmd({ extract: root, project: 'widget', output: root, json: true });

    const manifestPath = manifestPathFor(root, 'widget');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      components: Array<{ slug: string }>;
    };
    expect(manifest.components.map((c) => c.slug)).toEqual(['src']);
  });

  it('also writes it when enrichment is skipped (import --skip-enrich)', async () => {
    const root = createSmallRepo();
    captureOutput();

    await extractCodebase({ path: root, project: 'widget', skipEnrich: true, json: true });

    expect(fs.existsSync(manifestPathFor(root, 'widget'))).toBe(true);
  });

  it('no longer aborts deep-enrich with "No components"', async () => {
    const root = createSmallRepo();
    const output = captureOutput();

    await codebaseCmd({ extract: root, project: 'widget', output: root, json: true });
    await codebaseCmd({ deepEnrich: true, project: 'widget', output: root, json: true });

    expect(output()).not.toContain('No components');
  });

  it('does not invent a manifest when there is nothing to describe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-extract-empty-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'notes.ts'), '// nothing but a comment\n');
    captureOutput();

    await codebaseCmd({ extract: root, project: 'emptyproj', output: root, json: true });

    expect(fs.existsSync(manifestPathFor(root, 'emptyproj'))).toBe(false);
  });
});
