import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { z } from 'zod';

import { log } from './utils/logger.js';
import { assertSafeResourceName, assertWithinRoot } from './utils/path-safety.js';
import { SourceManifestSchema } from './wiki-engine/code-knowledge/code-collector.js';
import { loadFactsCache, loadInterfacesCache } from './wiki-engine/code-knowledge/code-incremental.js';
import { pathExists } from './utils/fs.js';
import type { CodeFact } from './wiki-engine/adapters/index.js';
import type { InterfaceInventory } from './wiki-engine/interface-scanner.js';
import type { CodebaseOutputManifestV2, ManifestComponentV2, ManifestEdgeV2, ManifestEdgeSource } from './wiki-engine/manifest-schema.js';

export interface EnrichContext {
  project: string;
  facts: CodeFact[];
  interfaceInventory: InterfaceInventory;
  modules: Map<string, CodeFact[]>;
}

export interface EnrichResult {
  manifest: CodebaseOutputManifestV2;
  domains: Array<{ name: string; components: string[]; apiCount: number }>;
  repoDomain: string;
  repoDescription: string;
  repoKeywords: string[];
}

const ModuleAIResultSchema = z.object({
  domain: z.string(),
  responsibilities: z.array(z.string()).optional().catch(undefined),
  layer: z.string(),
  summary: z.string().optional().catch(undefined),
});

type ModuleAIResult = z.infer<typeof ModuleAIResultSchema>;

const DomainAIResultSchema = z.object({
  domain: z.string(),
  description: z.string().optional().catch(undefined),
  keywords: z.array(z.string()).optional().catch(undefined),
});

type DomainAIResult = z.infer<typeof DomainAIResultSchema>;

function sanitizeForPrompt(text: string): string {
  return text.replace(/[\n\r]/g, ' ').replace(/[<>]/g, '').slice(0, 200);
}

/** What the prompt about one module names: each field is the text the prompt puts after its label. */
export interface ModuleBrief {
  name: string;
  files: string;
  components: string;
  interfaces: string;
}

function moduleBrief(moduleName: string, moduleFacts: CodeFact[], interfaceInventory: InterfaceInventory): ModuleBrief {
  const components = moduleFacts.filter(f => f.kind === 'component').slice(0, 10);
  const interfaces = interfaceInventory.entries.filter(e => e.component === moduleName);
  const fileList = [...new Set(moduleFacts.map(f => f.file))].slice(0, 15);

  return {
    name: sanitizeForPrompt(moduleName),
    files: fileList.join(', '),
    components: components.map(c => c.name).join(', '),
    interfaces: interfaces.map(i => `${i.type}:${i.count}`).join(', ') || '无',
  };
}

function interfacesSummary(interfaceInventory: InterfaceInventory): string {
  return interfaceInventory.entries.map(e => `${e.component}:${e.type}:${e.count}`).join(', ') || '无';
}

function modulesSummary(moduleResults: Array<{ name: string; result: ModuleAIResult }>): string {
  return moduleResults.map(m =>
    `${m.name}: domain=${m.result.domain}, layer=${m.result.layer}, summary=${m.result.summary}`
  ).join('\n');
}

function parseJSON<T>(raw: string, schema: z.ZodType<T>): T | null {
  const match = raw.match(/\{[\s\S]*\}/);

  if (!match) return null;

  try {
    return schema.safeParse(JSON.parse(match[0])).data ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve an import path to its target top-level module name.
 *
 * Handles three import formats:
 * 1. Relative paths: `./utils/foo`, `../common/bar` — resolved against the importing file's directory
 * 2. Dot-separated (Python): `framework.adapter.haiflow` — first segment is the module
 * 3. Absolute/bare (JS/TS): `@scope/pkg/foo` or `lodash/fp` — first non-scope segment
 */
function resolveImportToModule(importerFile: string, importPath: string): string | undefined {
  // Case 1: relative paths (./foo, ../bar)
  if (importPath.startsWith('.')) {
    const importerDir = path.dirname(importerFile);
    const resolved = path.normalize(path.join(importerDir, importPath));
    const topLevel = resolved.split('/')[0];

    // Guard against resolving outside repo root
    if (!topLevel || topLevel === '..' || topLevel === '.') return undefined;

    return topLevel;
  }

  // Case 2: dot-separated imports (Python style: framework.adapter.foo)
  if (importPath.includes('.') && !importPath.includes('/')) {
    return importPath.split('.')[0];
  }

  // Case 3: bare/absolute imports (JS/TS: lodash/fp, @scope/pkg)
  const parts = importPath.split('/');
  const first = parts[0];

  if (!first) return undefined;

  // Skip npm scoped packages (@scope/pkg) — not project modules
  if (first.startsWith('@')) return undefined;

  return first;
}

/** Group non-relation facts by top-level directory (same buckets as AI enrich). */
export function groupFactsByModule(facts: CodeFact[]): Map<string, CodeFact[]> {
  const modules = new Map<string, CodeFact[]>();

  for (const fact of facts) {
    if (fact.kind === 'relation') continue;
    const mod = fact.file.split('/')[0] || '_root';
    const existing = modules.get(mod) ?? [];
    existing.push(fact);
    modules.set(mod, existing);
  }

  return modules;
}

function isSafeSlug(name: string): boolean {
  try {
    assertSafeResourceName(name);

    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic evidence manifest when AI enrich yields nothing.
 *
 * Component granularity matches deep-enrich: one slug per top-level module.
 * If that list is empty, fall back to `kind === 'component'` fact names so a
 * one-file repo still produces a consumable `components[]`.
 */
export function buildFallbackManifest(ctx: {
  project: string;
  facts: CodeFact[];
  modules: Map<string, CodeFact[]>;
}): CodebaseOutputManifestV2 | null {
  const moduleNames = [...ctx.modules.keys()].filter(isSafeSlug);

  const componentNames = [...new Set(
    ctx.facts.filter(f => f.kind === 'component').map(f => f.name),
  )].filter(isSafeSlug);

  const slugs = moduleNames.length > 0 ? moduleNames : componentNames;

  if (slugs.length === 0) return null;

  const components: ManifestComponentV2[] = slugs.map((name) => {
    const moduleFacts = ctx.modules.get(name) ?? ctx.facts.filter(f => f.name === name);

    const entrypoints = moduleFacts
      .filter(f => f.kind === 'component')
      .filter(f => /handler|route|controller|endpoint|main|server|app/i.test(f.name))
      .slice(0, 5)
      .map(f => `${f.name} (${f.file}:${f.lineStart})`);

    const component: ManifestComponentV2 = {
      slug: name,
      docPath: `evidence/code/${ctx.project}/${name}.md`,
      title: name,
      category: 'component',
      confidence: 'EXTRACTED',
    };

    if (entrypoints.length > 0) component.entrypoints = entrypoints;

    return component;
  });

  return {
    schemaVersion: 'team-wiki.codebase-output-manifest.v2',
    project: ctx.project,
    generatedAt: new Date().toISOString(),
    components,
    edges: [],
  };
}

export function describeEvidenceManifest(source: 'ai' | 'fallback' | 'none', componentCount: number): string | undefined {
  if (source === 'fallback') {
    const noun = componentCount === 1 ? 'component' : 'components';

    return `Wrote fallback _manifest.json (${componentCount} ${noun}, no AI enrich)`;
  }

  if (source === 'none') {
    return 'AI enrich produced no manifest; deep-enrich will have no components';
  }

  return undefined;
}

function qualifyingModules(modules: Map<string, CodeFact[]>): Array<[string, CodeFact[]]> {
  return [...modules.entries()].filter(([, facts]) => facts.length >= 5);
}

function enrichResultOf(
  ctx: Pick<EnrichContext, 'project' | 'facts' | 'interfaceInventory'>,
  moduleResults: Array<{ name: string; result: ModuleAIResult }>,
  domainResult: DomainAIResult | null | undefined,
): EnrichResult {
  let domains: Array<{ name: string; components: string[]; apiCount: number }> = [];
  let repoDomain = '';
  let repoDescription = '';
  let repoKeywords: string[] = [];

  if (domainResult) {
    repoDomain = domainResult.domain;
    repoDescription = domainResult.description ?? '';
    repoKeywords = domainResult.keywords ?? [];
    const apiCount = ctx.interfaceInventory.entries.reduce((sum, e) => sum + e.count, 0);
    domains = [{ name: repoDomain, components: moduleResults.map(m => m.name), apiCount }];
  }

  // Step 3: Build manifest V2
  const components: ManifestComponentV2[] = moduleResults.map(({ name, result }) => ({
    slug: name,
    docPath: `evidence/code/${ctx.project}/${name}.md`,
    title: name,
    category: result.layer,
    confidence: 'INFERRED' as const,
    responsibilities: result.responsibilities,
    entrypoints: ctx.facts
      .filter(f => f.file.startsWith(name + '/') && f.kind === 'component')
      .filter(f => /handler|route|controller|endpoint|main|server|app/i.test(f.name))
      .slice(0, 5)
      .map(f => `${f.name} (${f.file}:${f.lineStart})`),
  }));

  const edges: ManifestEdgeV2[] = [];

  for (const { name } of moduleResults) {
    // Cross-module edges based on import/relation facts. AST-derived facts encode
    // their real relation and source in `detail` ("<RELATION> → <target> (code-ast)");
    // regex heuristic facts carry a raw source line, so they keep the defaults.
    const moduleImports = ctx.facts.filter(f => f.kind === 'relation' && f.file.startsWith(name + '/'));
    const targetEdges = new Map<string, EdgeProvenance>();

    for (const imp of moduleImports) {
      const resolved = resolveImportToModule(imp.file, imp.name);

      if (!resolved || resolved === name) {
        continue;
      }

      const provenance = parseEdgeProvenance(imp.detail);
      const existing = targetEdges.get(resolved);

      // Deterministic winner regardless of fact order: highest provenance rank wins.
      if (!existing || edgeProvenanceRank(provenance) > edgeProvenanceRank(existing)) {
        targetEdges.set(resolved, provenance);
      }
    }

    for (const [target, provenance] of targetEdges) {
      if (moduleResults.some(m => m.name === target)) {
        edges.push({
          from: name,
          to: target,
          relation: provenance.relation,
          confidence: 'EXTRACTED',
          source: provenance.source,
          reason: edgeReason(name, target, provenance.relation),
        });
      }
    }
  }

  const manifest: CodebaseOutputManifestV2 = {
    schemaVersion: 'team-wiki.codebase-output-manifest.v2',
    project: ctx.project,
    generatedAt: new Date().toISOString(),
    components,
    edges,
  };

  return { manifest, domains, repoDomain, repoDescription, repoKeywords };
}

/**
 * Write what AI enrich found beside the evidence: `_manifest.json`, and `_domains.json` for rebuildWikiIndex.
 * Returns the domain it recorded.
 */
export async function writeEnrichResult(result: EnrichResult, evidenceDir: string): Promise<string> {
  await writeManifest(result.manifest, evidenceDir);

  const domainMeta = {
    domain: result.repoDomain || (result.domains[0]?.name ?? ''),
    description: result.repoDescription || '',
    keywords: result.repoKeywords || [],
    components: result.domains[0]?.components ?? [],
  };

  await writeFile(path.join(evidenceDir, '_domains.json'), JSON.stringify(domainMeta, null, 2), 'utf-8');

  return domainMeta.domain;
}

/** The teamwiki and codebase a teamai-codebase-enrich step reads, from its flags. */
export interface CodebaseEnrichTarget {
  project: string;
  wikiRoot: string;
}

function targetOf(flags: { wikiRoot: string; codebase: string }): { ok: true; target: CodebaseEnrichTarget } | { ok: false; message: string } {
  const wikiRoot = path.resolve(flags.wikiRoot);
  const codeRoot = path.join(wikiRoot, 'evidence', 'code');

  try {
    assertWithinRoot(codeRoot, path.join(codeRoot, flags.codebase));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, target: { project: flags.codebase, wikiRoot } };
}

/**
 * Where the codebase's facts and interfaces caches are: its own `evidence/code/<slug>/.indices/` once import published
 * it, else the teamwiki's `.indices/`, where an extract writes them, when the teamwiki's source manifest says the last
 * extract was of this codebase. Undefined when neither holds them.
 */
async function indicesDirOf(target: CodebaseEnrichTarget): Promise<string | undefined> {
  const own = path.join(target.wikiRoot, 'evidence', 'code', target.project, '.indices');

  if (await pathExists(path.join(own, 'facts-cache.json'))) return own;

  try {
    const manifest = SourceManifestSchema.safeParse(JSON.parse(await readFile(path.join(target.wikiRoot, 'source-manifest.json'), 'utf-8')));

    return manifest.data?.project === target.project ? path.join(target.wikiRoot, '.indices') : undefined;
  } catch {
    return undefined;
  }
}

/** What the extract left in the codebase's facts and interfaces caches, as the in-process enrich sees it. */
async function extractedContext(target: CodebaseEnrichTarget): Promise<EnrichContext> {
  const indicesDir = await indicesDirOf(target);

  if (!indicesDir) return { project: target.project, facts: [], interfaceInventory: { entries: [], scannedAt: '' }, modules: new Map() };
  const [facts, interfaceInventory] = await Promise.all([loadFactsCache(indicesDir), loadInterfacesCache(indicesDir)]);

  return { project: target.project, facts, interfaceInventory, modules: groupFactsByModule(facts) };
}

/** The modules to ask about, and the interfaces line the domain prompt names. */
export interface CodebaseEnrichPlan {
  modules: ModuleBrief[];
  interfaces: string;
}

async function plan(target: CodebaseEnrichTarget): Promise<CodebaseEnrichPlan> {
  const ctx = await extractedContext(target);
  const modules = qualifyingModules(ctx.modules).map(([name, facts]) => moduleBrief(name, facts, ctx.interfaceInventory));

  log.debug(modules.length === 0 ? 'enrichWithAI: no qualifying modules, skipping' : `enrichWithAI: ${modules.length} modules`);

  return { modules, interfaces: interfacesSummary(ctx.interfaceInventory) };
}

/** What the tool answered about one module, or why it could not. */
export interface ModuleReply {
  name: string;
  text: string;
  failure: string;
}

// The results of the modules step: each item is a module brief, and its outputs say what the tool answered.
const ModuleResultsSchema = z.array(z.object({
  item: z.object({ name: z.string() }),
  outputs: z.object({ text: z.string().nullish(), failure: z.string().nullish() }).nullish(),
}));

function repliesOf(raw: string): { ok: true; replies: ModuleReply[] } | { ok: false; message: string } {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, message: '--results is not JSON. Pass the results of the modules step.' };
  }

  const parsed = ModuleResultsSchema.safeParse(json);

  if (!parsed.success) return { ok: false, message: `--results is not the results of the modules step: ${parsed.error.message}` };

  return {
    ok: true,
    replies: parsed.data.map(({ item, outputs }) => ({ name: item.name, text: outputs?.text ?? '', failure: outputs?.failure ?? '' })),
  };
}

/** The modules whose reply parsed, or none when a module could not be asked, as the in-process enrich keeps none. */
function answeredModules(replies: ModuleReply[]): Array<{ name: string; result: ModuleAIResult }> {
  if (replies.some(reply => reply.failure !== '')) return [];

  return replies.flatMap(({ name, text }) => {
    const result = parseJSON(text, ModuleAIResultSchema);

    return result ? [{ name, result }] : [];
  });
}

/** What the domain prompt names; `count` 0 means there is nothing to ask about or write. */
export interface CodebaseEnrichSummary {
  count: number;
  project: string;
  modules: string;
}

function summary(project: string, replies: ModuleReply[]): CodebaseEnrichSummary {
  const failed = replies.filter(reply => reply.failure !== '').length;
  const answered = answeredModules(replies);

  if (failed > 0) log.warn(`enrichWithAI: module analysis failed (non-blocking): ${failed} AI task(s) failed`);
  else if (replies.length > 0 && answered.length === 0) log.debug('enrichWithAI: all module analyses returned null');

  return { count: answered.length, project: sanitizeForPrompt(project), modules: modulesSummary(answered) };
}

/** What a teamai-codebase-enrich run wrote: how many modules its manifest has, and the domain. */
export interface CodebaseEnrichWritten {
  modules: number;
  domain: string;
}

async function write(target: CodebaseEnrichTarget, replies: ModuleReply[], domain: { text: string; failure: string }): Promise<CodebaseEnrichWritten> {
  const answered = answeredModules(replies);

  if (answered.length === 0) return { modules: 0, domain: '' };
  const ctx = await extractedContext(target);

  if (domain.failure !== '') log.debug('enrichWithAI: domain classification failed, continuing without');
  const result = enrichResultOf(ctx, answered, domain.failure === '' ? parseJSON(domain.text, DomainAIResultSchema) : null);
  const evidenceDir = path.join(target.wikiRoot, 'evidence', 'code', target.project);
  assertWithinRoot(target.wikiRoot, evidenceDir);
  const recorded = await writeEnrichResult(result, evidenceDir);
  log.info(`AI enrich: ${result.manifest.components.length} modules, domain=${recorded || 'uncategorized'}`);

  return { modules: result.manifest.components.length, domain: recorded };
}

/** The steps of a teamai-codebase-enrich run, which the hidden `teamai codebase enrich-*` verbs call. */
export const CodebaseEnrich = { targetOf, plan, repliesOf, summary, write } as const;

export interface EdgeProvenance {
  relation: string;
  source: ManifestEdgeSource;
}

/**
 * Parse edge relation and source from a relation fact's detail string.
 *
 * AST-derived facts encode `"<RELATION> → <target> (code-ast)"`; anything else
 * (regex heuristic facts, whose detail is a raw source line) falls back to a
 * DEPENDS_ON / code-heuristic default.
 */
export function parseEdgeProvenance(detail: string): EdgeProvenance {
  if (detail.includes('(code-ast)')) {
    const relation = detail.startsWith('REFERENCES')
      ? 'REFERENCES'
      : detail.startsWith('IMPLEMENTS')
        ? 'IMPLEMENTS'
        : 'DEPENDS_ON';

    return { relation, source: 'code-ast' };
  }

  return { relation: 'DEPENDS_ON', source: 'code-heuristic' };
}

/**
 * Rank an edge provenance so a deterministic winner emerges when several facts
 * describe the same module pair (independent of fact ordering).
 *
 * AST provenance always outranks heuristic. Among AST edges the import
 * dependency (DEPENDS_ON) is the canonical module-level relation and wins,
 * keeping the edge consistent with the "imports from" reason.
 */
export function edgeProvenanceRank(provenance: EdgeProvenance): number {
  if (provenance.source !== 'code-ast') {
    return 0;
  }

  switch (provenance.relation) {
    case 'DEPENDS_ON':
      return 3;
    case 'REFERENCES':
      return 2;
    case 'IMPLEMENTS':
      return 1;
    default:
      return 1;
  }
}

/** Build a human-readable edge reason that matches the resolved relation. */
export function edgeReason(from: string, to: string, relation: string): string {
  switch (relation) {
    case 'REFERENCES':
      return `${from} references ${to}`;
    case 'IMPLEMENTS':
      return `${from} implements ${to}`;
    default:
      return `${from} imports from ${to}`;
  }
}

export async function writeManifest(manifest: CodebaseOutputManifestV2, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, '_manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return manifestPath;
}
