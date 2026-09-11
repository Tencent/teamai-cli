import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the AI client so deepEnrich's LLM calls fail instantly instead of
// waiting on real 600s timeouts. deepEnrich treats these as non-blocking skips.
vi.mock('../utils/ai-client.js', () => ({
  getAICliName: () => 'mock-cli',
  callClaude: vi.fn(async () => {
    throw new Error('mock: AI unavailable');
  }),
  callClaudeParallel: vi.fn(async () => {
    throw new Error('mock: AI batch unavailable');
  }),
}));

import { callClaude, callClaudeParallel } from '../utils/ai-client.js';
import { codebaseCmd } from '../codebase-cmd.js';

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

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({
      project: 'faketest',
      complete: false,
      missingComponents: ['Auth'],
      missingArchitecture: true,
    });

    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    expect(fs.existsSync(path.join(docsDir, 'graph-g1-relations.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'graph-g2-dataflow.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'graph-g3-interfaces.md'))).toBe(true);
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8').length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
  });

  it('does not report success when the evidence dir has no components', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-empty-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest'), { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('No components in evidence');
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs'))).toBe(false);
  });

  it('previews without writing when --dry-run is set', async () => {
    const root = createEnrichFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true, dryRun: true });

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      project: 'faketest',
      dryRun: true,
    });
    expect(fs.existsSync(path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs'))).toBe(false);
  });

  it('retries missing AI docs after recovery without wiping graph docs', async () => {
    const root = createEnrichFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });
    expect(process.exitCode).toBe(1);
    const first = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(first).toMatchObject({ complete: false, missingComponents: ['Auth'], missingArchitecture: true });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
    const graphBefore = fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8');

    process.exitCode = undefined;
    vi.mocked(callClaude).mockResolvedValue('# Architecture\n\nAuth sits at the edge.\n');
    vi.mocked(callClaudeParallel).mockImplementation(async (tasks) => (
      tasks.map(() => '# Auth\n\nAuthenticates users.\n')
    ));

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBeUndefined();
    const recovered = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(recovered).toMatchObject({ complete: true, missingComponents: [], missingArchitecture: false });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toContain('Authenticates users');
    expect(fs.readFileSync(path.join(docsDir, 'architecture.md'), 'utf8')).toContain('Auth sits at the edge');
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8')).toBe(graphBefore);

    process.exitCode = undefined;
    vi.mocked(callClaude).mockRejectedValue(new Error('mock: AI unavailable'));
    vi.mocked(callClaudeParallel).mockRejectedValue(new Error('mock: AI batch unavailable'));
    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ complete: true });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toContain('Authenticates users');
    expect(fs.readFileSync(path.join(docsDir, 'architecture.md'), 'utf8')).toContain('Auth sits at the edge');
  });

  it('preserves a completed component doc when architecture generation still fails', async () => {
    const root = createEnrichFixture();
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'Auth.md'), '# Auth\n\nKeep me.\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      complete: false,
      missingComponents: [],
      missingArchitecture: true,
    });
    expect(fs.readFileSync(path.join(docsDir, 'Auth.md'), 'utf8')).toBe('# Auth\n\nKeep me.\n');
    expect(fs.existsSync(path.join(docsDir, 'graph-g1-relations.md'))).toBe(true);
  });

  it('still reports remaining missing AI work when a later retry also fails', async () => {
    const root = createEnrichFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const docsDir = path.join(root, 'teamwiki', 'evidence', 'code', 'faketest', 'docs');

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).complete).toBe(false);
    const graphBefore = fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8');

    process.exitCode = undefined;
    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    const second = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(second).toMatchObject({
      complete: false,
      missingComponents: ['Auth'],
      missingArchitecture: true,
    });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
    expect(fs.readFileSync(path.join(docsDir, 'graph-g1-relations.md'), 'utf8')).toBe(graphBefore);

    process.exitCode = undefined;
    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root });
    const text = log.mock.calls.flat().map(String).join('\n');
    expect(text).toContain('Deep enrichment incomplete');
    expect(text).toContain('missing component docs: Auth');
    expect(text).toContain('missing architecture.md');
    expect(text).not.toMatch(/Deep enrichment complete: project=faketest/);
    expect(process.exitCode).toBe(1);
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

    vi.mocked(callClaude).mockResolvedValue('# NEW architecture\n');
    vi.mocked(callClaudeParallel).mockImplementation(async (tasks) => (
      tasks.map(() => '# NEW Auth\n')
    ));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ complete: true });
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

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await codebaseCmd({ deepEnrich: true, project: 'faketest', output: root, json: true });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      complete: false,
      missingComponents: ['Auth'],
      missingArchitecture: true,
    });
    expect(fs.existsSync(path.join(docsDir, 'Auth.md'))).toBe(false);
    expect(fs.existsSync(path.join(docsDir, 'architecture.md'))).toBe(false);
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
