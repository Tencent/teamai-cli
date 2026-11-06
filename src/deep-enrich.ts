import { readFile, writeFile, readdir, mkdir, unlink, lstat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import { pathExists } from './utils/fs.js';
import { lenientList } from './utils/json.js';
import { log } from './utils/logger.js';
import { assertSafeResourceName, assertWithinRoot } from './utils/path-safety.js';

const PROGRESS_PHASES = ['pending', 'components', 'architecture', 'graph', 'ai-graph', 'index-enhance', 'done'] as const;

/** `_review/progress.json`, written only by saveProgress. */
const ProgressStateSchema = z.object({
  project: z.string(),
  phase: z.enum(PROGRESS_PHASES),
  componentsDone: z.array(z.string()),
  componentsPending: z.array(z.string()),
  startedAt: z.string(),
  updatedAt: z.string(),
});

type ProgressState = z.infer<typeof ProgressStateSchema>;

const OptionalTextSchema = z.string().optional().catch(undefined);
const OptionalTextListSchema = z.array(z.string()).optional().catch(undefined);

const ManifestComponentSchema = z.object({
  slug: z.string(),
  title: OptionalTextSchema,
  responsibilities: OptionalTextListSchema,
  category: OptionalTextSchema,
  entrypoints: OptionalTextListSchema,
  interfaces: OptionalTextListSchema,
  errorCodeRanges: OptionalTextListSchema,
});

type ManifestComponent = z.infer<typeof ManifestComponentSchema>;

const ManifestEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: OptionalTextSchema,
  protocol: OptionalTextSchema,
  confidence: OptionalTextSchema,
  weight: z.number().optional().catch(undefined),
  reason: OptionalTextSchema,
  evidenceRefs: OptionalTextListSchema,
});

type ManifestEdge = z.infer<typeof ManifestEdgeSchema>;

/** The evidence `_manifest.json`; a field of the wrong type reads as absent. */
const ManifestSchema = z.object({
  project: OptionalTextSchema,
  generatedAt: OptionalTextSchema,
  components: lenientList(ManifestComponentSchema).optional().catch(undefined),
  edges: lenientList(ManifestEdgeSchema).optional().catch(undefined),
});

type Manifest = z.infer<typeof ManifestSchema>;

/** The evidence `_domains.json`; a field of the wrong type reads as absent. */
const DomainsFileSchema = z.object({
  keywords: OptionalTextListSchema,
  description: OptionalTextSchema,
});

// ─── 上下文加载 ─────────────────────────────────────────────

interface EnrichContext {
  manifest: Manifest;
  indexMd: string;
  callChains: string;
  overview: string;
  moduleDocs: Map<string, string>;
}

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function symlinkRefusal(linkPath: string): Error {
  return new Error(`Cannot deep-enrich through a symbolic link: ${linkPath}. Replace it with a regular file or directory before retrying.`);
}

async function assertSafeOutputDir(dir: string): Promise<void> {
  try {
    if ((await lstat(dir)).isSymbolicLink()) {
      throw symlinkRefusal(dir);
    }

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw symlinkRefusal(path.join(dir, entry.name));
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

async function assertSafeEvidencePath(wikiRoot: string, evidenceDir: string): Promise<void> {
  assertWithinRoot(wikiRoot, evidenceDir);
  const root = path.resolve(wikiRoot);

  for (let dir = path.resolve(evidenceDir); ; dir = path.dirname(dir)) {
    if ((await lstat(dir)).isSymbolicLink()) {
      throw symlinkRefusal(dir);
    }

    if (dir === root) break;
  }
}

async function writeGeneratedFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await assertSafeOutputDir(dir);
  const target = path.join(dir, name);
  const pending = path.join(dir, `.${name}.${randomUUID()}.tmp`);

  try {
    await writeFile(pending, content, { encoding: 'utf-8', flag: 'wx' });
    await rename(pending, target);
  } catch (error) {
    await unlink(pending).catch(() => undefined);
    throw error;
  }
}

async function loadContext(evidenceDir: string): Promise<EnrichContext> {
  const manifestRaw = await readFileSafe(path.join(evidenceDir, '_manifest.json'));
  let manifest: Manifest = {};

  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
  } catch {
    log.debug('deep-enrich: failed to parse _manifest.json');
  }

  const [indexMd, callChains, overview] = await Promise.all([
    readFileSafe(path.join(evidenceDir, 'index.md')),
    readFileSafe(path.join(evidenceDir, 'dependency-paths.md')),
    readFileSafe(path.join(evidenceDir, 'overview.md')),
  ]);

  const modulesDir = path.join(evidenceDir, 'modules');
  const moduleDocs = new Map<string, string>();

  if (await pathExists(modulesDir)) {
    try {
      const entries = await readdir(modulesDir);
      await Promise.all(
        entries
          .filter(e => e.endsWith('.md'))
          .map(async (e) => {
            const content = await readFileSafe(path.join(modulesDir, e));
            moduleDocs.set(e.replace(/\.md$/, ''), content);
          }),
      );
    } catch {
      log.debug('deep-enrich: failed to read modules dir');
    }
  }

  return { manifest, indexMd, callChains, overview, moduleDocs };
}

// ─── Progress 管理 ─────────────────────────────────────────

const PROGRESS_PATH_SUBDIR = '_review';
const PROGRESS_FILENAME = 'progress.json';

function progressPath(evidenceDir: string): string {
  return path.join(evidenceDir, PROGRESS_PATH_SUBDIR, PROGRESS_FILENAME);
}

async function loadProgress(evidenceDir: string, project: string, allComponents: string[]): Promise<ProgressState> {
  const p = progressPath(evidenceDir);

  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = ProgressStateSchema.safeParse(JSON.parse(raw)).data;

    if (parsed?.project === project) return parsed;
  } catch {
    // 不存在或解析失败，创建新的
  }

  return {
    project,
    phase: 'pending',
    componentsDone: [],
    componentsPending: [...allComponents],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function saveProgress(evidenceDir: string, state: ProgressState): Promise<void> {
  const updated: ProgressState = { ...state, updatedAt: new Date().toISOString() };
  await writeGeneratedFile(path.dirname(progressPath(evidenceDir)), PROGRESS_FILENAME, JSON.stringify(updated, null, 2));
}

// ─── 确定性图谱生成（无需 AI）─────────────────────────────

function buildG1RelationsDoc(manifest: Manifest): string {
  const edges = manifest.edges ?? [];

  if (edges.length === 0) {
    return [
      '# 组件关系矩阵',
      '<!-- search-anchor: 依赖, 关系, 上游, 下游, DEPENDS_ON, imports, 模块关系 -->',
      '',
      '## 🤖 AI Quick Reference',
      '| Dimension | Key Information |',
      '|-----------|-----------------|',
      '| Document scope | Answers who depends on X and what X depends on |',
      '| Core value | No extracted edges are available in this run |',
      '',
      '（暂无依赖边数据；关系覆盖为 0，不能据此推断不存在依赖。）', '',
      '> 可能原因：AI enrich 未执行（skipEnrich=true）或未检测到组件间依赖关系。',
      '> 尝试：重新运行 `teamai import --from-repo <url>`（不带 --skip-enrich）。',
      '',
    ].join('\n');
  }

  const components = new Set<string>();
  const forwardDeps = new Map<string, string[]>();
  const reverseDeps = new Map<string, string[]>();

  for (const e of edges) {
    components.add(e.from);
    components.add(e.to);
    const fwd = forwardDeps.get(e.from) ?? [];
    fwd.push(`${e.to} (${e.relation ?? 'DEPENDS_ON'})`);
    forwardDeps.set(e.from, fwd);
    const rev = reverseDeps.get(e.to) ?? [];
    rev.push(`${e.from} (${e.relation ?? 'DEPENDS_ON'})`);
    reverseDeps.set(e.to, rev);
  }

  const confidenceCounts = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };

  for (const edge of edges) confidenceCounts[graphConfidence(edge).label]++;

  const lines = [
    '# 组件关系矩阵',
    '<!-- search-anchor: 依赖, 关系, 上游, 下游, DEPENDS_ON, imports, 模块关系 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Answers who depends on X and what X depends on |',
    '| Core value | Forward/reverse dependency index with evidence confidence |',
    '| Coverage | Extracted manifest edges only; absent relations are not proof of absence |',
    '',
    `共 ${components.size} 个组件，${edges.length} 条边。`,
    '',
    '## 依赖表',
    '',
    '| 来源组件 | 目标组件 | 关系类型 | Confidence | Score |',
    '|----------|----------|----------|------------|-------|',
    ...edges.slice(0, 50).map(e => {
      const { label, score } = graphConfidence(e);

      return `| ${e.from} | ${e.to} | ${e.relation ?? 'DEPENDS_ON'} | ${label} | ${score.toFixed(2)} |`;
    }),
    '',
    '## Confidence statistics',
    '',
    `- EXTRACTED: ${confidenceCounts.EXTRACTED}`,
    `- INFERRED: ${confidenceCounts.INFERRED}`,
    `- AMBIGUOUS: ${confidenceCounts.AMBIGUOUS}`,
    '',
    '## 正向依赖索引（X 依赖→）',
    '',
  ];

  for (const [mod, deps] of [...forwardDeps.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    lines.push(`- **${mod}** → ${deps.join(', ')}`);
  }

  lines.push('', '## 反向依赖索引（→X 被谁依赖）', '');

  for (const [mod, deps] of [...reverseDeps.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    lines.push(`- **${mod}** ← ${deps.join(', ')}`);
  }

  lines.push('');

  return lines.join('\n');
}

function buildG2DataflowDoc(callChains: string): string {
  if (!callChains.trim()) {
    return '# 数据流图\n<!-- search-anchor: 调用链, 数据流, 请求路径, entry, flow, 入口, 链路 -->\n\n## 🤖 AI Quick Reference\n| Dimension | Key Information |\n|-----------|-----------------|\n| Document scope | Deterministic call-chain evidence |\n| Core value | Shows known paths without inventing missing state machines |\n| Coverage | No call-chain evidence was extracted in this run |\n\n（暂无调用链数据）\n\n> 可能原因：代码中未检测到入口→服务→数据层的多层调用链。\n> 常见于纯库项目或单层架构项目。\n';
  }

  const lines = [
    '# 数据流图',
    '<!-- search-anchor: 调用链, 数据流, 请求路径, entry, flow, 入口, 链路 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Deterministic call-chain evidence |',
    '| Core value | Shows known paths without inventing missing state machines |',
    '| Confidence | EXTRACTED for paths emitted from deterministic call-chain evidence |',
    '',
  ];

  const rawLines = callChains.split('\n');
  const chainBlocks: Array<{ entry: string; steps: string[] }> = [];
  let currentBlock: { entry: string; steps: string[] } | null = null;

  for (const line of rawLines) {
    // Each `## entry` opens a chain; the `# Dependency Paths` title and its
    // intro lines are not relations and must not be labelled as such.
    const entryMatch = line.match(/^##\s+(.+)/);

    if (entryMatch) {
      if (currentBlock) chainBlocks.push(currentBlock);
      currentBlock = { entry: entryMatch[1], steps: [] };
    } else if (currentBlock && line.trim()) {
      currentBlock.steps.push(line.trim());
    }
  }

  if (currentBlock) chainBlocks.push(currentBlock);

  if (chainBlocks.length > 0) {
    for (const block of chainBlocks.slice(0, 15)) {
      lines.push(`## ${block.entry}`, '', '**Confidence: EXTRACTED**', '');

      for (const step of block.steps.slice(0, 10)) {
        // Keep the producer's `- ` marker first so each step stays a list item.
        lines.push(`- [EXTRACTED] ${step.replace(/^- /, '')}`);
      }

      lines.push('');
    }
  } else {
    const flowLines = rawLines.filter(l => /→|->/.test(l));

    if (flowLines.length > 0) {
      lines.push('| 调用链路径 |', '|------------|');

      for (const l of flowLines.slice(0, 30)) {
        lines.push(`| ${l.trim()} |`);
      }
    } else {
      lines.push('```', callChains.slice(0, 2000), '```');
    }
  }

  lines.push('');

  return lines.join('\n');
}

function buildG3InterfacesDoc(interfacesMd: string): string {
  if (!interfacesMd.trim()) {
    return '# 接口映射表\n<!-- search-anchor: data flow, storage dependencies, MQ topology, cache, 数据流, 存储 -->\n\n## 🤖 AI Quick Reference\n| Dimension | Key Information |\n|-----------|-----------------|\n| Document scope | Extracted interface evidence only |\n| Core value | Shows known interface inventory without inventing storage behaviour |\n| Coverage | No interface evidence was extracted in this run |\n\n（暂无接口数据）\n\n> 可能原因：未检测到 HTTP/gRPC/MQ 等对外接口定义。\n> 仅当代码中存在路由注册、Proto 定义或消息队列声明时才会提取接口。\n';
  }

  return `# 接口映射表\n<!-- search-anchor: data flow, storage dependencies, MQ topology, cache, 数据流, 存储 -->\n\n## 🤖 AI Quick Reference\n| Dimension | Key Information |\n|-----------|-----------------|\n| Document scope | Extracted interface evidence only |\n| Core value | Routes interface questions to the evidence inventory |\n| Coverage | Extracted interface evidence only; storage and MQ semantics remain unverified |\n\n${interfacesMd}\n`;
}

function buildG4ErrorCodeDoc(manifest: Manifest, moduleDocs: Map<string, string>): string {
  const rows: string[] = [];

  for (const component of manifest.components ?? []) {
    for (const range of component.errorCodeRanges ?? []) {
      rows.push(`| ${range} | ${component.slug} | EXTRACTED | manifest errorCodeRanges |`);
    }

    const content = moduleDocs.get(component.slug) ?? '';
    const start = content.indexOf('## Errors');

    if (start < 0) continue;
    const end = content.indexOf('\n## ', start + 4);
    const section = content.slice(start, end < 0 ? undefined : end);

    for (const line of section.split('\n')) {
      const match = line.match(/- `([^`]+)` ← (.+)/);

      if (match) rows.push(`| ${match[1]} | ${component.slug} | EXTRACTED | ${match[2]} |`);
    }
  }

  return [
    '# Error Code Component Map',
    '<!-- search-anchor: error code, error mapping, InvalidParameter, 错误码, 故障排查 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Explicit error-code ownership evidence |',
    '| Core value | Routes troubleshooting without guessing ownership |',
    '',
    '## Error code range allocation',
    '',
    '| Error code range/prefix | Owning component | Confidence | Evidence |',
    '|-------------------------|------------------|------------|----------|',
    ...(rows.length > 0 ? rows : ['| — | — | AMBIGUOUS | No error-code range was extracted |']),
    '',
    '## External → internal mapping',
    '',
    'No external-to-internal mapping is inferred without explicit evidence.',
    '',
  ].join('\n');
}

function buildG7RiskDoc(manifest: Manifest): string {
  const edges = manifest.edges ?? [];
  const components = [...new Set([...(manifest.components ?? []).map(c => c.slug), ...edges.flatMap(e => [e.from, e.to])])].sort();

  const rows = components.map(component => {
    const direct = edges.filter(e => e.from === component || e.to === component).length;
    const dependents = new Set(edges.filter(e => e.to === component).map(e => e.from)).size;
    const level = direct >= 5 || dependents >= 3 ? '🔴 high' : direct >= 2 || dependents >= 1 ? '🟡 medium' : '🟢 low';

    return `| ${component} | ${level} | ${dependents} direct dependent(s) | ${direct} extracted manifest edge(s); runtime availability is unverified |`;
  });

  return [
    '# Architecture Risks and Impact Analysis',
    '<!-- search-anchor: architecture risk, blast radius, impact surface, 架构风险, 影响范围 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Deterministic structural impact indicators |',
    '| Core value | Estimates direct graph impact without claiming runtime failure probability |',
    '',
    '## Component risk level summary',
    '',
    '| Component | Risk level | Blast radius | Notes |',
    '|-----------|------------|--------------|-------|',
    ...(rows.length > 0 ? rows : ['| — | AMBIGUOUS | — | No component graph evidence available |']),
    '',
    '## Limits',
    '',
    'These levels are structural indicators from extracted edges, not production SLO, failure-rate, or transitive blast-radius measurements.',
    '',
  ].join('\n');
}

function buildG8ConfigDoc(components: ManifestComponent[], moduleDocs: Map<string, string>): string {
  const rows: string[] = [];

  for (const component of components) {
    const content = moduleDocs.get(component.slug) ?? '';
    const start = content.indexOf('## Config');

    if (start < 0) continue;
    const end = content.indexOf('\n## ', start + 4);
    const section = content.slice(start, end < 0 ? undefined : end);

    for (const line of section.split('\n')) {
      const match = line.match(/- `([^`]+)` ← (.+)/);

      if (match) rows.push(`| ${match[1]} | ${component.slug} | — | Extracted config reference | AMBIGUOUS | unknown |`);
    }
  }

  return [
    '# Core Config Parameter Index',
    '<!-- search-anchor: config parameters, config index, config changes, 配置参数, 配置变更 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Explicit configuration references from component evidence |',
    '| Core value | Locates config references while leaving defaults and effect mode unverified |',
    '',
    '## Config parameter table',
    '',
    '| Config item | Owning component | Default | Affected behavior | Change risk | Effect mode |',
    '|-------------|------------------|---------|-------------------|-------------|-------------|',
    ...(rows.length > 0 ? rows : ['| — | — | — | No configuration reference was extracted | AMBIGUOUS | unknown |']),
    '',
    '## Change checklist',
    '',
    'Before changing a parameter, verify file location, impact scope, activation/restart, rollback, risk, and canary need from source evidence.',
    '',
  ].join('\n');
}

function buildG9ConstraintDoc(): string {
  return [
    '# Business Rule Constraint Matrix',
    '<!-- search-anchor: business rules, constraint matrix, operation constraints, AI reasoning, 业务规则 -->',
    '',
    '## 🤖 AI Quick Reference',
    '| Dimension | Key Information |',
    '|-----------|-----------------|',
    '| Document scope | Explicit operation constraints from evidence |',
    '| Core value | Prevents unsupported yes/no answers when evidence is absent |',
    '',
    '## Operation precondition matrix',
    '',
    '| Operation | State requirement | Hardware constraint | Billing constraint | Quota constraint | Other constraints | Confidence |',
    '|-----------|------------------|--------------------|--------------------|------------------|-------------------|------------|',
    '| — | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | [UNVERIFIED] | No explicit business-rule evidence was provided | AMBIGUOUS |',
    '',
    '## AI reasoning rules quick reference',
    '',
    '1. State check → 2. Type check → 3. Hardware check → 4. Billing check → 5. Quota check → 6. Mutual exclusion check.',
    '',
    '> K4 business-rule validation is deferred: this deterministic manifest contains no standardised questions or product-rule corpus. Do not infer constraints from component names.',
    '',
  ].join('\n');
}

function buildGComparisonDoc(project: string, flags: { g5Generated: boolean; g6Generated: boolean }): string {
  const rows = [
    ['G1', 'Component Dependency Matrix', 'graph-g1-relations.md', 'partial', 'Edges are rendered with confidence; full N×N matrix is not available.'],
    ['G2', 'Call Chain + state machines', 'graph-g2-dataflow.md', 'partial', 'Call-chain evidence is rendered; state-machine extraction is unavailable.'],
    ['G3', 'Data Flow and Storage Dependencies', 'graph-g3-interfaces.md', 'partial', 'Interface evidence is rendered; storage/MQ fields are not guaranteed.'],
    ['G4', 'Error Code Component Map', 'graph-g4-errors.md', 'partial', 'Explicit ranges/docs are indexed; unknown ownership remains visible.'],
    ['G5', 'Cross-Component Interaction Scenarios', 'graph-g5-scenarios.md', flags.g5Generated ? 'partial' : 'deferred', flags.g5Generated ? 'AI output exists; scenario coverage still needs review.' : 'AI scenario generation was unavailable.'],
    ['G6', 'Knowledge Graph Triples', 'graph-g6-triples.md', 'partial', 'Triples, confidence, scores, and path indexes are deterministic; no fabricated 100-triple minimum.'],
    ['G7', 'Architecture Risks and Impact Analysis', 'graph-g7-risks.md', 'partial', 'Direct structural indicators are generated; runtime risk is not claimed.'],
    ['G8', 'Core Config Parameter Index', 'graph-g8-config.md', 'partial', 'Explicit config references are indexed; defaults/effect modes remain unverified.'],
    ['G9', 'Business Rule Constraint Matrix', 'graph-g9-constraints.md', 'deferred', 'No product-rule evidence or standardised K4 questions were available.'],
  ];

  return [
    `# ${project} — G-document comparison and coverage`,
    '<!-- search-anchor: G1 G2 G3 G4 G5 G6 G7 G8 G9 method comparison coverage -->',
    '',
    '| G | Wiki method meaning | CLI output | Match | Evidence / gap |',
    '|---|---------------------|------------|-------|----------------|',
    ...rows.map(row => `| ${row[0]} | ${row[1]} | [${row[2]}](./${row[2]}) | ${row[3]} | ${row[4]} |`),
    '',
    'The table is intentionally conservative: a generated placeholder or partial index is not reported as a full methodology match.',
    '',
  ].join('\n');
}

// ─── Phase 1 and 2: component and architecture docs ─────────

/** What the component-doc prompt says of one component. */
export interface ComponentBrief {
  slug: string;
  responsibilities: string;
  facts: string;
  call_chains: string;
  deps: string;
}

/** What the architecture prompt says of the project, and whether its doc is still missing. */
export interface ArchitectureBrief {
  needed: boolean;
  modules: string;
  edges: string;
  interfaces: string;
}

function extractRelevantCallChains(callChains: string, slug: string): string {
  const lines = callChains.split('\n');
  const relevant = lines.filter(l => l.includes(slug));

  return relevant.slice(0, 20).join('\n') || callChains.slice(0, 500);
}

function extractDeps(manifest: Manifest, slug: string): string {
  const edges = manifest.edges ?? [];
  const deps = edges.filter(e => e.from === slug).map(e => e.to);
  const rdeps = edges.filter(e => e.to === slug).map(e => e.from);
  const parts: string[] = [];

  if (deps.length > 0) parts.push(`依赖: ${deps.join(', ')}`);

  if (rdeps.length > 0) parts.push(`被依赖: ${rdeps.join(', ')}`);

  return parts.join('\n') || '无';
}

function componentBrief(ctx: EnrichContext, component: ManifestComponent): ComponentBrief {
  return {
    slug: component.slug,
    responsibilities: (component.responsibilities ?? []).join('; '),
    facts: ctx.moduleDocs.get(component.slug) ?? '',
    call_chains: extractRelevantCallChains(ctx.callChains, component.slug),
    deps: extractDeps(ctx.manifest, component.slug),
  };
}

function architectureBrief(ctx: EnrichContext, needed: boolean): ArchitectureBrief {
  return {
    needed,
    modules: (ctx.manifest.components ?? []).map(c => `- ${c.slug}: ${(c.responsibilities ?? []).join('; ')}`).join('\n'),
    edges: (ctx.manifest.edges ?? []).map(e => `${e.from} → ${e.to} (${e.relation ?? 'DEPENDS_ON'})`).join('\n'),
    interfaces: ctx.indexMd.slice(0, 800),
  };
}

/** What the tool answered for one doc: its text, or why it could not answer. */
export interface DocReply {
  text: string;
  failure: string;
}

/** Writes a component's doc, or says why it has none. */
async function writeComponentDoc(docsDir: string, project: string, slug: string, reply: DocReply): Promise<boolean> {
  if (reply.failure) {
    log.warn(`deep-enrich[${project}]: Skipping component ${slug}: ${reply.failure}`);

    return false;
  }

  if (!reply.text) return false;

  try {
    assertSafeResourceName(slug);
  } catch (e) {
    log.warn(`deep-enrich[${project}]: Skipping unsafe component slug "${slug}": ${e instanceof Error ? e.message : String(e)}`);

    return false;
  }

  await writeGeneratedFile(docsDir, `${slug}.md`, reply.text);
  log.debug(`deep-enrich[${project}]: Component doc written: ${path.join(docsDir, `${slug}.md`)}`);

  return true;
}

/** Writes the architecture overview, or says why there is none. */
async function writeArchitectureDoc(docsDir: string, project: string, reply: DocReply): Promise<boolean> {
  if (reply.failure) {
    log.warn(`deep-enrich[${project}]: Architecture overview generation failed, skipping: ${reply.failure}`);

    return false;
  }

  if (!reply.text.trim()) {
    log.warn(`deep-enrich[${project}]: Architecture overview: AI returned empty, skipping write`);

    return false;
  }

  await writeGeneratedFile(docsDir, 'architecture.md', reply.text);
  log.debug(`deep-enrich[${project}]: Architecture overview written: ${architectureDocPath(docsDir)}`);

  return true;
}

// ─── Phase 3: 确定性图谱文档 ───────────────────────────────

async function runPhaseGraph(project: string, evidenceDir: string, ctx: EnrichContext, docsDir: string): Promise<void> {
  log.info(`deep-enrich[${project}]: Phase 3 — Generating deterministic graph docs`);

  const interfacesMd = await readFileSafe(path.join(evidenceDir, 'interfaces.md'));

  const g1 = buildG1RelationsDoc(ctx.manifest);
  const g2 = buildG2DataflowDoc(ctx.callChains);
  const g3 = buildG3InterfacesDoc(interfacesMd);
  const g4 = buildG4ErrorCodeDoc(ctx.manifest, ctx.moduleDocs);
  const g7 = buildG7RiskDoc(ctx.manifest);
  const g8 = buildG8ConfigDoc(ctx.manifest.components ?? [], ctx.moduleDocs);
  const g9 = buildG9ConstraintDoc();

  await Promise.all([
    writeGeneratedFile(docsDir, 'graph-g1-relations.md', g1),
    writeGeneratedFile(docsDir, 'graph-g2-dataflow.md', g2),
    writeGeneratedFile(docsDir, 'graph-g3-interfaces.md', g3),
    writeGeneratedFile(docsDir, 'graph-g4-errors.md', g4),
    writeGeneratedFile(docsDir, 'graph-g7-risks.md', g7),
    writeGeneratedFile(docsDir, 'graph-g8-config.md', g8),
    writeGeneratedFile(docsDir, 'graph-g9-constraints.md', g9),
  ]);
  log.debug(`deep-enrich[${project}]: Graph docs written: ${docsDir}`);
}

// ─── Phase 4: AI 图谱（G5 场景序列图 + G6 知识图谱三元组）──────────

interface GraphConfidence {
  label: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  score: number;
}

function graphConfidence(edge: ManifestEdge): GraphConfidence {
  // A missing label is not evidence. Keep it explicitly ambiguous instead of
  // manufacturing an extracted relationship (or using the forbidden 0.5 default).
  const label = edge.confidence === 'EXTRACTED' || edge.confidence === 'INFERRED' || edge.confidence === 'AMBIGUOUS'
    ? edge.confidence
    : 'AMBIGUOUS';

  const fallback = label === 'EXTRACTED' ? 1 : label === 'INFERRED' ? 0.8 : 0.3;
  const score = edge.weight !== undefined && edge.weight > 0 && edge.weight <= 1 ? edge.weight : fallback;

  return { label, score };
}

function buildG6Content(project: string, manifest: Manifest): string {
  const edges = manifest.edges ?? [];

  const lines = [
    `# ${project} — Knowledge Graph Triples`,
    '<!-- search-anchor: knowledge graph, triples, multi-hop reasoning, 传递依赖, 知识图谱, 三元组 -->',
    '',
    '## Ontology definition',
    '',
    '### Entity types',
    'Component',
    '',
    '### Relationship types',
    'The extracted relation labels below are the relationship types for this project.',
    '',
    '## Explicit triples',
    '',
    '| Subject | Predicate | Object | Protocol/Scenario | Confidence | Score |',
    '|---------|-----------|--------|-------------------|------------|-------|',
  ];

  if (edges.length === 0) {
    lines.push('| — | — | — | No extracted dependency edges | AMBIGUOUS | 0.30 |', '');
    lines.push('## Multi-hop dependency path index', '', 'No dependency paths can be indexed until extraction finds graph edges.', '');
    lines.push('## Reverse reachability index', '', 'No reverse-reachability paths are available.', '');

    return lines.join('\n');
  }

  for (const edge of edges) {
    const { label, score } = graphConfidence(edge);
    lines.push(`| ${edge.from} | ${edge.relation ?? 'DEPENDS_ON'} | ${edge.to} | ${edge.protocol ?? '—'} | ${label} | ${score.toFixed(2)} |`);
  }

  const adjacency = new Map<string, ManifestEdge[]>();
  const reverse = new Map<string, ManifestEdge[]>();

  for (const edge of edges) {
    const forward = adjacency.get(edge.from) ?? [];
    forward.push(edge);
    adjacency.set(edge.from, forward);
    const incoming = reverse.get(edge.to) ?? [];
    incoming.push(edge);
    reverse.set(edge.to, incoming);
  }

  const nodes = [...new Set(edges.flatMap(({ from, to }) => [from, to]))].sort();
  lines.push('', '## Multi-hop dependency path index', '', '| Query pattern | Example path |', '|---------------|--------------|');

  for (const source of nodes) {
    const queue: Array<{ node: string; path: string[]; visited: Set<string> }> = [
      { node: source, path: [source], visited: new Set([source]) },
    ];

    let firstMultiHop: string[] | undefined;

    while (queue.length > 0 && !firstMultiHop) {
      const current = queue.shift()!;

      for (const edge of adjacency.get(current.node) ?? []) {
        // Keep separately discovered paths even when their destination is also
        // directly reachable. Only cycles on the current path are excluded.
        if (current.visited.has(edge.to)) continue;
        const nextPath = [...current.path, `(${edge.relation ?? 'DEPENDS_ON'})`, edge.to];

        if (nextPath.length >= 5) {
          firstMultiHop = nextPath;
          break;
        }

        const visited = new Set(current.visited);
        visited.add(edge.to);
        queue.push({ node: edge.to, path: nextPath, visited });
      }
    }

    if (firstMultiHop) lines.push(`| What does ${source} indirectly depend on? | ${firstMultiHop.join(' → ')} |`);
  }

  if (!lines.some((line) => line.startsWith('| What does '))) {
    lines.push('| No indirect dependency path was extracted | — |');
  }

  const MAX_REVERSE_PREDECESSORS = 32;
  const MAX_REVERSE_PATHS = 8;
  lines.push(
    '',
    '## Reverse reachability index',
    '',
    `| Target node | Reachable predecessors | Nearest predecessors (max ${MAX_REVERSE_PREDECESSORS}) | Representative paths (max ${MAX_REVERSE_PATHS}) |`,
    '|-------------|------------------------|-------------------------------|------------------------------|',
  );

  for (const target of nodes) {
    // Breadth-first over incoming edges: each predecessor is reached once, by a
    // shortest route, so work stays linear in the graph and the nearest
    // predecessors come first. Rows show the full count, a bounded sample of
    // names, and routes for the nearest few.
    const hop = new Map<string, { distance: number; next: string; relation: string }>();
    let frontier = [target];

    for (let distance = 1; frontier.length > 0; distance++) {
      const nextFrontier: string[] = [];

      for (const node of frontier) {
        for (const edge of reverse.get(node) ?? []) {
          if (edge.from === target || hop.has(edge.from)) continue;
          hop.set(edge.from, { distance, next: node, relation: edge.relation ?? 'DEPENDS_ON' });
          nextFrontier.push(edge.from);
        }
      }

      frontier = nextFrontier;
    }

    if (hop.size === 0) continue;

    const routeFrom = (node: string): string => {
      const segments = [node];
      let current = node;

      // A one-hop route repeats a triple listed above. When a direct
      // predecessor also reaches the target through another direct
      // predecessor (Api → Service → Store), show that route instead.
      const bridge = hop.get(node)?.distance === 1
        ? adjacency.get(node)?.find(edge => edge.to !== node && hop.get(edge.to)?.distance === 1)
        : undefined;

      if (bridge) {
        segments.push(`(${bridge.relation ?? 'DEPENDS_ON'})`, bridge.to);
        current = bridge.to;
      }

      for (let link = hop.get(current); link; link = hop.get(current)) {
        segments.push(`(${link.relation})`, link.next);
        current = link.next;
      }

      return segments.join(' → ');
    };

    const shown = [...hop.keys()].slice(0, MAX_REVERSE_PREDECESSORS);
    const hidden = hop.size - shown.length;
    const names = hidden > 0 ? `${shown.join(', ')}, … (+${hidden} more)` : shown.join(', ');
    const routes = shown.slice(0, MAX_REVERSE_PATHS).map(routeFrom);

    if (hop.size > routes.length) routes.push(`… ${routes.length} of ${hop.size} routes shown`);
    lines.push(`| ${target} | ${hop.size} | ${names} | ${routes.join('; ')} |`);
  }

  lines.push('');

  return lines.join('\n');
}

async function writeQualityReports(
  evidenceDir: string,
  docsDir: string,
  project: string,
  flags: { g5Generated: boolean; g6Generated: boolean },
): Promise<void> {
  const reviewDir = path.join(evidenceDir, '_review');
  await mkdir(reviewDir, { recursive: true });
  const graphFiles = ['graph-g1-relations.md', 'graph-g2-dataflow.md', 'graph-g3-interfaces.md', 'graph-g4-errors.md', 'graph-g5-scenarios.md', 'graph-g6-triples.md', 'graph-g7-risks.md', 'graph-g8-config.md', 'graph-g9-constraints.md'];
  const present: string[] = [];

  for (const file of graphFiles) {
    if (await pathExists(path.join(docsDir, file))) present.push(file);
  }

  await writeGeneratedFile(reviewDir, 'k3-consistency-check.md', [
    '# Cross-Document Consistency Check Report', '',
    `Project: ${project}`, '',
    '## Result', '',
    `- Graph documents present: ${present.length}/${graphFiles.length}`,
    `- Structural presence check: ${present.length === graphFiles.length ? 'completed; all graph files are present.' : 'incomplete; missing graph files remain.'}`,
    '- Contradiction comparison: deferred; this pass does not compare component prose with graph semantics.',
    '- Semantic component-document cross-check: deferred when AI component documents are unavailable; no contradiction count is claimed.',
    '- Unverified claims remain labelled in the generated G documents.',
    '',
  ].join('\n'));
  await writeGeneratedFile(reviewDir, 'k4-quality-report.md', [
    '# Knowledge Base Quality Report', '',
    `Project: ${project}`, '',
    '## Deterministic checks', '',
    `- Graph document files: ${present.length}/${graphFiles.length} present.`,
    `- G5 AI scenarios: ${flags.g5Generated ? 'generated; scenario-count and coverage require review' : 'deferred (AI unavailable)'}.`,
    `- G6 extracted-edge availability: ${flags.g6Generated ? 'available' : 'not available'}.`,
    '- Confidence labels: emitted for deterministic relationships; missing labels remain AMBIGUOUS rather than becoming EXTRACTED.',
    '',
    '## K4 end-to-end validation', '',
    '- Deferred: no standardised question set or product-rule corpus is available to execute answer-quality tests.',
    '- Boundary: consumers must answer [UNVERIFIED] rather than inventing missing code, config, or business-rule facts.',
    '',
  ].join('\n'));
}

/** What the scenarios prompt says of the project, and whether G5 is still to be written. */
export interface ScenariosBrief {
  needed: boolean;
  architecture: string;
  call_chains: string;
  modules: string;
}

const NO_SCENARIOS: ScenariosBrief = { needed: false, architecture: '', call_chains: '', modules: '' };

/** Writes G6 and decides whether G5 is to be asked for: not when it exists, nor without two modules and an architecture doc. */
async function runPhaseAiGraph(project: string, ctx: EnrichContext, docsDir: string): Promise<ScenariosBrief> {
  log.info(`deep-enrich[${project}]: Phase 4 — Generating AI graph docs (G5/G6)`);

  // G6: deterministic knowledge-graph triples (no AI required).
  await writeGeneratedFile(docsDir, 'graph-g6-triples.md', buildG6Content(project, ctx.manifest));
  // The former G6 filename was a different document and must not remain
  // discoverable after the router switches to the triples document.
  await removeIfExists(path.join(docsDir, 'graph-g6-multihop.md'));
  log.debug(`deep-enrich[${project}]: G6 knowledge-graph triples written`);

  if (await pathExists(path.join(docsDir, 'graph-g5-scenarios.md'))) return NO_SCENARIOS;

  if (ctx.moduleDocs.size < 2) {
    log.warn(`deep-enrich[${project}]: Insufficient modules (${ctx.moduleDocs.size} < 2), skipping G5`);

    return NO_SCENARIOS;
  }

  const architectureMd = await readFileSafe(architectureDocPath(docsDir));

  if (!architectureMd.trim()) {
    log.warn(`deep-enrich[${project}]: No architecture doc, skipping G5 scenarios`);

    return NO_SCENARIOS;
  }

  const moduleList = [...ctx.moduleDocs.entries()]
    .map(([name, content]) => `${name}: ${content.slice(0, 200)}`)
    .join('\n');

  return {
    needed: true,
    architecture: architectureMd.slice(0, 2000),
    call_chains: ctx.callChains.slice(0, 1500),
    modules: moduleList.slice(0, 1000),
  };
}

/** Writes G5, or says why there is none. */
async function writeScenariosDoc(docsDir: string, project: string, reply: DocReply): Promise<void> {
  if (reply.failure) {
    log.warn(`deep-enrich[${project}]: G5 scenario generation failed, skipping: ${reply.failure}`);

    return;
  }

  if (!reply.text.trim()) return;
  await writeGeneratedFile(docsDir, 'graph-g5-scenarios.md', reply.text);
  log.debug(`deep-enrich[${project}]: G5 scenario diagrams written`);
}

// ─── Phase 5: 索引增强（router.md + per-project index.md 重写）──

async function runPhaseIndexEnhance(
  target: DeepEnrichTarget,
  ctx: EnrichContext,
  docsDir: string,
  graphFlags: { g5Generated: boolean; g6Generated: boolean },
): Promise<void> {
  const { project, wikiRoot } = target;
  const evidenceDir = evidenceDirOf(target);
  log.info(`deep-enrich[${project}]: Phase 5 — Index enhancement`);

  const { graphReadmeTemplate } = await import('./wiki-engine/adapters/templates.js');

  // 写入 graph/README.md 路由分发表（按实际生成情况动态渲染）
  const graphReadme = graphReadmeTemplate(project, {
    hasG5: graphFlags.g5Generated,
    hasG6: graphFlags.g6Generated,
  });

  await writeGeneratedFile(docsDir, 'README.md', graphReadme);
  await writeGeneratedFile(docsDir, 'graph-coverage.md', buildGComparisonDoc(project, graphFlags));
  log.debug(`deep-enrich[${project}]: graph/README.md routing table written`);

  // 增量更新顶层 router.md 和 index.md（追加/更新当前项目条目，不覆盖其他项目）
  const domainsJson = await readFileSafe(path.join(evidenceDir, '_domains.json'));
  let keywords: string[] = [];
  let description = '';

  try {
    const domains = DomainsFileSchema.safeParse(JSON.parse(domainsJson)).data;
    keywords = domains?.keywords ?? [];
    description = domains?.description ?? '';
  } catch { /* no _domains.json */ }

  // router.md: 检查当前项目是否已有条目，无则追加
  const routerPath = path.join(wikiRoot, 'router.md');
  const routerContent = await readFileSafe(routerPath);
  const projectLink = `[[evidence/code/${project}/index]]`;

  if (routerContent && !routerContent.includes(projectLink)) {
    const kw = keywords.length > 0 ? ` [${keywords.slice(0, 5).join(', ')}]` : '';
    const desc = description ? ` — ${description}` : ' — 代码知识';
    const line = `- ${projectLink}${desc}${kw}\n`;
    await writeFile(routerPath, routerContent.trimEnd() + '\n' + line, 'utf-8');
  }

  // index.md: 检查当前项目是否已有条目，无则追加导航块
  const indexPath = path.join(wikiRoot, 'index.md');
  const indexContent = await readFileSafe(indexPath);

  if (indexContent && !indexContent.includes(`evidence/code/${project}/`)) {
    const navBlock = [
      `### ${project}`, '',
      `- [overview.md](./evidence/code/${project}/overview.md) — 架构概览`,
      `- [modules/](./evidence/code/${project}/modules/) — 模块级摘要`,
      `- [docs/](./evidence/code/${project}/docs/) — G-document`,
      '',
    ].join('\n');

    const navHeader = '## Navigation';
    const navSection = indexContent.indexOf(navHeader);

    if (navSection > 0) {
      // 插入在 ## Navigation 标题行之后
      const afterHeader = navSection + navHeader.length;
      const updated = indexContent.slice(0, afterHeader) + '\n\n' + navBlock + indexContent.slice(afterHeader);
      await writeFile(indexPath, updated, 'utf-8');
    } else {
      await writeFile(indexPath, indexContent.trimEnd() + '\n\n' + navBlock, 'utf-8');
    }
  }

  log.debug(`deep-enrich[${project}]: Index incremental update complete`);
}

function architectureDocPath(docsDir: string): string {
  return path.join(docsDir, 'architecture.md');
}

async function existingComponentSlugs(docsDir: string, slugs: string[]): Promise<string[]> {
  const found: string[] = [];

  for (const slug of slugs) {
    try {
      assertSafeResourceName(slug);
    } catch {
      continue;
    }

    if (await pathExists(path.join(docsDir, `${slug}.md`))) found.push(slug);
  }

  return found;
}

async function collectMissingAiDocs(
  docsDir: string,
  slugs: string[],
): Promise<{ missingComponents: string[]; missingArchitecture: boolean }> {
  const existing = new Set(await existingComponentSlugs(docsDir, slugs));

  return {
    missingComponents: slugs.filter((slug) => !existing.has(slug)),
    missingArchitecture: !(await pathExists(architectureDocPath(docsDir))),
  };
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
}

/** Drop AI docs that belong to a previous extract so file-based resume retries them. */
async function invalidateStaleAiDocs(docsDir: string, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    try {
      assertSafeResourceName(slug);
    } catch {
      continue;
    }

    await removeIfExists(path.join(docsDir, `${slug}.md`));
  }

  await removeIfExists(architectureDocPath(docsDir));
  await removeIfExists(path.join(docsDir, 'graph-g5-scenarios.md'));
  await removeIfExists(path.join(docsDir, 'graph-g6-multihop.md'));
}

// ─── Steps ──────────────────────────────────────────────────

/** Where deep enrichment reads the evidence of `project` and writes its docs. */
export interface DeepEnrichTarget {
  project: string;
  wikiRoot: string;
  /** Only the manifest's first components, for cost; 0 or undefined takes every one. */
  maxModules?: number;
}

function evidenceDirOf(target: DeepEnrichTarget): string {
  return path.join(target.wikiRoot, 'evidence', 'code', target.project);
}

/** The target a verb's flags name, or why they name none: a codebase outside evidence/code/, or a bad --max-modules. */
function targetOf(flags: { wikiRoot: string; codebase: string; maxModules: string }): { ok: true; target: DeepEnrichTarget } | { ok: false; message: string } {
  const maxModules = z.coerce.number().int().min(0).safeParse(flags.maxModules);

  if (!maxModules.success) return { ok: false, message: `--max-modules ${flags.maxModules} is not a whole number from 0. Pass 0 to take every component.` };
  const wikiRoot = path.resolve(flags.wikiRoot);
  const codeRoot = path.join(wikiRoot, 'evidence', 'code');

  try {
    assertWithinRoot(codeRoot, path.join(codeRoot, flags.codebase));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, target: { project: flags.codebase, wikiRoot, maxModules: maxModules.data } };
}

/** The evidence context, with the manifest's components cut to `maxModules`. */
async function limitedContext(evidenceDir: string, maxModules: number | undefined): Promise<EnrichContext> {
  const ctx = await loadContext(evidenceDir);
  const components = ctx.manifest.components ?? [];

  if (maxModules && components.length > maxModules) ctx.manifest = { ...ctx.manifest, components: components.slice(0, maxModules) };

  return ctx;
}

/** What the plan step found to do: the components still without a doc, and the architecture overview. */
export interface DeepEnrichPlan {
  components: ComponentBrief[];
  architecture: ArchitectureBrief;
}

/**
 * The `plan` step: refuses a symbolic link on the way to the docs, drops the AI docs a newer extract made stale, and
 * lists what is missing. Undefined when the manifest has no component, which it says.
 */
async function plan(target: DeepEnrichTarget): Promise<DeepEnrichPlan | undefined> {
  const { project, wikiRoot, maxModules } = target;
  const evidenceDir = evidenceDirOf(target);
  const docsDir = path.join(evidenceDir, 'docs');

  log.info(`deep-enrich[${project}]: Starting deep knowledge generation, evidenceDir=${evidenceDir}`);
  const ctx = await loadContext(evidenceDir);
  const all = ctx.manifest.components ?? [];

  if (all.length === 0) {
    log.warn(`deep-enrich[${project}]: No components in _manifest.json, aborting`);

    return undefined;
  }

  await assertSafeEvidencePath(wikiRoot, evidenceDir);
  await assertSafeOutputDir(docsDir);
  await assertSafeOutputDir(path.dirname(progressPath(evidenceDir)));

  if (maxModules && all.length > maxModules) {
    log.info(`deep-enrich[${project}]: Limited to first ${maxModules} components (${all.length} total)`);
    ctx.manifest = { ...ctx.manifest, components: all.slice(0, maxModules) };
  }

  const components = ctx.manifest.components ?? [];
  const allSlugs = components.map(c => c.slug);
  const progress = await loadProgress(evidenceDir, project, allSlugs);

  // A newer extract rewrites _manifest.json without clearing docs/. File-based
  // resume would otherwise keep old component/architecture/G5 docs forever.
  const manifestTime = ctx.manifest.generatedAt;

  if (manifestTime && progress.startedAt < manifestTime) {
    log.info(
      `deep-enrich[${project}]: stale progress detected (manifest newer than progress.startedAt), invalidating AI docs`,
    );
    await invalidateStaleAiDocs(docsDir, allSlugs);
    progress.phase = 'pending';
    progress.componentsDone = [];
    progress.componentsPending = [...allSlugs];
    progress.startedAt = new Date().toISOString();
    await saveProgress(evidenceDir, progress);
  }

  // Disk is the source of truth for resume. A prior AI skip still writes
  // deterministic graph markdown, so `phase: done` + nonempty docs/ must not
  // skip missing component/architecture files.
  const existing = await existingComponentSlugs(docsDir, allSlugs);
  const pending = components.filter((c) => !existing.includes(c.slug));
  const needsArchitecture = !(await pathExists(architectureDocPath(docsDir)));
  progress.componentsDone = existing;
  progress.componentsPending = pending.map((c) => c.slug);

  if (pending.length > 0) {
    progress.phase = 'components';
    log.info(`deep-enrich[${project}]: Phase 1 — Generating ${pending.length} component design docs`);
  } else if (needsArchitecture) {
    progress.phase = 'architecture';
  }

  await saveProgress(evidenceDir, progress);

  return { components: pending.map((c) => componentBrief(ctx, c)), architecture: architectureBrief(ctx, needsArchitecture) };
}

/** Which doc the `write` step writes. */
export type DeepEnrichDoc = { kind: 'component'; slug: string } | { kind: 'architecture' };

/** The `write` step: writes one component's doc or the architecture overview from what the tool answered, or says why not. */
async function write(target: DeepEnrichTarget, doc: DeepEnrichDoc, reply: DocReply): Promise<{ written: boolean }> {
  const docsDir = path.join(evidenceDirOf(target), 'docs');

  switch (doc.kind) {
    case 'component':
      return { written: await writeComponentDoc(docsDir, target.project, doc.slug, reply) };
    case 'architecture':
      log.info(`deep-enrich[${target.project}]: Phase 2 — Generating architecture overview`);

      return { written: await writeArchitectureDoc(docsDir, target.project, reply) };
    default: {
      const unhandled: never = doc;

      return unhandled;
    }
  }
}

/** The `graph` step: writes the deterministic graph docs and G6, and says whether G5 is to be asked for. */
async function graph(target: DeepEnrichTarget): Promise<{ scenarios: ScenariosBrief }> {
  const evidenceDir = evidenceDirOf(target);
  const docsDir = path.join(evidenceDir, 'docs');
  const ctx = await limitedContext(evidenceDir, target.maxModules);
  const progress = await loadProgress(evidenceDir, target.project, (ctx.manifest.components ?? []).map(c => c.slug));

  progress.phase = 'graph';
  await saveProgress(evidenceDir, progress);
  await runPhaseGraph(target.project, evidenceDir, ctx, docsDir);
  progress.phase = 'ai-graph';
  await saveProgress(evidenceDir, progress);

  return { scenarios: await runPhaseAiGraph(target.project, ctx, docsDir) };
}

/** How a deep enrichment ended: what the shortcut prints and exits with, and which AI docs are still missing. */
export interface DeepEnrichEnd {
  text: string;
  exit_code: number;
  complete: boolean;
  missing_components: string[];
  missing_architecture: boolean;
}

/** The `finish` step: writes G5 from what the tool answered, the indexes and quality reports, and says what is missing. */
async function finish(target: DeepEnrichTarget, scenarios: DocReply): Promise<DeepEnrichEnd> {
  const { project } = target;
  const evidenceDir = evidenceDirOf(target);
  const docsDir = path.join(evidenceDir, 'docs');
  const ctx = await limitedContext(evidenceDir, target.maxModules);
  const allSlugs = (ctx.manifest.components ?? []).map(c => c.slug);
  const progress = await loadProgress(evidenceDir, project, allSlugs);

  await writeScenariosDoc(docsDir, project, scenarios);

  const graphFlags = {
    g5Generated: await pathExists(path.join(docsDir, 'graph-g5-scenarios.md')),
    g6Generated: (ctx.manifest.edges ?? []).length > 0,
  };

  progress.phase = 'index-enhance';
  await saveProgress(evidenceDir, progress);
  await runPhaseIndexEnhance(target, ctx, docsDir, graphFlags);
  await writeQualityReports(evidenceDir, docsDir, project, graphFlags);

  const missing = await collectMissingAiDocs(docsDir, allSlugs);
  const complete = missing.missingComponents.length === 0 && !missing.missingArchitecture;
  progress.componentsDone = allSlugs.filter((slug) => !missing.missingComponents.includes(slug));
  progress.componentsPending = missing.missingComponents;
  progress.phase = complete ? 'done' : (missing.missingComponents.length > 0 ? 'components' : 'architecture');
  await saveProgress(evidenceDir, progress);

  if (complete) {
    log.success(`deep-enrich[${project}]: Deep knowledge generation complete`);
  } else {
    const missingComps = missing.missingComponents.join(', ') || '(none)';
    log.warn(
      `deep-enrich[${project}]: incomplete — missing component docs: ${missingComps}, architecture: ${missing.missingArchitecture}`,
    );
  }

  const parts = [
    ...(missing.missingComponents.length > 0 ? [`missing component docs: ${missing.missingComponents.join(', ')}`] : []),
    ...(missing.missingArchitecture ? ['missing architecture.md'] : []),
  ];

  return {
    text: complete ? `Deep enrichment complete: project=${project}` : `Deep enrichment incomplete: project=${project}, ${parts.join(', ')}`,
    exit_code: complete ? 0 : 1,
    complete,
    missing_components: missing.missingComponents,
    missing_architecture: missing.missingArchitecture,
  };
}

/**
 * The `publish` step: commits and pushes the codebase's evidence and docs, with the teamwiki's router.md and index.md, to
 * the team repo that holds the teamwiki, so the next `teamai push` does not find the clone dirty. A teamwiki no team
 * repo holds has nothing to push.
 */
async function publish(target: DeepEnrichTarget): Promise<{ pushed: boolean }> {
  const { teamwikiAt } = await import('./utils/teamwiki-root.js');
  const { team } = await teamwikiAt(target.wikiRoot);

  if (!team) return { pushed: false };
  const repoPath = team.localConfig.repo.localPath;

  const paths = [evidenceDirOf(target), path.join(target.wikiRoot, 'router.md'), path.join(target.wikiRoot, 'index.md')].flatMap((published) => {
    const relative = path.relative(repoPath, published);

    return relative === '' || relative.startsWith('..') ? [] : [relative];
  });

  const { autoPushTeamRepo } = await import('./utils/git.js');
  const pushed = await autoPushTeamRepo(repoPath, `[teamai] Deep enrich: ${target.project}`, paths);

  if (pushed) log.success(`Pushed to team knowledge repo (${team.localConfig.repo.remote})`);

  return { pushed };
}

/** The steps of teamai's default teamai-codebase-deep-enrich workflow, each a `codebase` verb. */
export const DeepEnrich = { targetOf, plan, write, graph, finish, publish } as const;
