import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildKnowledgePayload } from '../knowledge-producer/producer.js';
import { readGitSource } from '../knowledge-producer/git-input.js';
import { INPUT_SCHEMA, MAX_SOURCE_BYTES, serializePack, sha256, type KnowledgeInput, type SourceInput } from '../knowledge-producer/schema.js';

const directories: string[] = [];
const git = (repo: string, ...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function fixture(files: Record<string, string | Buffer>, objectFormat: 'sha1' | 'sha256' = 'sha1'): { repo: string; commit: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-knowledge-producer-'));
  directories.push(repo);
  git(repo, 'init', '-q', `--object-format=${objectFormat}`);
  git(repo, 'config', 'user.name', 'Knowledge Test');
  git(repo, 'config', 'user.email', 'knowledge@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  git(repo, 'add', '--all');
  git(repo, 'commit', '-qm', 'fixture');
  return { repo, commit: git(repo, 'rev-parse', 'HEAD') };
}
function source(repo: string, commit: string, sourcePath: string, kind: SourceInput['kind'], sourceID: string = kind): SourceInput {
  return { source_id: sourceID, repo, commit, path: sourcePath, kind, policy_ref: `policy:${sourceID}` };
}
function manifest(sources: SourceInput[]): KnowledgeInput {
  return { schema_version: INPUT_SCHEMA, project_id: 'test-project', sources, assertions: [], default_object_versions: {} };
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('deterministic committed knowledge production', () => {
  it('reads an older committed blob despite a newer HEAD and dirty files, and resolves repos relative to the manifest', async () => {
    const original = '# Product\n\n## REQ-23 Send\nUse `sendMessage` for text submission.\n';
    const { repo, commit } = fixture({ 'docs/prd.md': original });
    fs.writeFileSync(path.join(repo, 'docs/prd.md'), '## REQ-23 Changed in HEAD\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-qm', 'new version');
    const head = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'docs/prd.md'), '## REQ-23 Dirty draft\n');
    const input = manifest([source(path.basename(repo), commit, 'docs/prd.md', 'requirements')]);
    const result = await buildKnowledgePayload(input, path.dirname(repo));
    expect(result.sources[0].content).toBe(original);
    expect(result.sources[0].source_version).toBe(commit);
    expect(result.objects.find(object => object.object_id === 'REQ-23')?.content).toBe('## REQ-23 Send\nUse `sendMessage` for text submission.');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'docs/prd.md'), 'utf8')).toContain('Dirty draft');
    expect(JSON.stringify(result)).not.toContain(repo);
    expect(JSON.stringify(result)).not.toContain('"repo":');
  });

  it('preserves exact SRT source lines and times and produces only candidate relations for explicit references', async () => {
    const srt = '1\r\n00:00:01,250 --> 00:00:04,500\r\nAlice: REQ-23 needs text input.\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nGood morning.\r\n\r\n3\r\n00:00:07,000 --> 00:00:09,250\r\nDecision: defer REQ-23 until review.\r\n';
    const { repo, commit } = fixture({
      'prd.md': '# Product\n\n## REQ-23 Text input\nCall `sendMessage`.\n',
      'src/send.ts': 'export function sendMessage(text: string) {\n  return text;\n}\n',
      'meeting.srt': srt,
    });
    const result = await buildKnowledgePayload(manifest([
      source(repo, commit, 'prd.md', 'requirements'), source(repo, commit, 'src/send.ts', 'code'), source(repo, commit, 'meeting.srt', 'transcript'),
    ]), repo);
    expect(result.sources.find(item => item.kind === 'transcript')?.content).toBe(srt);
    const timed = result.evidence.filter(item => item.time_start_ms !== undefined);
    expect(timed).toHaveLength(2);
    expect(timed).toContainEqual(expect.objectContaining({ line_start: 1, line_end: 3, time_start_ms: 1250, time_end_ms: 4500, quote: srt.split('\n').slice(0, 3).join('\n') }));
    expect(result.objects.filter(item => item.type === 'Statement')).toHaveLength(2);
    expect(result.objects.filter(item => item.type === 'Decision')).toHaveLength(1);
    expect(result.relations.map(item => item.type)).toEqual(expect.arrayContaining(['SPECIFIES', 'HAS_STATEMENT', 'ABOUT', 'IMPLEMENTS', 'ADDRESSES']));
    expect(result.relations.every(item => item.review_state === 'candidate' && item.applicability === 'unknown')).toBe(true);
    expect(result.coverage.warnings.join('\n')).toMatch(/selected 2 of 3/);
    expect(result.source_policy_refs).toEqual(['policy:code', 'policy:requirements', 'policy:transcript']);
    expect(result.objects.every(item => item.content_hash === sha256(item.content))).toBe(true);
    const code = result.objects.find(item => item.type === 'CodeEntity')!;
    expect(result.evidence.find(item => item.evidence_id === code.evidence_refs[0])).toMatchObject({ line_start: 1, line_end: 1 });
  });

  it('uses actual extractor facts and reports unsupported language and inferred coverage', async () => {
    const { repo, commit } = fixture({ 'code.ts': 'const Hidden = 1;\nexport default Hidden;\nimport { A } from "./a";\nexport class Public {}\n', 'data.json': '{"key": 1}' });
    const result = await buildKnowledgePayload(manifest([source(repo, commit, 'code.ts', 'code'), source(repo, commit, 'data.json', 'code', 'config')]), repo);
    expect(result.objects.filter(item => item.type === 'CodeEntity').map(item => item.title)).toEqual(['Public']);
    expect(result.coverage.warnings.join('\n')).toContain('2 inferred or unresolved facts were omitted');
    expect(result.coverage.warnings.join('\n')).toContain('no code extractor supports this file type');
  });

  it('keeps multiple versions and does not guess the target version or latest default', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Original\nUse `sendMessage`.\n', 'meeting.md': 'Alice: REQ-23 needs discussion.\n' });
    fs.writeFileSync(path.join(repo, 'prd.md'), '## REQ-23 Revised\nUse `sendMessage` after confirmation.\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-qm', 'revised');
    const revised = git(repo, 'rev-parse', 'HEAD');
    const result = await buildKnowledgePayload(manifest([
      source(repo, commit, 'prd.md', 'requirements'), source(repo, revised, 'prd.md', 'requirements'), source(repo, revised, 'meeting.md', 'meeting'),
    ]), repo);
    const versions = result.objects.filter(item => item.object_id === 'REQ-23');
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map(item => item.object_version)).size).toBe(2);
    expect(result.relations.some(item => item.type === 'ABOUT' || item.type === 'SUPERSEDES')).toBe(false);
    expect(result.default_object_versions).toEqual({});
    expect(result.coverage.warnings.join('\n')).toContain('ambiguous target versions');
  });

  it('includes explicit full-reference assertions as candidates and only explicit defaults', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Original\nFirst.\n' });
    fs.writeFileSync(path.join(repo, 'prd.md'), '## REQ-23 Revised\nSecond.\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-qm', 'revised');
    const revised = git(repo, 'rev-parse', 'HEAD');
    const input = manifest([source(repo, commit, 'prd.md', 'requirements'), source(repo, revised, 'prd.md', 'requirements')]);
    const baseline = await buildKnowledgePayload(input, repo);
    const first = baseline.objects.find(item => item.object_id === 'REQ-23' && item.content.includes('Original'))!;
    const second = baseline.objects.find(item => item.object_id === 'REQ-23' && item.content.includes('Revised'))!;
    input.assertions.push({ type: 'SUPERSEDES', from: { object_id: second.object_id, object_version: second.object_version }, to: { object_id: first.object_id, object_version: first.object_version }, evidence_refs: second.evidence_refs });
    input.default_object_versions = { 'REQ-23': second.object_version };
    const result = await buildKnowledgePayload(input, repo);
    expect(result.relations.find(item => item.type === 'SUPERSEDES')).toMatchObject({ origin: 'human_assertion', review_state: 'candidate', applicability: 'unknown' });
    expect(result.default_object_versions).toEqual({ 'REQ-23': second.object_version });
    input.assertions[0].to.object_version = 'absent';
    await expect(buildKnowledgePayload(input, repo)).rejects.toThrow('Relation endpoint is not included');
  });

  it('does not select a code symbol when two committed files define it', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Send\nUse `sendMessage`.\n', 'a.ts': 'export function sendMessage() {}\n', 'b.ts': 'export function sendMessage() {}\n' });
    const result = await buildKnowledgePayload(manifest([source(repo, commit, 'prd.md', 'requirements'), source(repo, commit, 'a.ts', 'code', 'a'), source(repo, commit, 'b.ts', 'code', 'b')]), repo);
    expect(result.relations.some(item => item.type === 'IMPLEMENTS')).toBe(false);
    expect(result.coverage.warnings.join('\n')).toContain('ambiguous targets');
  });

  it('keeps unnumbered items with content-derived IDs and produces byte-identical packs across input order', async () => {
    const { repo, commit } = fixture({ 'prd.md': '# Product\n\n## Text input\nSupport keyboard entry.\n\n## REQ-23 Send\nCall `sendMessage`.\n', 'send.ts': 'export function sendMessage() {}\n' });
    const input = manifest([source(repo, commit, 'prd.md', 'requirements'), source(repo, commit, 'send.ts', 'code')]);
    const first = await buildKnowledgePayload(input, repo);
    const second = await buildKnowledgePayload({ ...input, sources: [...input.sources].reverse() }, repo);
    expect(serializePack(first)).toBe(serializePack(second));
    expect(first.objects.filter(item => item.type === 'RequirementItem')).toHaveLength(2);
    expect(first.coverage.warnings.join('\n')).toContain('continuity across edits is unknown');
  });

  it('does not infer Decisions from ordinary discussion and reports malformed SRT without losing its raw snapshot', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Send\nText.\n', 'meeting.md': 'Alice: I think REQ-23 should wait.\n\n## Decision\n\nRequest a further review of REQ-23.\n', 'bad.srt': '1\n00:61:00,000 --> 00:62:00,000\nREQ-23\n' });
    const result = await buildKnowledgePayload(manifest([source(repo, commit, 'prd.md', 'requirements'), source(repo, commit, 'meeting.md', 'meeting'), source(repo, commit, 'bad.srt', 'transcript')]), repo);
    expect(result.objects.filter(item => item.type === 'Decision')).toHaveLength(1);
    expect(result.objects.find(item => item.type === 'Decision')?.content).toContain('Request a further review');
    expect(result.coverage.warnings.join('\n')).toContain('1 malformed subtitle segments');
    expect(result.sources.find(item => item.kind === 'transcript')?.content).toContain('00:61:00');
  });

  it('recognizes stable IDs with cross-references and ignores definition-looking lines inside fenced code', async () => {
    const { repo, commit } = fixture({ 'prd.md': '# Product\n\n## REQ-23 Uses REQ-24\nText.\n\n```md\n## REQ-999 This is an example\n```\n\n- **REQ-24**: Supports REQ-23\n  Details.\n' });
    const result = await buildKnowledgePayload(manifest([source(repo, commit, 'prd.md', 'requirements')]), repo);
    expect(result.objects.filter(item => item.type === 'RequirementItem').map(item => item.object_id).sort()).toEqual(['REQ-23', 'REQ-24']);
  });

  it('supports plain transcript text and preserves SRT times when a subtitle is declared as a meeting', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Send\nText.\n', 'transcript.txt': 'Alice: REQ-23 needs discussion.\n', 'meeting.srt': '1\n00:00:01,000 --> 00:00:02,000\nREQ-23 needs discussion.\n' });
    const result = await buildKnowledgePayload(manifest([source(repo, commit, 'prd.md', 'requirements'), source(repo, commit, 'transcript.txt', 'transcript'), source(repo, commit, 'meeting.srt', 'meeting')]), repo);
    expect(result.objects.filter(item => item.type === 'Statement')).toHaveLength(2);
    expect(result.evidence.find(item => item.time_start_ms === 1000)).toMatchObject({ time_end_ms: 2000 });
  });
});

describe('committed source input boundaries', () => {
  it('reads full SHA-256 Git commit IDs without treating them as moving refs', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Safe\n' }, 'sha256');
    expect(commit).toHaveLength(64);
    const result = await readGitSource(source(repo, commit, 'prd.md', 'requirements'), repo);
    expect(result.source_version).toBe(commit);
    expect(result.content).toBe('## REQ-23 Safe\n');
  });

  it.each(['../secret.md', '/etc/passwd', 'docs/../../secret', './prd.md', 'docs//prd.md', 'docs\\prd.md', ':../secret', 'C:/secret.md'])('rejects unsafe or absent Git paths: %s', async unsafe => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Safe\n' });
    await expect(readGitSource(source(repo, commit, unsafe, 'requirements'), repo)).rejects.toThrow(/Source requirements:/);
  });

  it('rejects branch names, abbreviated SHAs, and blob IDs as source commits', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Safe\n' });
    for (const version of ['HEAD', commit.slice(0, 12), git(repo, 'rev-parse', `${commit}:prd.md`)]) {
      await expect(readGitSource(source(repo, version, 'prd.md', 'requirements'), repo)).rejects.toThrow(/commit/);
    }
  });

  it('rejects committed symlinks and traversal through them, even when the working-tree target is readable', async () => {
    const { repo } = fixture({ 'prd.md': '## REQ-23 Safe\n', 'docs/real.md': '## REQ-24 Real\n' });
    fs.symlinkSync('prd.md', path.join(repo, 'linked.md'));
    fs.symlinkSync('docs', path.join(repo, 'linked-docs'));
    git(repo, 'add', '--all'); git(repo, 'commit', '-qm', 'links');
    const commit = git(repo, 'rev-parse', 'HEAD');
    for (const file of ['linked.md', 'linked-docs/real.md']) await expect(readGitSource(source(repo, commit, file, 'requirements'), repo)).rejects.toThrow('symbolic links');
  });

  it('rejects committed submodules without initializing or fetching them', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Safe\n' });
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${commit},vendor`);
    git(repo, 'commit', '-qm', 'gitlink');
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(readGitSource(source(repo, head, 'vendor', 'code'), repo)).rejects.toThrow('submodules');
  });

  it('rejects binary, invalid UTF-8, oversized, and missing sources with sanitized errors', async () => {
    const { repo, commit } = fixture({ 'binary.dat': Buffer.from([0, 1, 2]), 'invalid.dat': Buffer.from([0xc3, 0x28]), 'large.txt': 'x'.repeat(MAX_SOURCE_BYTES + 1) });
    for (const file of ['binary.dat', 'invalid.dat', 'large.txt', 'missing.md']) {
      try { await readGitSource(source(repo, commit, file, 'requirements'), repo); throw new Error('unexpected success'); }
      catch (error) {
        expect((error as Error).message).toMatch(/binary|too large|not present/);
        expect((error as Error).message).not.toContain(repo);
      }
    }
    await expect(readGitSource(source(path.join(repo, 'missing-repo'), commit, 'file.md', 'requirements'), repo)).rejects.toThrow('could not be read locally');
  });

  it('ignores replacement objects and rejects duplicate source identities', async () => {
    const { repo, commit } = fixture({ 'prd.md': '## REQ-23 Original\n' });
    fs.writeFileSync(path.join(repo, 'prd.md'), '## REQ-23 Replacement\n');
    git(repo, 'add', '--all'); git(repo, 'commit', '-qm', 'replacement');
    git(repo, 'replace', commit, git(repo, 'rev-parse', 'HEAD'));
    const original = source(repo, commit, 'prd.md', 'requirements');
    expect((await readGitSource(original, repo)).content).toContain('Original');
    await expect(buildKnowledgePayload(manifest([original, original]), repo)).rejects.toThrow('Duplicate source version');
  });
});
