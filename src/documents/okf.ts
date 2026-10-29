import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';

export interface DocumentDiagnostic {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface KnowledgeDocument {
  data: Record<string, unknown>;
  body: string;
  raw: string;
  kind: 'concept' | 'index' | 'log';
  diagnostics: DocumentDiagnostic[];
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const instant = (value: unknown): boolean => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

/** A tolerant knowledge reader. Diagnostics do not discard the body or unknown metadata. */
export function readDocument(content: string, relativePath = 'document.md'): KnowledgeDocument {
  const source = content.replace(/^\uFEFF/, '');
  const block = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)?.[0] ?? '';
  const name = path.posix.basename(relativePath);
  const kind = name === 'index.md' ? 'index' : name === 'log.md' ? 'log' : 'concept';
  const diagnostics: DocumentDiagnostic[] = [];
  const issue = (code: string, field: string, message: string, severity: DocumentDiagnostic['severity'] = 'error'): void => {
    diagnostics.push({ code, field, message, severity });
  };
  let data: Record<string, unknown> = {};
  if (block) {
    const yaml = parseDocument(block.replace(/^---[^\n]*\n/, '').replace(/\r?\n---[^\n]*(?:\n)?$/, ''), { uniqueKeys: true });
    if (yaml.errors.length) issue('OKF_YAML', 'frontmatter', yaml.errors[0].message);
    else {
      try {
        const value: unknown = yaml.toJS({ maxAliasCount: 100 });
        if (!mapping(value)) issue('OKF_YAML', 'frontmatter', 'Frontmatter must be a YAML mapping.');
        else data = value;
      } catch {
        issue('OKF_YAML', 'frontmatter', 'Frontmatter contains invalid or excessive aliases.');
      }
    }
  } else if (/^---[ \t]*(?:\r?\n|$)/.test(source)) issue('OKF_YAML', 'frontmatter', 'Frontmatter has no closing delimiter.');
  if (kind === 'concept') {
    if (!block) issue('OKF_FRONTMATTER', 'frontmatter', 'A concept needs YAML frontmatter.');
    if (!text(data.type)) issue('OKF_TYPE', 'type', 'A concept needs a non-empty string type.');
  } else if (block && !(relativePath === 'index.md' && Object.keys(data).every((key) => key === 'okf_version'))) {
    issue('OKF_RESERVED', 'frontmatter', 'Reserved files have no concept frontmatter; only the root index may declare okf_version.');
  }
  if ('sources' in data && (!Array.isArray(data.sources) || data.sources.some((entry) => !mapping(entry) || !text(entry.resource)))) {
    issue('OKF_SOURCES', 'sources', 'Each source must be an object with a non-empty resource.', 'warning');
  }
  if ('status' in data && !['draft', 'stable', 'deprecated'].includes(String(data.status))) {
    issue('OKF_STATUS', 'status', 'Known lifecycle values are draft, stable and deprecated.', 'warning');
  }
  if ('stale_after' in data && !instant(data.stale_after)) issue('OKF_TIMESTAMP', 'stale_after', 'Use an ISO datetime with an explicit UTC offset.', 'warning');
  for (const family of ['generated', 'verified']) {
    if (!(family in data)) continue;
    const events = Array.isArray(data[family]) ? data[family] : [data[family]];
    if (events.some((event) => !mapping(event) || !text(event.by) || !instant(event.at))) {
      issue('OKF_EVENT', family, 'Each event needs by and an ISO datetime at with an explicit UTC offset.', 'warning');
    }
  }
  if (data.type === 'Attested Computation' && !text(data.runtime)) issue('OKF_RUNTIME', 'runtime', 'An Attested Computation needs a runtime.', 'warning');
  const body = block ? source.slice(block.length) : source;
  if (kind === 'log') {
    for (const heading of body.matchAll(/^##\s+(.+)$/gm)) {
      const date = heading[1].trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
        issue('OKF_LOG_DATE', 'body', 'Log date headings must use valid YYYY-MM-DD dates.');
      }
    }
  }
  return { data, body, raw: block, kind, diagnostics };
}

/** Body-only edits keep frontmatter byte-for-byte. Metadata edits preserve unknown YAML keys and comments. */
export function writeDocument(document: KnowledgeDocument, data = document.data, body = document.body): string {
  if (isDeepStrictEqual(data, document.data)) return document.raw + body;
  if (document.diagnostics.some((entry) => entry.code === 'OKF_YAML')) throw new Error('Cannot rewrite malformed frontmatter.');
  if (!document.raw) return `---\n${stringify(data)}---\n${body}`;
  const yaml = document.raw
    ? parseDocument(document.raw.replace(/^---[^\n]*\n/, '').replace(/\r?\n---[^\n]*(?:\n)?$/, ''))
    : parseDocument('{}');
  for (const key of Object.keys(document.data)) if (!Object.hasOwn(data, key)) yaml.delete(key);
  for (const [key, value] of Object.entries(data)) if (!isDeepStrictEqual(value, document.data[key])) yaml.set(key, value);
  return `---\n${yaml.toString()}---\n${body}`;
}

/** Both the legacy string forms and OKF sources resolve through this reader. */
export function sourceResources(data: Record<string, unknown>): string[] {
  const resources: string[] = [];
  for (const raw of [data.sources, data.source]) {
    for (const value of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
      const resource = mapping(value) ? value.resource : value;
      if (text(resource) && !resources.includes(resource)) resources.push(resource);
    }
  }
  return resources;
}

/** A known writer supplies its document type; never infer authority, approval or verification. */
export function asKnowledge(content: string, type: string, relativePath = 'document.md'): string {
  const doc = readDocument(content, relativePath);
  if (doc.diagnostics.some((entry) => entry.code === 'OKF_YAML')) throw new Error('Cannot migrate malformed knowledge frontmatter.');
  if (doc.kind !== 'concept') {
    if (doc.diagnostics.some((entry) => entry.severity === 'error')) throw new Error('Reserved knowledge file has concept metadata.');
    return content;
  }
  const data = { ...doc.data };
  if (!Object.hasOwn(data, 'type')) data.type = type;
  if (!text(data.type)) throw new Error('Knowledge type must be a non-empty string.');
  if (typeof data.sources === 'string') data.sources = [{ resource: data.sources }];
  else if (Array.isArray(data.sources)) data.sources = data.sources.map((entry) => typeof entry === 'string' ? { resource: entry } : entry);
  if (!Object.hasOwn(data, 'sources') && sourceResources(data).length) data.sources = sourceResources(data).map((resource) => ({ resource }));
  if (data.status === 'usable' || data.status === 'stale') {
    data.legacy_status = data.status;
    data.status = 'stable';
  }
  const result = writeDocument(doc, data);
  const problems = readDocument(result, relativePath).diagnostics;
  if (problems.length) throw new Error(`Invalid knowledge metadata: ${problems.map((entry) => `${entry.field}: ${entry.message}`).join('; ')}`);
  return result;
}
