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

/** A source dir named `name` under a fresh temp parent, so its slug is `name`. */
function makeSource(name: string): { parent: string; dir: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebase-cli-'));
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return { parent, dir };
}

/** The backticked `teamai <command> ...` lines the wiki skill tells agents to run. */
function skillCommands(command: 'import' | 'codebase'): string[] {
  const skill = fs.readFileSync(path.join(ROOT, 'skill-data/wiki/SKILL.md'), 'utf8');
  return [...skill.matchAll(new RegExp(`\`(teamai ${command} [^\`]+)\``, 'g'))].map(match => match[1]);
}

/** A skill command's args, placeholders filled, writing into `<output>/teamwiki` as the skill says without a team repo. */
function skillArgs(command: string, fill: Record<string, string>, output: string): string[] {
  return [...command.split(/\s+/).slice(1).map(arg => fill[arg] ?? arg), '--output', output];
}

describe('teamai codebase: teamai import extracts, codebase maintains', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  it('no longer offers --extract', async () => {
    const help = await runCLI(['codebase', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toContain('--extract');

    const extract = await runCLI(['codebase', '--extract', '.']);
    expect(extract.code).toBe(1);
    expect(extract.output).toContain("unknown option '--extract'");
  });

  it('import --dir --output writes <output>/teamwiki and nothing into the source', async () => {
    const { parent, dir } = makeSource('slice360');
    const output = path.join(parent, 'out');
    try {
      fs.writeFileSync(
        path.join(dir, 'src', 'greet.ts'),
        'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
      );

      const result = await runCLI(['import', '--dir', dir, '--output', output, '--skip-enrich'], parent);
      expect(result.code, result.output).toBe(0);

      const wiki = path.join(output, 'teamwiki');
      const repoGraph = JSON.parse(fs.readFileSync(
        path.join(wiki, 'evidence', 'code', 'slice360', '.indices', 'graph-index.json'), 'utf8',
      )) as { nodes?: unknown[]; edges?: unknown[] };
      expect((repoGraph.nodes?.length ?? 0) + (repoGraph.edges?.length ?? 0)).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(wiki, '.indices', 'graph-index.json')), result.output).toBe(true);
      expect(fs.readFileSync(path.join(wiki, 'router.md'), 'utf8')).toContain('slice360');
      expect(fs.existsSync(path.join(dir, 'teamwiki'))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refreshes and lints with the skill\'s commands from another directory', async () => {
    const { parent, dir } = makeSource('custom-service');
    const output = path.join(parent, 'out');
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-caller-'));
    try {
      const fill = { '<repo>': dir };
      const runnable = skillCommands('import').filter(command => command.includes('<repo>'));
      const baseline = runnable.find(command => !command.includes('--incremental'));
      const refresh = runnable.find(command => command.includes('--incremental'));
      const lint = skillCommands('codebase').find(command => command.includes('--lint'));
      expect(baseline).toBeDefined();
      expect(refresh).toBeDefined();
      expect(lint).toBeDefined();

      const source = path.join(dir, 'src', 'greet.ts');
      fs.writeFileSync(source, 'export function originalGreeting() { return "hello"; }\n');
      const initial = await runCLI(skillArgs(baseline!, fill, output), caller);
      expect(initial.code, initial.output).toBe(0);
      fs.writeFileSync(source, 'export function updatedGreeting() { return "updated"; }\n');

      const refreshed = await runCLI(skillArgs(refresh!, fill, output), caller);
      expect(refreshed.code, refreshed.output).toBe(0);
      const wiki = path.join(output, 'teamwiki');
      expect(fs.readdirSync(path.join(wiki, 'evidence', 'code'))).toEqual(['custom-service']);
      const evidence = fs.readFileSync(path.join(wiki, 'evidence', 'code', 'custom-service', 'component.md'), 'utf8');
      expect(evidence).toContain('updatedGreeting');
      expect(evidence).not.toContain('originalGreeting');
      expect(fs.existsSync(path.join(caller, 'teamwiki'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'teamwiki'))).toBe(false);

      const checked = await runCLI([...skillArgs(lint!, fill, output), '--json'], caller);
      expect(checked.code, checked.output).toBe(0);
      const report = JSON.parse(checked.stdout);
      expect(report.graphHealth.nodeCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });

  it('writes a fallback _manifest.json for a one-file Widget repo (#508)', async () => {
    const { parent, dir } = makeSource('widget');
    const output = path.join(parent, 'out');
    try {
      fs.writeFileSync(path.join(dir, 'src', 'widget.ts'), 'export class Widget {\n  render() { return "hi"; }\n}\n');

      const result = await runCLI(['import', '--dir', dir, '--output', output, '--skip-enrich'], parent);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toMatch(/Wrote fallback _manifest\.json/);

      const manifestPath = path.join(output, 'teamwiki', 'evidence', 'code', 'widget', '_manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        components?: Array<{ slug?: string; docPath?: string }>;
      };
      expect(manifest.components?.length).toBeGreaterThanOrEqual(1);
      for (const component of manifest.components ?? []) {
        expect(component.slug).toBeTruthy();
        expect(component.docPath).toBeTruthy();
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('teamai codebase reconcile CLI (issue #360 slice 2)', () => {
  it('reconciles product and imported code pages with the skill\'s command', async () => {
    const { parent, dir } = makeSource('auth');
    const output = path.join(parent, 'out');
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reconcile-caller-'));
    try {
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
      fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
      const imported = await runCLI(['import', '--dir', dir, '--output', output, '--skip-enrich'], caller);
      expect(imported.code, imported.output).toBe(0);

      const productDir = path.join(output, 'teamwiki', 'product');
      fs.mkdirSync(productDir, { recursive: true });
      fs.writeFileSync(path.join(productDir, 'login.md'), '# Login\n\n`component` maps to extracted code.\n');

      const command = skillCommands('codebase').find(candidate => candidate.includes('--reconcile'));
      expect(command).toBeDefined();
      const reconcileArgs = skillArgs(command!, {}, output);

      const missing = await runCLI(['codebase', '--reconcile', '--output', path.join(parent, 'missing')], caller);
      expect(missing.code, missing.output).toBe(1);
      expect(missing.stdout).toContain('No teamwiki found');

      const graphPath = path.join(output, 'teamwiki', '.indices', 'graph-index.json');
      const graphBeforePreview = fs.readFileSync(graphPath, 'utf8');
      const preview = await runCLI(['--dry-run', ...reconcileArgs, '--json'], caller);
      expect(preview.code, preview.output).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ mappings: expect.any(Number) });
      expect(fs.readFileSync(graphPath, 'utf8')).toBe(graphBeforePreview);

      const result = await runCLI([...reconcileArgs, '--json'], caller);
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.stdout).mappings).toBeGreaterThan(0);

      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as {
        nodes: Array<{ slug: string }>;
        edges: Array<{ from: string; to: string; relation: string }>;
      };
      expect(graph.edges).toContainEqual(expect.objectContaining({ relation: 'MAPS_TO' }));
      const nodeSlugs = new Set(graph.nodes.map(node => node.slug));
      expect(graph.edges.every(edge => nodeSlugs.has(edge.from) && nodeSlugs.has(edge.to))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });
});

describe('teamai codebase deep-enrich CLI', () => {
  it('hidden deep-enrich exits non-zero when _manifest.json has no components', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hidden-deep-enrich-508-'));
    try {
      const wikiRoot = path.join(fixture, 'teamwiki');
      fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', 'widget'), { recursive: true });
      const result = await runCLI(['deep-enrich', '--project', 'widget', '--wiki-root', wikiRoot], fixture);
      expect(result.code, result.output).toBe(1);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('public deep-enrich points at teamai import, not the removed extract, when evidence has no components', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-public-deep-enrich-508-'));
    try {
      fs.mkdirSync(path.join(fixture, 'teamwiki', 'evidence', 'code', 'widget'), { recursive: true });
      const result = await runCLI(['codebase', '--deep-enrich', '--project', 'widget', '--output', fixture], fixture);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toMatch(/No components in _manifest\.json/);
      expect(result.output).not.toMatch(/codebase --extract/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('lists --deep-enrich, documents it in the skill, and fails when teamwiki is missing', async () => {
    const help = await runCLI(['codebase', '--help']);
    expect(help.code, help.output).toBe(0);
    expect(help.stdout).toContain('--deep-enrich');

    const command = skillCommands('codebase').find(candidate => candidate.includes('--deep-enrich'));
    expect(command).toBeDefined();

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-360-'));
    try {
      const missing = await runCLI(skillArgs(command!, { '<slug>': 'slice360' }, path.join(fixture, 'missing')), fixture);
      expect(missing.code, missing.output).toBe(1);
      expect(missing.stdout).toContain('No teamwiki found');
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
