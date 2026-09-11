import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

function runCLI(args: string[], cwd: string = ROOT): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

describe('teamai codebase extract CLI (issue #360 slice 1)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  it('lists --extract on teamai codebase --help', async () => {
    const result = await runCLI(['codebase', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--extract');
  });

  it('extracts a tiny local repo into teamwiki graph output', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-extract-360-'));
    try {
      const srcDir = path.join(fixture, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'greet.ts'),
        'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
      );

      const result = await runCLI(
        ['codebase', '--extract', fixture, '--project', 'slice360', '--json', '--max-files', '10'],
        fixture,
      );
      expect(result.code, result.output).toBe(0);

      const graphPath = path.join(fixture, 'teamwiki', '.indices', 'graph-index.json');
      expect(fs.existsSync(graphPath), result.output).toBe(true);
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as {
        nodes?: unknown[];
        edges?: unknown[];
      };
      const artifactCount = (graph.nodes?.length ?? 0) + (graph.edges?.length ?? 0);
      expect(artifactCount).toBeGreaterThan(0);

      const evidenceDir = path.join(fixture, 'teamwiki', 'evidence', 'code', 'slice360');
      expect(fs.existsSync(evidenceDir)).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('refreshes and lints the same local graph using the skill commands from another directory', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-local-workflow-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-caller-'));
    try {
      const skill = fs.readFileSync(path.join(ROOT, 'skills/team-wiki-codebase/SKILL.md'), 'utf8');
      const commands = [...skill.matchAll(/`(teamai codebase [^`]+)`/g)].map(match => match[1]);
      const refresh = commands.find(command => command.includes('--incremental'));
      const lint = commands.find(command => command.includes('--lint'));
      expect(refresh).toBeDefined();
      expect(lint).toBeDefined();
      const args = (command: string) => command.split(/\s+/).slice(1)
        .map(arg => arg === '<repo>' ? fixture : arg === '<slug>' ? 'custom-service' : arg);
      const source = path.join(fixture, 'greet.ts');
      fs.writeFileSync(source, 'export function originalGreeting() { return "hello"; }\n');
      const initial = await runCLI(
        ['codebase', '--extract', fixture, '--project', 'custom-service', '--json'], caller,
      );
      expect(initial.code, initial.output).toBe(0);
      fs.writeFileSync(source, 'export function updatedGreeting() { return "updated"; }\n');

      const refreshed = await runCLI([...args(refresh!), '--json'], caller);
      expect(refreshed.code, refreshed.output).toBe(0);
      expect(JSON.parse(refreshed.stdout)).toMatchObject({ project: 'custom-service', incremental: true });
      const wiki = path.join(fixture, 'teamwiki');
      expect(fs.readdirSync(path.join(wiki, 'evidence', 'code'))).toEqual(['custom-service']);
      const evidence = fs.readFileSync(path.join(wiki, 'evidence', 'code', 'custom-service', 'component.md'), 'utf8');
      expect(evidence).toContain('updatedGreeting');
      expect(evidence).not.toContain('originalGreeting');
      expect(fs.readFileSync(path.join(wiki, 'router.md'), 'utf8')).toContain('evidence/code/custom-service/index');
      expect(fs.existsSync(path.join(caller, 'teamwiki'))).toBe(false);

      const checked = await runCLI([...args(lint!), '--json'], caller);
      expect(checked.code, checked.output).toBe(0);
      const report = JSON.parse(checked.stdout);
      const graph = JSON.parse(fs.readFileSync(path.join(wiki, '.indices', 'graph-index.json'), 'utf8'));
      expect(report.graphHealth.nodeCount).toBe(graph.nodes.length);
      expect(report.graphHealth.nodeCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });
});

describe('teamai codebase reconcile CLI (issue #360 slice 2)', () => {
  it('reconciles product and code pages with the built CLI', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-360-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-caller-'));
    try {
      const srcDir = path.join(fixture, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
      fs.writeFileSync(path.join(srcDir, 'b.ts'), 'export const b = 1;\n');
      const extracted = await runCLI(
        ['codebase', '--extract', fixture, '--project', 'auth', '--json', '--max-files', '10'],
        caller,
      );
      expect(extracted.code, extracted.output).toBe(0);

      const productDir = path.join(fixture, 'teamwiki', 'product');
      fs.mkdirSync(productDir, { recursive: true });
      fs.writeFileSync(
        path.join(productDir, 'login.md'),
        '# Login\n\n`component` maps to extracted code.\n',
      );

      const help = await runCLI(['codebase', '--help']);
      expect(help.code, help.output).toBe(0);
      expect(help.stdout).toContain('--reconcile');
      const skill = fs.readFileSync(path.join(ROOT, 'skills/team-wiki-codebase/SKILL.md'), 'utf8');
      const command = [...skill.matchAll(/`(teamai codebase [^`]+)`/g)]
        .map(match => match[1])
        .find(candidate => candidate.includes('--reconcile'));
      expect(command).toBeDefined();
      const reconcileArgs = command!.split(/\s+/).slice(1)
        .map(arg => arg === '<repo>' ? fixture : arg);

      const missing = await runCLI(
        ['codebase', '--reconcile', '--output', path.join(fixture, 'missing')],
        fixture,
      );
      expect(missing.code, missing.output).toBe(1);
      expect(missing.stdout).toContain('No teamwiki found');

      const graphPath = path.join(fixture, 'teamwiki', '.indices', 'graph-index.json');
      const graphBeforePreview = fs.readFileSync(graphPath, 'utf8');
      const preview = await runCLI(
        ['--dry-run', ...reconcileArgs, '--json'],
        caller,
      );
      expect(preview.code, preview.output).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ mappings: 2 });
      expect(fs.readFileSync(graphPath, 'utf8')).toBe(graphBeforePreview);

      const result = await runCLI(
        [...reconcileArgs, '--json'],
        caller,
      );
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ mappings: 2 });

      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as {
        nodes: Array<{ slug: string }>;
        edges: Array<{ from: string; to: string; relation: string }>;
      };
      expect(graph.edges).toContainEqual(expect.objectContaining({ relation: 'MAPS_TO' }));
      const nodeSlugs = new Set(graph.nodes.map(node => node.slug));
      expect(graph.edges.every(edge => nodeSlugs.has(edge.from) && nodeSlugs.has(edge.to))).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });
});

describe('teamai codebase extract CLI (issue #508)', () => {
  it('writes fallback _manifest.json for a one-file Widget repo', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-cli-'));
    try {
      const srcDir = path.join(fixture, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'widget.ts'),
        'export class Widget {\n  render() { return "hi"; }\n}\n',
      );

      const result = await runCLI(
        ['codebase', '--extract', fixture, '--project', 'widget'],
        fixture,
      );
      expect(result.code, result.output).toBe(0);
      expect(result.output).toMatch(/Wrote fallback _manifest\.json/);
      expect(result.output).toMatch(/no AI enrich/);
      expect(result.output).not.toMatch(/AI enrich produced no manifest; deep-enrich will have no components/);

      const manifestPath = path.join(fixture, 'teamwiki', 'evidence', 'code', 'widget', '_manifest.json');
      expect(fs.existsSync(manifestPath), result.output).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        components?: Array<{ slug?: string; docPath?: string }>;
      };
      expect(manifest.components?.length).toBeGreaterThanOrEqual(1);
      for (const component of manifest.components ?? []) {
        expect(component.slug).toBeTruthy();
        expect(component.docPath).toBeTruthy();
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('writes fallback _manifest.json fields in --json extract output', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-508-json-'));
    try {
      const srcDir = path.join(fixture, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'widget.ts'),
        'export class Widget {\n  render() { return "hi"; }\n}\n',
      );

      const result = await runCLI(
        ['codebase', '--extract', fixture, '--project', 'widget', '--json'],
        fixture,
      );
      expect(result.code, result.output).toBe(0);
      const report = JSON.parse(result.stdout) as {
        manifest: { written: boolean; source: string; components: number; note?: string };
      };
      expect(report.manifest.written).toBe(true);
      expect(report.manifest.source).toBe('fallback');
      expect(report.manifest.components).toBeGreaterThanOrEqual(1);
      expect(report.manifest.note).toMatch(/Wrote fallback _manifest\.json/);
      expect(report.manifest.note).toMatch(/no AI enrich/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('hidden deep-enrich exits non-zero when _manifest.json has no components', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hidden-deep-enrich-508-'));
    try {
      const wikiRoot = path.join(fixture, 'teamwiki');
      fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', 'widget'), { recursive: true });
      const result = await runCLI(
        ['deep-enrich', '--project', 'widget', '--wiki-root', wikiRoot],
        fixture,
      );
      expect(result.code, result.output).toBe(1);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('public deep-enrich does not tell the user to extract first when evidence exists without components', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-public-deep-enrich-508-'));
    try {
      fs.mkdirSync(path.join(fixture, 'teamwiki', 'evidence', 'code', 'widget'), { recursive: true });
      const result = await runCLI(
        ['codebase', '--deep-enrich', '--project', 'widget', '--output', fixture],
        fixture,
      );
      expect(result.code, result.output).toBe(1);
      expect(result.output).toMatch(/No components in _manifest\.json/);
      expect(result.output).not.toMatch(/Run `teamai codebase --extract` first/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('teamai codebase deep-enrich CLI (issue #360 slice 3)', () => {
  it('lists --deep-enrich, documents it in the skill, and fails when teamwiki is missing', async () => {
    const help = await runCLI(['codebase', '--help']);
    expect(help.code, help.output).toBe(0);
    expect(help.stdout).toContain('--deep-enrich');

    const skill = fs.readFileSync(path.join(ROOT, 'skills/team-wiki-codebase/SKILL.md'), 'utf8');
    const command = [...skill.matchAll(/`(teamai codebase [^`]+)`/g)]
      .map(match => match[1])
      .find(candidate => candidate.includes('--deep-enrich'));
    expect(command).toBeDefined();

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-360-'));
    try {
      const missingRoot = path.join(fixture, 'missing');
      const enrichArgs = command!.split(/\s+/).slice(1)
        .map(arg => arg === '<repo>' ? missingRoot : arg === '<slug>' ? 'slice360' : arg);
      const missing = await runCLI(enrichArgs, fixture);
      expect(missing.code, missing.output).toBe(1);
      expect(missing.stdout).toContain('No teamwiki found');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

