import { createHash } from 'node:crypto';
import { z } from 'zod';

export const INPUT_SCHEMA = 'teamai.knowledge-input.v1' as const;
export const PACK_SCHEMA = 'teamai.knowledge-pack.v1' as const;
export const MAX_PACK_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 1024 * 1024;
const id = z.string().min(1).max(256).regex(/^[\p{L}\p{N}_.:/@-]+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const sourceKinds = ['requirements', 'meeting', 'transcript', 'code'] as const;
export const objectTypes = ['BusinessConcept', 'RequirementItem', 'Meeting', 'Statement', 'Decision', 'CodeEntity', 'SourceDocument'] as const;
export const relationTypes = ['ABOUT', 'HAS_STATEMENT', 'SUPPORTS', 'CHALLENGES', 'ADDRESSES', 'SPECIFIES', 'IMPLEMENTS', 'DEPENDS_ON', 'SUPERSEDES'] as const;
export const refSchema = z.object({ object_id: id, object_version: id }).strict();
export type ObjectRef = z.infer<typeof refSchema>;
export const refKey = (ref: ObjectRef): string => JSON.stringify([ref.object_id, ref.object_version]);
export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const sourceInputSchema = z.object({
  source_id: id,
  repo: z.string().min(1),
  commit,
  path: z.string().min(1).max(1024),
  kind: z.enum(sourceKinds),
  policy_ref: id,
}).strict();
const assertionSchema = z.object({
  type: z.enum(relationTypes), from: refSchema, to: refSchema,
  evidence_refs: z.array(id).min(1).max(100),
}).strict();
export const inputSchema = z.object({
  schema_version: z.literal(INPUT_SCHEMA), project_id: id,
  sources: z.array(sourceInputSchema).min(1).max(200),
  assertions: z.array(assertionSchema).max(2000).default([]),
  default_object_versions: z.record(id).default({}),
}).strict();
export type KnowledgeInput = z.infer<typeof inputSchema>;
export type SourceInput = KnowledgeInput['sources'][number];

export const snapshotSchema = z.object({
  source_id: id, source_version: commit, path: z.string().min(1),
  kind: z.enum(sourceKinds), content: z.string().max(MAX_SOURCE_BYTES),
  content_hash: digest, policy_ref: id,
}).strict();
export type SourceSnapshot = z.infer<typeof snapshotSchema>;
export const evidenceSchema = z.object({
  evidence_id: id, source_id: id, source_version: commit, source_hash: digest,
  line_start: z.number().int().positive(), line_end: z.number().int().positive(), quote: z.string(),
  time_start_ms: z.number().int().nonnegative().optional(),
  time_end_ms: z.number().int().nonnegative().optional(),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const objectSchema = z.object({
  object_id: id, object_version: id, type: z.enum(objectTypes),
  title: z.string().min(1).max(1024), content: z.string(), content_hash: digest,
  evidence_refs: z.array(id).min(1).max(100),
}).strict();
export type KnowledgeObject = z.infer<typeof objectSchema>;
export const relationSchema = z.object({
  relation_id: id, type: z.enum(relationTypes), from: refSchema, to: refSchema,
  evidence_refs: z.array(id).min(1).max(100),
  origin: z.enum(['explicit_reference', 'static_extraction', 'human_assertion', 'ai_inference']),
  review_state: z.literal('candidate'), applicability: z.literal('unknown'),
}).strict();
export type KnowledgeRelation = z.infer<typeof relationSchema>;
export const payloadSchema = z.object({
  project_id: id, status: z.literal('preview'),
  sources: z.array(snapshotSchema).min(1).max(200),
  source_policy_refs: z.array(id).min(1).max(200),
  objects: z.array(objectSchema).min(1).max(10000),
  evidence: z.array(evidenceSchema).min(1).max(20000),
  relations: z.array(relationSchema).max(20000),
  default_object_versions: z.record(id),
  coverage: z.object({ warnings: z.array(z.string()).max(2000) }).strict(),
}).strict();
export type KnowledgePayload = z.infer<typeof payloadSchema>;
export interface KnowledgePack {
  schema_version: typeof PACK_SCHEMA;
  package_hash: string;
  payload: KnowledgePayload;
}

export function validatePayload(value: unknown): KnowledgePayload {
  const pack = payloadSchema.parse(value);
  const sources = new Map<string, SourceSnapshot>();
  const sourceLines = new Map<string, string[]>();
  for (const source of pack.sources) {
    const key = JSON.stringify([source.source_id, source.source_version]);
    if (sources.has(key)) throw new Error('Duplicate source version.');
    if (sha256(source.content) !== source.content_hash) throw new Error('Source hash mismatch.');
    if (Buffer.byteLength(source.content, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Source is too large.');
    sources.set(key, source);
    sourceLines.set(key, source.content.split('\n'));
  }
  const policies = [...new Set(pack.sources.map(source => source.policy_ref))].sort();
  if (JSON.stringify([...pack.source_policy_refs].sort()) !== JSON.stringify(policies)) {
    throw new Error('Source policy dependencies must exactly cover every source.');
  }
  const evidence = new Map<string, Evidence>();
  for (const item of pack.evidence) {
    if (evidence.has(item.evidence_id)) throw new Error('Duplicate evidence ID.');
    const sourceKey = JSON.stringify([item.source_id, item.source_version]);
    const source = sources.get(sourceKey);
    if (!source || source.content_hash !== item.source_hash) throw new Error('Evidence source is missing or changed.');
    const lines = sourceLines.get(sourceKey)!;
    if (item.line_start > item.line_end || item.line_end > lines.length ||
        lines.slice(item.line_start - 1, item.line_end).join('\n') !== item.quote) {
      throw new Error('Evidence does not match its source lines.');
    }
    if ((item.time_start_ms === undefined) !== (item.time_end_ms === undefined) ||
        (item.time_start_ms !== undefined && item.time_end_ms! < item.time_start_ms)) {
      throw new Error('Invalid evidence time range.');
    }
    evidence.set(item.evidence_id, item);
  }
  const objects = new Map<string, KnowledgeObject>();
  const checkEvidence = (refs: string[]) => {
    if (refs.some(ref => !evidence.has(ref))) throw new Error('Missing evidence reference.');
  };
  for (const object of pack.objects) {
    const key = refKey(object);
    if (objects.has(key)) throw new Error('Duplicate object version.');
    if (sha256(object.content) !== object.content_hash) throw new Error('Object hash mismatch.');
    checkEvidence(object.evidence_refs);
    objects.set(key, object);
  }
  const relationIDs = new Set<string>();
  const supersedes = new Map<string, string[]>();
  for (const relation of pack.relations) {
    if (relationIDs.has(relation.relation_id)) throw new Error('Duplicate relation ID.');
    relationIDs.add(relation.relation_id);
    const from = objects.get(refKey(relation.from));
    const to = objects.get(refKey(relation.to));
    if (!from || !to) throw new Error('Relation endpoint is not included in this package.');
    checkEvidence(relation.evidence_refs);
    if (!validRelationTypes(relation.type, from.type, to.type)) throw new Error('Invalid relation endpoint types.');
    if (relation.type === 'SUPERSEDES') {
      const key = refKey(from);
      const targets = supersedes.get(key) ?? [];
      targets.push(refKey(to));
      supersedes.set(key, targets);
    }
  }
  // Iterative topological traversal also handles valid chains near the object limit.
  const degrees = new Map<string, number>();
  for (const [from, targets] of supersedes) {
    if (!degrees.has(from)) degrees.set(from, 0);
    for (const to of targets) degrees.set(to, (degrees.get(to) ?? 0) + 1);
  }
  const queue = [...degrees].filter(([, degree]) => degree === 0).map(([key]) => key);
  for (let index = 0; index < queue.length; index++) {
    for (const to of supersedes.get(queue[index]) ?? []) {
      const degree = degrees.get(to)! - 1;
      degrees.set(to, degree);
      if (degree === 0) queue.push(to);
    }
  }
  if (queue.length !== degrees.size) throw new Error('Cyclic SUPERSEDES relation.');
  for (const [object_id, object_version] of Object.entries(pack.default_object_versions)) {
    if (!objects.has(refKey({ object_id, object_version }))) throw new Error('Default object version is missing.');
  }
  return pack;
}

export function validRelationTypes(type: KnowledgeRelation['type'], from: KnowledgeObject['type'], to: KnowledgeObject['type']): boolean {
  switch (type) {
    case 'ABOUT': return (from === 'RequirementItem' && to === 'BusinessConcept') || (from === 'Statement' && ['RequirementItem', 'BusinessConcept'].includes(to));
    case 'HAS_STATEMENT': return from === 'Meeting' && to === 'Statement';
    case 'SUPPORTS': case 'CHALLENGES': return from === 'Statement' && ['Decision', 'RequirementItem'].includes(to);
    case 'ADDRESSES': return from === 'Decision' && to === 'RequirementItem';
    case 'SPECIFIES': return from === 'SourceDocument' && to === 'RequirementItem';
    case 'IMPLEMENTS': return from === 'CodeEntity' && to === 'RequirementItem';
    case 'DEPENDS_ON': return from === 'CodeEntity' && to === 'CodeEntity';
    case 'SUPERSEDES': return from === to && ['RequirementItem', 'Decision'].includes(from);
  }
}

export function serializePack(payload: KnowledgePayload): string {
  const checked = validatePayload(payload);
  const raw = JSON.stringify(checked);
  return `{"schema_version":"${PACK_SCHEMA}","package_hash":"${sha256(raw)}","payload":${raw}}\n`;
}
