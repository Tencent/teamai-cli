import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(ROOT, 'dist/index.js');
const agents = ['claude', 'codex', 'codebuddy', 'opencode'];
const providers = ['git', 'gitlab', 'github'];

describe('fixed-commit knowledge preview through Node producer and Go reader', () => {
  let temporary: string, repository: string, manifestPath: string, oldCommit: string, newCommit: string;
  let goCLI: string, packagePath: string;
  let input: Record<string, unknown>;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  const run = (args: string[], cwd = temporary) => spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: path.join(temporary, 'home'), FORCE_COLOR: '0' },
  });
  const go = (args: string[]) => spawnSync(goCLI, args, { encoding: 'utf8', timeout: 10000 });
  const produce = (extra: string[] = []) => run(['codebase', '--knowledge-manifest', manifestPath, '--output', path.join(temporary, 'out'), '--json', ...extra]);
  const readPack = () => JSON.parse(fs.readFileSync(packagePath, 'utf8'));

  beforeAll(() => {
    expect(fs.existsSync(CLI), 'Run npm run build first').toBe(true);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-knowledge-e2e-'));
    repository = path.join(temporary, 'repo');
    fs.mkdirSync(repository); fs.mkdirSync(path.join(temporary, 'home'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Knowledge Fixture');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repository, 'prd.md'), '# Export\n\n## REQ-23: Export courses\n\nExportService exports Excel for accessible courses.\n');
    fs.writeFileSync(path.join(repository, 'meeting.srt'), '1\n00:00:01,000 --> 00:00:03,000\nREQ-23 should export Excel. PDF is only a suggestion.\n');
    fs.writeFileSync(path.join(repository, 'export.ts'), 'export class ExportService {\n  export() { return "COMMITTED_CODE"; }\n}\n');
    git('add', '.'); git('commit', '-qm', 'Fixture version one');
    oldCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repository, 'prd.md'), '# Export\n\n## REQ-23: Export courses\n\nExportService exports CSV for accessible courses.\n');
    git('add', '.'); git('commit', '-qm', 'Fixture version two');
    newCommit = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repository, 'prd.md'), 'DIRTY_UNCOMMITTED_REQUIREMENT');
    fs.writeFileSync(path.join(repository, 'export.ts'), 'DIRTY_UNCOMMITTED_CODE');
    const source = (source_id: string, file: string, kind: string, commit: string) => ({
      source_id, repo: './repo', commit, path: file, kind, policy_ref: 'project-docs',
    });
    input = {
      schema_version: 'teamai.knowledge-input.v1', project_id: 'export-demo',
      sources: [source('prd', 'prd.md', 'requirements', oldCommit), source('prd', 'prd.md', 'requirements', newCommit),
        source('meeting', 'meeting.srt', 'transcript', oldCommit), source('code', 'export.ts', 'code', oldCommit)],
    };
    manifestPath = path.join(temporary, 'input.json');
    fs.writeFileSync(manifestPath, JSON.stringify(input));
    goCLI = path.join(temporary, 'knowledge-pack');
    execFileSync('go', ['build', '-o', goCLI, './cmd/knowledge-pack'], { cwd: path.join(ROOT, 'server'), timeout: 60000 });
  }, 90000);

  afterAll(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

  it('reads committed PRD/meeting/code versions, leaves the worktree untouched and produces repeatable bytes', () => {
    const before = git('status', '--porcelain=v1');
    const first = produce();
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result.status).toBe('preview');
    packagePath = result.output;
    const bytes = fs.readFileSync(packagePath, 'utf8');
    expect(bytes).not.toContain('DIRTY_UNCOMMITTED');
    expect(bytes).not.toContain(repository);
    const pack = JSON.parse(bytes);
    expect(pack.payload.sources.map((source: { source_version: string }) => source.source_version)).toContain(oldCommit);
    expect(pack.payload.objects.filter((object: { object_id: string }) => object.object_id === 'REQ-23')).toHaveLength(2);
    expect(pack.payload.objects.some((object: { type: string }) => object.type === 'CodeEntity')).toBe(true);
    expect(pack.payload.evidence.some((e: { time_start_ms?: number }) => e.time_start_ms === 1000)).toBe(true);
    expect(pack.payload.relations.every((relation: { review_state: string }) => relation.review_state === 'candidate')).toBe(true);
    const second = produce();
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(JSON.parse(second.stdout).output).toBe(packagePath);
    expect(fs.readFileSync(packagePath, 'utf8')).toBe(bytes);
    expect(git('status', '--porcelain=v1')).toBe(before);
    expect(git('rev-parse', 'HEAD')).toBe(newCommit);
    const checked = go(['--pack', packagePath, '--local-preview']);
    expect(checked.status, checked.stderr + checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout).state).toBe('preview');
  });

  it('validates dry runs without creating an output directory and fails closed for moving refs', () => {
    const dryDirectory = path.join(temporary, 'dry');
    const dry = run(['--dry-run', 'codebase', '--knowledge-manifest', manifestPath, '--output', dryDirectory, '--json']);
    expect(dry.status, dry.stderr + dry.stdout).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dry_run: true, output: null });
    expect(fs.existsSync(dryDirectory)).toBe(false);
    const badPath = path.join(temporary, 'moving.json');
    const bad = { ...input, sources: [{ ...(input.sources as object[])[0], commit: 'HEAD' }] };
    fs.writeFileSync(badPath, JSON.stringify(bad));
    const result = run(['codebase', '--knowledge-manifest', badPath, '--output', dryDirectory, '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toBe('KNOWLEDGE_PREVIEW_FAILED');
    expect(fs.existsSync(dryDirectory)).toBe(false);
  });

  it('uses explicit old/new object versions and refuses missing versions or tampered packages', () => {
    const pack = readPack();
    const requirements = pack.payload.objects.filter((object: { object_id: string }) => object.object_id === 'REQ-23');
    const old = requirements.find((object: { content: string }) => object.content.includes('Excel'));
    const current = requirements.find((object: { content: string }) => object.content.includes('CSV'));
    for (const object of [old, current]) {
      const result = go(['--pack', packagePath, '--local-preview', '--object', 'REQ-23', '--version', object.object_version]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain(object.content.replace(/\n/g, '\\n'));
    }
    expect(go(['--pack', packagePath, '--local-preview', '--object', 'REQ-23', '--version', 'missing']).status).not.toBe(0);
    expect(go(['--pack', packagePath, '--object', 'REQ-23', '--version', old.object_version]).status).not.toBe(0);
    const mutated = path.join(temporary, 'tampered.json');
    pack.payload.sources[0].content = 'tampered';
    fs.writeFileSync(mutated, JSON.stringify(pack));
    expect(go(['--pack', mutated, '--local-preview']).status).not.toBe(0);
    const raw = JSON.stringify(pack.payload);
    pack.package_hash = createHash('sha256').update(raw).digest('hex');
    fs.writeFileSync(mutated, JSON.stringify(pack));
    expect(go(['--pack', mutated, '--local-preview']).status).not.toBe(0);
  });

  it('queries explicit replacement edges in both directions without conflating versions', () => {
    const pack = readPack();
    const requirements = pack.payload.objects.filter((object: { object_id: string }) => object.object_id === 'REQ-23');
    const old = requirements.find((object: { content: string }) => object.content.includes('Excel'));
    const current = requirements.find((object: { content: string }) => object.content.includes('CSV'));
    const ref = (object: { object_id: string; object_version: string }) => ({ object_id: object.object_id, object_version: object.object_version });
    const updated = {
      ...input, assertions: [{ type: 'SUPERSEDES', from: ref(current), to: ref(old), evidence_refs: current.evidence_refs }],
      default_object_versions: { 'REQ-23': current.object_version },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updated));
    try {
      const built = produce();
      expect(built.status, built.stderr + built.stdout).toBe(0);
      const replacementPack = JSON.parse(built.stdout).output;
      const runQuery = (args: string[]) => go(['--pack', replacementPack, '--local-preview', ...args]);
      const incoming = runQuery(['--object', 'REQ-23', '--version', old.object_version, '--relations', 'incoming']);
      expect(incoming.status, incoming.stderr + incoming.stdout).toBe(0);
      const edge = JSON.parse(incoming.stdout).find((relation: { type: string }) => relation.type === 'SUPERSEDES');
      expect(edge.from).toEqual(ref(current)); expect(edge.to).toEqual(ref(old));
      const outgoing = runQuery(['--object', 'REQ-23', '--version', current.object_version, '--relations', 'outgoing']);
      expect(outgoing.status, outgoing.stderr + outgoing.stdout).toBe(0);
      expect(JSON.parse(outgoing.stdout)).toContainEqual(edge);
      const traced = runQuery(['--trace', 'REQ-23', '--version', current.object_version, '--depth', '2', '--max-nodes', '100']);
      expect(traced.status, traced.stderr + traced.stdout).toBe(0);
      expect(JSON.parse(traced.stdout).nodes.map(ref)).toEqual(expect.arrayContaining([ref(old), ref(current)]));
      const searched = runQuery(['--query', 'Excel']);
      expect(searched.status, searched.stderr + searched.stdout).toBe(0);
      expect(JSON.parse(searched.stdout).objects.map(ref)).toContainEqual(ref(old));
    } finally { fs.writeFileSync(manifestPath, JSON.stringify(input)); }
  });

  it('requires a distinct build operation and preserves an existing immutable output', () => {
    const invalid = produce(['--extract', repository]);
    expect(invalid.status).toBe(1);
    const destination = path.join(temporary, 'conflict'); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, path.basename(packagePath)), 'unrelated user data');
    const result = run(['codebase', '--knowledge-manifest', manifestPath, '--output', destination, '--json']);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(destination, path.basename(packagePath)), 'utf8')).toBe('unrelated user data');
  });

  for (const agent of agents) {
    for (const provider of providers) {
      it(`keeps the explicit local preview independent of ${agent}/${provider} configuration`, () => {
        const caller = path.join(temporary, `${agent}-${provider}`);
        const config = path.join(caller, '.teamai'); fs.mkdirSync(config, { recursive: true });
        const content = `mode: self\nrepo:\n  provider: ${provider}\n  url: https://example.test/team/knowledge.git\n  localPath: ${repository}\nagents:\n  - ${agent}\n`;
        fs.writeFileSync(path.join(config, 'config.yaml'), content);
        const before = git('status', '--porcelain=v1');
        const result = run(['codebase', '--knowledge-manifest', manifestPath, '--output', path.join(temporary, 'out'), '--json'], caller);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(JSON.parse(result.stdout).output).toBe(packagePath);
        expect(fs.readFileSync(path.join(config, 'config.yaml'), 'utf8')).toBe(content);
        expect(git('status', '--porcelain=v1')).toBe(before);
      });
    }
  }
});
