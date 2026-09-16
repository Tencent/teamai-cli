import { describe, expect, it } from 'vitest';
import {
  inputSchema, serializePack, sha256, validatePayload,
  type KnowledgePayload,
} from '../knowledge-producer/schema.js';

function fixture(): KnowledgePayload {
  const old = 'REQ-23: Export Excel', current = 'REQ-23: Export CSV';
  const sources = [old, current].map((content, index) => ({
    source_id: 'prd', source_version: String(index + 1).repeat(40), path: 'prd.md',
    kind: 'requirements' as const, content, content_hash: sha256(content), policy_ref: 'docs-policy',
  }));
  return {
    project_id: 'sample', status: 'preview', sources, source_policy_refs: ['docs-policy'],
    objects: sources.map((source, index) => ({
      object_id: 'REQ-23', object_version: `v${index + 1}`, type: 'RequirementItem',
      title: 'Export', content: source.content, content_hash: source.content_hash,
      evidence_refs: [`e${index + 1}`],
    })),
    evidence: sources.map((source, index) => ({
      evidence_id: `e${index + 1}`, source_id: source.source_id, source_version: source.source_version,
      source_hash: source.content_hash, line_start: 1, line_end: 1, quote: source.content,
    })),
    relations: [{
      relation_id: 'r1', type: 'SUPERSEDES',
      from: { object_id: 'REQ-23', object_version: 'v2' }, to: { object_id: 'REQ-23', object_version: 'v1' },
      evidence_refs: ['e2'], origin: 'human_assertion', review_state: 'candidate', applicability: 'unknown',
    }],
    default_object_versions: { 'REQ-23': 'v2' }, coverage: { warnings: [] },
  };
}

describe('knowledge package contract', () => {
  it('preserves two versions of one object and an explicit navigation default', () => {
    const pack = validatePayload(fixture());
    expect(pack.objects.map(object => object.object_version)).toEqual(['v1', 'v2']);
    expect(pack.relations[0].to.object_version).toBe('v1');
    const first = serializePack(pack), second = serializePack(pack);
    expect(first).toBe(second);
    const envelope = JSON.parse(first);
    expect(envelope.package_hash).toBe(sha256(JSON.stringify(envelope.payload)));
  });

  it.each([
    ['missing old endpoint', (p: KnowledgePayload) => { p.objects.shift(); }],
    ['changed evidence', (p: KnowledgePayload) => { p.evidence[0].quote = 'Invented decision'; }],
    ['source mutation', (p: KnowledgePayload) => { p.sources[0].content += ' changed'; }],
    ['missing policy', (p: KnowledgePayload) => { p.source_policy_refs = []; }],
    ['extra policy', (p: KnowledgePayload) => { p.source_policy_refs.push('other'); }],
    ['duplicate policy', (p: KnowledgePayload) => { p.source_policy_refs.push('docs-policy'); }],
    ['dangling default', (p: KnowledgePayload) => { p.default_object_versions['REQ-23'] = 'latest'; }],
    ['duplicate object version', (p: KnowledgePayload) => { p.objects.push(p.objects[0]); }],
    ['wrong relation types', (p: KnowledgePayload) => { p.relations[0].type = 'IMPLEMENTS'; }],
    ['missing evidence', (p: KnowledgePayload) => { p.objects[0].evidence_refs = ['missing']; }],
    ['invalid time range', (p: KnowledgePayload) => { p.evidence[0].time_start_ms = 1000; }],
    ['replacement cycle', (p: KnowledgePayload) => {
      p.relations.push({ ...p.relations[0], relation_id: 'r2', from: p.relations[0].to, to: p.relations[0].from });
    }],
  ] as const)('rejects %s', (_name, mutate) => {
    const pack = fixture(); mutate(pack);
    expect(() => validatePayload(pack)).toThrow();
  });

  it('rejects publishing and auto-confirmation fields', () => {
    expect(() => validatePayload({ ...fixture(), status: 'published' })).toThrow();
    const pack = fixture();
    const confirmed = { ...pack, relations: [{ ...pack.relations[0], review_state: 'confirmed' }] };
    expect(() => validatePayload(confirmed)).toThrow();
  });

  it('validates a long replacement chain without exhausting the JavaScript call stack', () => {
    const pack = fixture();
    pack.objects = Array.from({ length: 5000 }, (_, index) => ({ ...pack.objects[0], object_version: `v${index}` }));
    pack.relations = pack.objects.slice(0, -1).map((object, index) => ({
      ...pack.relations[0], relation_id: `r${index}`,
      from: { object_id: object.object_id, object_version: object.object_version },
      to: { object_id: object.object_id, object_version: pack.objects[index + 1].object_version },
    }));
    expect(validatePayload(pack).relations).toHaveLength(4999);
    pack.relations.push({ ...pack.relations[0], relation_id: 'cycle', from: pack.relations.at(-1)!.to });
    expect(() => validatePayload(pack)).toThrow('Cyclic SUPERSEDES');
  });

  it('checks many anchors against a shared multiline source', () => {
    const pack = fixture();
    pack.sources[0].content = `${pack.sources[0].content}\n${'line\n'.repeat(100000)}`;
    pack.sources[0].content_hash = sha256(pack.sources[0].content);
    pack.evidence[0].source_hash = pack.sources[0].content_hash;
    pack.evidence.push(...Array.from({ length: 1000 }, (_, index) => ({
      ...pack.evidence[0], evidence_id: `shared-${index}`, line_start: index + 2, line_end: index + 2, quote: 'line',
    })));
    expect(validatePayload(pack).evidence).toHaveLength(1002);
    pack.evidence.at(-1)!.quote = 'fabricated';
    expect(() => validatePayload(pack)).toThrow('Evidence does not match');
  });

  it('requires immutable commit IDs and rejects arbitrary input fields', () => {
    const input = {
      schema_version: 'teamai.knowledge-input.v1', project_id: 'sample',
      sources: [{ source_id: 'prd', repo: './docs', commit: 'a'.repeat(40), path: 'prd.md', kind: 'requirements', policy_ref: 'docs-policy' }],
    };
    expect(inputSchema.safeParse(input).success).toBe(true);
    expect(inputSchema.safeParse({ ...input, sources: [{ ...input.sources[0], commit: 'HEAD' }] }).success).toBe(false);
    expect(inputSchema.safeParse({ ...input, command: 'arbitrary shell' }).success).toBe(false);
  });
});
