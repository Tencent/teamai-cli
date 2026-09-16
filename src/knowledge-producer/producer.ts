import path from 'node:path';
import { extractCodeFacts } from '../wiki-engine/code-knowledge/code-extractors.js';
import { supportedLanguages } from '../wiki-engine/code-knowledge/extractors/index.js';
import type { CodeCollectedFile } from '../wiki-engine/code-knowledge/code-collector.js';
import { readGitSource } from './git-input.js';
import {
  inputSchema, refKey, sha256, validatePayload, type Evidence, type KnowledgeInput, type KnowledgeObject,
  type KnowledgePayload, type KnowledgeRelation, type ObjectRef, type SourceSnapshot,
} from './schema.js';

type Span = { start: number; end: number; timeStart?: number; timeEnd?: number };
type LocatedObject = { object: KnowledgeObject; source: SourceSnapshot; span: Span };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const requirementIDs = (text: string): string[] => [...new Set(text.match(/\bREQ-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\b/g) ?? [])].sort(compare);
const explicitDecision = (text: string): boolean => /(?:^|\s|\[)(?:\*\*)?Decision(?:\*\*)?(?:\s*[:：]|\])|^#{1,6}\s+Decision\s*$/im.test(text);
const scopedID = (type: string, sourceID: string, suffix?: string): string =>
  [type, sourceID.length > 120 ? sha256(sourceID) : sourceID, ...(suffix ? [suffix] : [])].join(':');
const objectRef = (object: KnowledgeObject): ObjectRef => ({ object_id: object.object_id, object_version: object.object_version });
const lineCache = new WeakMap<SourceSnapshot, string[]>();
const linesOf = (source: SourceSnapshot): string[] => {
  let lines = lineCache.get(source);
  if (!lines) { lines = source.content.split('\n'); lineCache.set(source, lines); }
  return lines;
};
const textAt = (source: SourceSnapshot, span: Span): string => linesOf(source).slice(span.start - 1, span.end).join('\n');

/** Deterministic, local-only preview production. Every edge remains a review candidate. */
export async function buildKnowledgePayload(input: KnowledgeInput, manifestDirectory: string): Promise<KnowledgePayload> {
  const checkedInput = inputSchema.parse(input);
  const sources: SourceSnapshot[] = [];
  const seenSources = new Set<string>();
  for (const source of [...checkedInput.sources].sort((a, b) => compare(JSON.stringify([a.source_id, a.commit]), JSON.stringify([b.source_id, b.commit])))) {
    const key = JSON.stringify([source.source_id, source.commit]);
    if (seenSources.has(key)) throw new Error('Duplicate source version.');
    seenSources.add(key);
    sources.push(await readGitSource(source, manifestDirectory));
  }
  const objects = new Map<string, KnowledgeObject>();
  const evidence = new Map<string, Evidence>();
  const relations = new Map<string, KnowledgeRelation>();
  const warnings = new Set<string>();
  const requirements: LocatedObject[] = [];
  const codeSymbols = new Map<string, LocatedObject[]>();
  const statements: LocatedObject[] = [];
  const decisions: LocatedObject[] = [];

  const addEvidence = (source: SourceSnapshot, span: Span): string => {
    const evidence_id = `evidence:${sha256(JSON.stringify([source.source_id, source.source_version, span]))}`;
    evidence.set(evidence_id, {
      evidence_id, source_id: source.source_id, source_version: source.source_version, source_hash: source.content_hash,
      line_start: span.start, line_end: span.end, quote: textAt(source, span),
      ...(span.timeStart !== undefined ? { time_start_ms: span.timeStart, time_end_ms: span.timeEnd! } : {}),
    });
    return evidence_id;
  };
  const addObject = (source: SourceSnapshot, span: Span, type: KnowledgeObject['type'], object_id: string, logicalKey: string, title: string): LocatedObject => {
    const content = textAt(source, span);
    const object: KnowledgeObject = {
      object_id, object_version: sha256(JSON.stringify([source.source_version, source.source_id, logicalKey, content])),
      type, title: title.trim().slice(0, 1024) || type, content, content_hash: sha256(content), evidence_refs: [addEvidence(source, span)],
    };
    const existing = objects.get(refKey(object));
    if (existing) existing.evidence_refs = [...new Set([...existing.evidence_refs, ...object.evidence_refs])].sort(compare);
    else objects.set(refKey(object), object);
    return { object: existing ?? object, source, span };
  };
  const addRelation = (type: KnowledgeRelation['type'], from: ObjectRef, to: ObjectRef, evidenceRefs: string[], origin: KnowledgeRelation['origin']): void => {
    const evidence_refs = [...new Set(evidenceRefs)].sort(compare);
    const relation_id = `relation:${sha256(JSON.stringify([type, from, to, evidence_refs, origin]))}`;
    relations.set(relation_id, {
      relation_id, type, from: { object_id: from.object_id, object_version: from.object_version },
      to: { object_id: to.object_id, object_version: to.object_version }, evidence_refs, origin,
      review_state: 'candidate', applicability: 'unknown',
    });
  };

  for (const source of sources) {
    const whole = { start: 1, end: linesOf(source).length };
    const document = addObject(source, whole, 'SourceDocument', scopedID('source', source.source_id), 'document', source.path);
    if (source.kind === 'requirements') {
      const spans = requirementSpans(source);
      if (!spans.length) warnings.add(`${source.source_id}@${source.source_version}: no requirement items were extracted.`);
      for (const { span, id, title } of spans) {
        const content = textAt(source, span);
        const objectID = id ?? scopedID('requirement', source.source_id, sha256(content));
        const requirement = addObject(source, span, 'RequirementItem', objectID, `requirement:${objectID}`, title);
        requirements.push(requirement);
        addRelation('SPECIFIES', objectRef(document.object), objectRef(requirement.object), requirement.object.evidence_refs, 'static_extraction');
        if (!id) warnings.add(`${source.source_id}@${source.source_version}: unnumbered requirement ${objectID} uses a content-derived ID; continuity across edits is unknown.`);
      }
    } else if (source.kind === 'code') {
      const language = languageFor(source.path);
      const file: CodeCollectedFile = {
        path: source.path, relativePath: source.path, language, sha256: source.content_hash, content: source.content,
      };
      const facts = extractCodeFacts([file]);
      let skipped = 0;
      for (const fact of facts) {
        if (fact.kind === 'relation' || fact.confidence !== 'EXTRACTED' || !['component', 'interface', 'config', 'error', 'data', 'style'].includes(fact.kind)) {
          skipped++; continue;
        }
        const span = { start: fact.lineStart, end: fact.lineEnd ?? fact.lineStart };
        if (span.start < 1 || span.end < span.start || span.end > whole.end) { skipped++; continue; }
        const logicalKey = `${fact.kind}:${fact.name}`;
        const entity = addObject(source, span, 'CodeEntity', scopedID('code', source.source_id, sha256(logicalKey)), logicalKey, fact.name);
        codeSymbols.set(fact.name, [...(codeSymbols.get(fact.name) ?? []), entity]);
      }
      if (!supportedLanguages().includes(language)) warnings.add(`${source.source_id}@${source.source_version}: no code extractor supports this file type.`);
      else warnings.add(`${source.source_id}@${source.source_version}: code coverage is limited to supported static facts; ${skipped} inferred or unresolved facts were omitted. No runtime behavior was verified.`);
    }
  }

  const requirementsByID = new Map<string, LocatedObject[]>();
  for (const requirement of requirements) {
    const id = requirement.object.object_id;
    const entries = requirementsByID.get(id) ?? [];
    if (!entries.some(entry => refKey(entry.object) === refKey(requirement.object))) entries.push(requirement);
    requirementsByID.set(id, entries);
  }
  for (const [id, entries] of requirementsByID) {
    if (entries.length > 1) warnings.add(`${id}: multiple object versions are included; no latest version was inferred.`);
  }

  for (const source of sources.filter(source => source.kind === 'meeting' || source.kind === 'transcript')) {
    const whole = { start: 1, end: linesOf(source).length };
    const meeting = addObject(source, whole, 'Meeting', scopedID('meeting', source.source_id), 'meeting', source.path);
    const isSubtitle = path.posix.extname(source.path).toLowerCase() === '.srt' || /^\s*\d{2,}:\d{2}:\d{2}[,.]\d{3}\s+-->/m.test(source.content);
    const units = isSubtitle ? subtitleSpans(source, warnings) : paragraphSpans(source);
    let selected = 0;
    for (const span of units) {
      const text = textAt(source, span);
      const ids = requirementIDs(text).filter(id => requirementsByID.has(id));
      if (!ids.length && !explicitDecision(text)) continue;
      selected++;
      const statement = addObject(source, span, 'Statement', scopedID('statement', source.source_id, sha256(text)), `statement:${sha256(text)}`, text);
      statements.push(statement);
      addRelation('HAS_STATEMENT', objectRef(meeting.object), objectRef(statement.object), statement.object.evidence_refs, 'static_extraction');
      if (explicitDecision(text)) {
        decisions.push(addObject(source, span, 'Decision', scopedID('decision', source.source_id, sha256(text)), `decision:${sha256(text)}`, text));
      }
    }
    warnings.add(`${source.source_id}@${source.source_version}: selected ${selected} of ${units.length} meeting segments with known requirement IDs or explicit Decision markers; other segments remain only in the source snapshot. Decision markers do not establish adoption or approval.`);
  }

  for (const located of [...statements, ...decisions]) {
    for (const id of requirementIDs(located.object.content)) {
      const matches = requirementsByID.get(id) ?? [];
      if (matches.length === 1) {
        addRelation(located.object.type === 'Decision' ? 'ADDRESSES' : 'ABOUT', objectRef(located.object), objectRef(matches[0].object), located.object.evidence_refs, 'explicit_reference');
      } else if (matches.length > 1) warnings.add(`${id}: an explicit reference has ambiguous target versions; no relation was generated.`);
      else warnings.add(`${id}: an explicit reference has no included requirement target.`);
    }
  }
  for (const requirement of requirements) {
    for (const [name, entries] of codeSymbols) {
      if (!mentionsSymbol(requirement.object.content, name)) continue;
      const unique = [...new Map(entries.map(entry => [refKey(entry.object), entry])).values()];
      if (unique.length !== 1) {
        warnings.add(`${requirement.object.object_id}: code symbol ${name} has ambiguous targets; no IMPLEMENTS relation was generated.`);
        continue;
      }
      addRelation('IMPLEMENTS', objectRef(unique[0].object), objectRef(requirement.object),
        [...requirement.object.evidence_refs, ...unique[0].object.evidence_refs], 'explicit_reference');
    }
  }
  if ([...relations.values()].some(relation => relation.type === 'IMPLEMENTS')) warnings.add('IMPLEMENTS candidates record explicit symbol references only; they do not establish implementation completion.');
  for (const assertion of checkedInput.assertions) {
    addRelation(assertion.type, assertion.from, assertion.to, assertion.evidence_refs, 'human_assertion');
  }
  const payload: KnowledgePayload = {
    project_id: checkedInput.project_id, status: 'preview', sources,
    source_policy_refs: [...new Set(sources.map(source => source.policy_ref))].sort(compare),
    objects: [...objects.values()].sort((a, b) => compare(refKey(a), refKey(b))),
    evidence: [...evidence.values()].sort((a, b) => compare(a.evidence_id, b.evidence_id)),
    relations: [...relations.values()].sort((a, b) => compare(a.relation_id, b.relation_id)),
    default_object_versions: Object.fromEntries(Object.entries(checkedInput.default_object_versions).sort(([a], [b]) => compare(a, b))),
    coverage: { warnings: [...warnings].sort(compare) },
  };
  return validatePayload(payload);
}

function languageFor(file: string): string {
  return ({ '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.toml': 'toml', '.conf': 'toml', '.ini': 'toml', '.sql': 'sql' } as Record<string, string>)[path.posix.extname(file).toLowerCase()] ?? 'text';
}

function mentionsSymbol(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'u').test(text);
}

function requirementSpans(source: SourceSnapshot): Array<{ span: Span; id?: string; title: string }> {
  const lines = linesOf(source);
  const result: Array<{ span: Span; id?: string; title: string }> = [];
  const occupied = new Set<number>();
  const fenced = new Set<number>();
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (fence || marker) fenced.add(index);
    if (!fence && marker) fence = marker[1];
    else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
  }
  const heading = (line: string): RegExpExecArray | null => /^\s{0,3}(#{1,6})\s+(.*)/.exec(line);
  const bullet = (line: string): boolean => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
  const definitionID = (index: number): string | undefined => {
    if (fenced.has(index)) return undefined;
    const line = lines[index];
    const leading = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').replace(/^[\s*_\[(]+/, '');
    const prefix = /^(REQ-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)\b/.exec(leading);
    if (prefix) return prefix[1];
    const ids = requirementIDs(line);
    return heading(line) && ids.length === 1 ? ids[0] : undefined;
  };
  const trimSpan = (start: number, end: number): Span => {
    while (end > start && !lines[end - 1].trim()) end--;
    return { start, end };
  };
  const add = (start: number, end: number, id?: string): void => {
    const span = trimSpan(start, end);
    result.push({ span, ...(id ? { id } : {}), title: lines[start - 1].replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim() });
    for (let line = span.start; line <= span.end; line++) occupied.add(line);
  };
  for (let index = 0; index < lines.length; index++) {
    const h = heading(lines[index]);
    const id = definitionID(index);
    if (!id) continue;
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = fenced.has(end) ? null : heading(lines[end]);
      if (nextHeading && (!h || nextHeading[1].length <= h[1].length || definitionID(end))) break;
      if (bullet(lines[end]) && definitionID(end)) break;
      if (!h && !lines[end].trim()) break;
      end++;
    }
    add(index + 1, end, id);
    index = end - 1;
  }
  // Unnumbered leaf sections/items are useful, but their identities cannot survive edits.
  for (let index = 0; index < lines.length; index++) {
    if (occupied.has(index + 1) || fenced.has(index) || !lines[index].trim()) continue;
    const h = heading(lines[index]);
    if (!h && !bullet(lines[index])) continue;
    if (requirementIDs(lines[index]).length) continue;
    let end = index + 1;
    while (end < lines.length && !heading(lines[end]) && !(bullet(lines[end]) && !h) && !occupied.has(end + 1)) end++;
    if (h && (end === index + 1 || (end < lines.length && heading(lines[end]) && heading(lines[end])![1].length > h[1].length))) continue;
    add(index + 1, end);
    index = end - 1;
  }
  if (!result.length && source.content.trim()) add(1, lines.length);
  return result;
}

function paragraphSpans(source: SourceSnapshot): Span[] {
  const lines = linesOf(source);
  const spans: Span[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let end = index + 1;
    const decisionHeading = /^#{1,6}\s+Decision\s*$/i.test(lines[index].trim());
    while (end < lines.length && (decisionHeading ? !/^#{1,6}\s/.test(lines[end]) : !!lines[end].trim())) end++;
    while (end > index + 1 && !lines[end - 1].trim()) end--;
    spans.push({ start: index + 1, end });
    index = end - 1;
  }
  return spans;
}

function subtitleSpans(source: SourceSnapshot, warnings: Set<string>): Span[] {
  const lines = linesOf(source);
  const spans: Span[] = [];
  let invalid = 0;
  for (const span of paragraphSpans(source)) {
    const raw = lines.slice(span.start - 1, span.end);
    const timeIndex = raw.findIndex(line => line.includes('-->'));
    const match = timeIndex < 0 ? null : /^\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*\r?$/.exec(raw[timeIndex]);
    if (!match || (timeIndex !== 0 && !(timeIndex === 1 && /^\d+\r?$/.test(raw[0])))) { invalid++; continue; }
    const n = match.slice(1).map(Number);
    const timeStart = ((n[0] * 60 + n[1]) * 60 + n[2]) * 1000 + n[3];
    const timeEnd = ((n[4] * 60 + n[5]) * 60 + n[6]) * 1000 + n[7];
    if ([n[1], n[2], n[5], n[6]].some(value => value >= 60) || !Number.isSafeInteger(timeEnd) || timeEnd < timeStart || raw.length <= timeIndex + 1) { invalid++; continue; }
    spans.push({ ...span, timeStart, timeEnd });
  }
  if (invalid) warnings.add(`${source.source_id}@${source.source_version}: ${invalid} malformed subtitle segments were omitted from structured extraction; raw content is preserved.`);
  return spans;
}
