import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './utils/fs.js';
import { callClaude, callClaudeParallel } from './utils/ai-client.js';
import { log } from './utils/logger.js';
import { assertSafeResourceName } from './utils/path-safety.js';

export interface DeepEnrichOptions {
  project: string;
  evidenceDir: string;  // teamwiki/evidence/code/<project>/
  wikiRoot: string;     // teamwiki/
  cacheDir?: string;    // 源码 clone 目录（可选，用于读取实际源码）
  maxModules?: number;  // 限制 AI 处理的最大组件数（费用控制）
}

interface ProgressState {
  project: string;
  phase: 'pending' | 'components' | 'architecture' | 'graph' | 'done';
  componentsDone: string[];
  componentsPending: string[];
  startedAt: string;
  updatedAt: string;
}

interface ManifestComponent {
  slug: string;
  title?: string;
  responsibilities?: string[];
  category?: string;
}

interface ManifestEdge {
  from: string;
  to: string;
  relation?: string;
}

interface Manifest {
  project?: string;
  components?: ManifestComponent[];
  edges?: ManifestEdge[];
}

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

async function loadContext(evidenceDir: string): Promise<EnrichContext> {
  const manifestRaw = await readFileSafe(path.join(evidenceDir, '_manifest.json'));
  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(manifestRaw) as Manifest;
  } catch {
    log.debug('deep-enrich: failed to parse _manifest.json');
  }

  const [indexMd, callChains, overview] = await Promise.all([
    readFileSafe(path.join(evidenceDir, 'index.md')),
    readFileSafe(path.join(evidenceDir, 'call-chains.md')),
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

const VALID_PHASES = new Set<string>(['pending', 'components', 'architecture', 'graph', 'done']);

function isValidProgressState(v: unknown, project: string): v is ProgressState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    s['project'] === project &&
    typeof s['phase'] === 'string' &&
    VALID_PHASES.has(s['phase']) &&
    Array.isArray(s['componentsDone']) &&
    Array.isArray(s['componentsPending'])
  );
}

async function loadProgress(evidenceDir: string, project: string, allComponents: string[]): Promise<ProgressState> {
  const p = progressPath(evidenceDir);
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isValidProgressState(parsed, project)) return parsed;
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
  const p = progressPath(evidenceDir);
  await mkdir(path.dirname(p), { recursive: true });
  const updated: ProgressState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(p, JSON.stringify(updated, null, 2), 'utf-8');
}

// ─── Prompt 构建 ────────────────────────────────────────────

function buildComponentPrompt(
  project: string,
  component: ManifestComponent,
  moduleFacts: string,
  relevantCallChains: string,
  deps: string,
): string {
  const moduleName = component.slug;
  const responsibilities = component.responsibilities ?? [];
  return `<context>
项目: ${project}
模块: ${moduleName}
职责: ${responsibilities.join('; ')}

核心组件（来自代码提取）:
${moduleFacts}

调用链:
${relevantCallChains}

模块依赖:
${deps}
</context>

为上述代码模块生成一份组件设计文档。必须包含以下章节：

## 🤖 AI 快速理解要点
（表格：核心职责/架构层级/上游组件/下游组件/代码入口/核心机制/数据流向/技术栈，每项不超过20字）

## 架构设计
（ASCII 架构图 + 核心子模块说明）

## 接口设计
（对外接口表：接口名/方法/路径/说明）

## 核心流程
（主要请求处理流程，步骤式描述）

直接输出 Markdown，不要任何前言或解释。`;
}

function buildArchitecturePrompt(
  project: string,
  moduleList: string,
  edges: string,
  interfaceSummary: string,
): string {
  return `<context>
项目: ${project}
模块清单:
${moduleList}

模块间依赖:
${edges}

接口统计:
${interfaceSummary}
</context>

为上述项目生成一份技术架构总览文档。必须包含：

## 项目概述
（一段话描述项目的核心定位和能力）

## 架构图
（ASCII 分层架构图，标注各模块和调用方向）

## 组件关系矩阵
（表格：组件A→组件B + 关系类型 + 通信方式）

## 核心链路
（2-3条最重要的请求处理链路，从入口到存储的完整路径）

## 技术栈
（表格：维度/技术/说明）

直接输出 Markdown，不要任何前言或解释。`;
}

// ─── 确定性图谱生成（无需 AI）─────────────────────────────

function buildG1RelationsDoc(manifest: Manifest): string {
  const edges = manifest.edges ?? [];
  if (edges.length === 0) {
    return '# 组件关系矩阵\n\n（暂无依赖边数据）\n';
  }
  const rows = edges.map(e => `| ${e.from} | ${e.to} | ${e.relation ?? 'DEPENDS_ON'} |`).join('\n');
  return `# 组件关系矩阵\n\n| 来源组件 | 目标组件 | 关系类型 |\n|----------|----------|----------|\n${rows}\n`;
}

function buildG2DataflowDoc(callChains: string): string {
  if (!callChains.trim()) {
    return '# 数据流图\n\n（暂无调用链数据）\n';
  }
  // 提取 entry→data 路径行（以 → 或 -> 连接的行）
  const lines = callChains.split('\n').filter(l => /→|->/.test(l));
  if (lines.length === 0) {
    return `# 数据流图\n\n\`\`\`\n${callChains.slice(0, 2000)}\n\`\`\`\n`;
  }
  const flowRows = lines.slice(0, 30).map(l => `| ${l.trim()} |`).join('\n');
  return `# 数据流图\n\n| 调用链路径 |\n|------------|\n${flowRows}\n`;
}

function buildG3InterfacesDoc(interfacesMd: string): string {
  if (!interfacesMd.trim()) {
    return '# 接口映射表\n\n（暂无接口数据）\n';
  }
  return `# 接口映射表\n\n${interfacesMd}\n`;
}

// ─── Phase 1: 组件设计文档 ─────────────────────────────────

function extractModuleFacts(moduleDocs: Map<string, string>, slug: string): string {
  return moduleDocs.get(slug) ?? '';
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

async function runPhaseComponents(
  opts: DeepEnrichOptions,
  ctx: EnrichContext,
  progress: ProgressState,
  docsDir: string,
): Promise<void> {
  const { project, evidenceDir } = opts;
  const components = ctx.manifest.components ?? [];
  const pending = components.filter(c => !progress.componentsDone.includes(c.slug));

  if (pending.length === 0) {
    log.info(`deep-enrich[${project}]: 组件文档全部已完成，跳过 Phase 1`);
    return;
  }

  log.info(`deep-enrich[${project}]: Phase 1 — 生成 ${pending.length} 个组件设计文档`);

  // 每批 2 个并发
  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const tasks = batch.map((comp) => {
      const moduleFacts = extractModuleFacts(ctx.moduleDocs, comp.slug);
      const relevantCallChains = extractRelevantCallChains(ctx.callChains, comp.slug);
      const deps = extractDeps(ctx.manifest, comp.slug);
      const prompt = buildComponentPrompt(project, comp, moduleFacts, relevantCallChains, deps);
      return {
        prompt,
        parse: (output: string) => output,
      };
    });

    let results: string[];
    try {
      results = await callClaudeParallel(tasks, BATCH);
    } catch (err) {
      // AggregateError — 部分可能成功，graceful fallback
      log.warn(`deep-enrich[${project}]: batch[${i}] 部分失败，逐个 fallback`);
      results = await Promise.all(
        batch.map(async (_, idx) => {
          try {
            return await callClaude(tasks[idx].prompt);
          } catch (e) {
            log.warn(`deep-enrich[${project}]: 跳过组件 ${batch[idx].slug}: ${(e as Error).message}`);
            return null as unknown as string;
          }
        }),
      );
    }

    for (let j = 0; j < batch.length; j++) {
      const comp = batch[j];
      const content = results[j];
      if (!content) continue;
      try {
        assertSafeResourceName(comp.slug);
      } catch (e) {
        log.warn(`deep-enrich[${project}]: 跳过不安全的组件 slug "${comp.slug}": ${(e as Error).message}`);
        continue;
      }
      const outPath = path.join(docsDir, `${comp.slug}.md`);
      await mkdir(docsDir, { recursive: true });
      await writeFile(outPath, content, 'utf-8');
      progress.componentsDone.push(comp.slug);
      await saveProgress(evidenceDir, progress);
      log.debug(`deep-enrich[${project}]: 组件文档写入 ${outPath}`);
    }
  }
}

// ─── Phase 2: 架构总览文档 ─────────────────────────────────

async function runPhaseArchitecture(
  opts: DeepEnrichOptions,
  ctx: EnrichContext,
  docsDir: string,
): Promise<void> {
  const { project } = opts;
  const components = ctx.manifest.components ?? [];
  const moduleList = components
    .map(c => `- ${c.slug}: ${(c.responsibilities ?? []).join('; ')}`)
    .join('\n');
  const edges = (ctx.manifest.edges ?? [])
    .map(e => `${e.from} → ${e.to} (${e.relation ?? 'DEPENDS_ON'})`)
    .join('\n');
  const interfaceSummary = ctx.indexMd.slice(0, 800);

  const prompt = buildArchitecturePrompt(project, moduleList, edges, interfaceSummary);
  log.info(`deep-enrich[${project}]: Phase 2 — 生成架构总览文档`);

  let content: string;
  try {
    content = await callClaude(prompt);
  } catch (e) {
    log.warn(`deep-enrich[${project}]: 架构总览生成失败，跳过: ${(e as Error).message}`);
    return;
  }

  if (!content.trim()) {
    log.warn(`deep-enrich[${project}]: 架构总览 AI 返回空内容，跳过写文件`);
    return;
  }

  const outPath = path.join(docsDir, 'architecture.md');
  await mkdir(docsDir, { recursive: true });
  await writeFile(outPath, content, 'utf-8');
  log.debug(`deep-enrich[${project}]: 架构总览写入 ${outPath}`);
}

// ─── Phase 3: 确定性图谱文档 ───────────────────────────────

async function runPhaseGraph(
  opts: DeepEnrichOptions,
  ctx: EnrichContext,
  docsDir: string,
): Promise<void> {
  const { project, evidenceDir } = opts;
  log.info(`deep-enrich[${project}]: Phase 3 — 生成确定性图谱文档`);

  const interfacesMd = await readFileSafe(path.join(evidenceDir, 'interfaces.md'));

  const g1 = buildG1RelationsDoc(ctx.manifest);
  const g2 = buildG2DataflowDoc(ctx.callChains);
  const g3 = buildG3InterfacesDoc(interfacesMd);

  await mkdir(docsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(docsDir, 'graph-g1-relations.md'), g1, 'utf-8'),
    writeFile(path.join(docsDir, 'graph-g2-dataflow.md'), g2, 'utf-8'),
    writeFile(path.join(docsDir, 'graph-g3-interfaces.md'), g3, 'utf-8'),
  ]);
  log.debug(`deep-enrich[${project}]: 图谱文档写入 ${docsDir}`);
}

// ─── 主函数 ─────────────────────────────────────────────────

/**
 * 对已导入仓库执行深度 AI 知识生成。
 *
 * 读取 evidenceDir 中已有的确定性提取结果，并发调用 AI 生成：
 * - Phase 1: 每个组件的设计文档（concurrency=2）
 * - Phase 2: 整体架构总览文档（单次调用）
 * - Phase 3: 确定性图谱文档（无需 AI，直接渲染）
 *
 * 支持断点续传：通过 _review/progress.json 记录已完成组件。
 *
 * @param opts DeepEnrichOptions
 */
export async function deepEnrich(opts: DeepEnrichOptions): Promise<void> {
  const { project, evidenceDir } = opts;
  const docsDir = path.join(evidenceDir, 'docs');

  log.info(`deep-enrich[${project}]: 开始深度知识生成，evidenceDir=${evidenceDir}`);

  // 1. 加载上下文
  const ctx = await loadContext(evidenceDir);
  let components = ctx.manifest.components ?? [];

  if (components.length === 0) {
    log.warn(`deep-enrich[${project}]: _manifest.json 中无组件，终止`);
    return;
  }

  if (opts.maxModules && components.length > opts.maxModules) {
    log.info(`deep-enrich[${project}]: 限制为前 ${opts.maxModules} 个组件（共 ${components.length} 个）`);
    components = components.slice(0, opts.maxModules);
    ctx.manifest = { ...ctx.manifest, components };
  }

  // 2. 初始化 progress（断点续传）
  const allSlugs = components.map(c => c.slug);
  const progress = await loadProgress(evidenceDir, project, allSlugs);

  // 3. Phase 1: 组件设计文档
  if (progress.phase === 'pending' || progress.phase === 'components') {
    progress.phase = 'components';
    await saveProgress(evidenceDir, progress);
    await runPhaseComponents(opts, ctx, progress, docsDir);
  }

  // 4. Phase 2: 架构总览
  if (progress.phase === 'components' || progress.phase === 'architecture') {
    progress.phase = 'architecture';
    await saveProgress(evidenceDir, progress);
    await runPhaseArchitecture(opts, ctx, docsDir);
  }

  // 5. Phase 3: 图谱文档
  if (progress.phase === 'architecture' || progress.phase === 'graph') {
    progress.phase = 'graph';
    await saveProgress(evidenceDir, progress);
    await runPhaseGraph(opts, ctx, docsDir);
  }

  // 6. 完成
  progress.phase = 'done';
  await saveProgress(evidenceDir, progress);
  log.success(`deep-enrich[${project}]: 深度知识生成完成`);
}
