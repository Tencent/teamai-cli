import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { callClaudeParallel, getAICliName } from './utils/ai-client.js';
import { log } from './utils/logger.js';
import type { CodeFact } from './wiki-engine/adapters/index.js';
import type { InterfaceInventory } from './wiki-engine/interface-scanner.js';
import type { CodebaseOutputManifestV2, ManifestComponentV2, ManifestEdgeV2 } from './wiki-engine/manifest-schema.js';

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

interface ModuleAIResult {
  domain: string;
  responsibilities: string[];
  layer: string;
  summary: string;
}

function sanitizeForPrompt(text: string): string {
  return text.replace(/[\n\r]/g, ' ').replace(/[<>]/g, '').slice(0, 200);
}

function buildModulePrompt(moduleName: string, moduleFacts: CodeFact[], interfaceInventory: InterfaceInventory): string {
  const components = moduleFacts.filter(f => f.kind === 'component').slice(0, 10);
  const interfaces = interfaceInventory.entries.filter(e => e.component === moduleName);
  const fileList = [...new Set(moduleFacts.map(f => f.file))].slice(0, 15);

  return `<context>
模块名: ${sanitizeForPrompt(moduleName)}
文件列表: ${fileList.join(', ')}
组件 (top 10): ${components.map(c => c.name).join(', ')}
接口: ${interfaces.map(i => `${i.type}:${i.count}`).join(', ') || '无'}
</context>

分析上述代码模块，输出严格 JSON，不要任何解释文字:
{"domain": "业务域名称(如计费/调度/存储/网关/测试)", "responsibilities": ["职责1", "职责2", "职责3"], "layer": "entry|orchestration|service|data", "summary": "一句话描述该模块的核心功能"}`;
}

function buildDomainPrompt(
  project: string,
  moduleResults: Array<{ name: string; result: ModuleAIResult }>,
  interfaceInventory: InterfaceInventory,
): string {
  const modules = moduleResults.map(m =>
    `${m.name}: domain=${m.result.domain}, layer=${m.result.layer}, summary=${m.result.summary}`
  ).join('\n');
  const ifSummary = interfaceInventory.entries.map(e => `${e.component}:${e.type}:${e.count}`).join(', ');

  return `<context>
项目名: ${sanitizeForPrompt(project)}
模块分析:
${modules}

接口清单: ${ifSummary || '无'}
</context>

这是一个代码仓库的分析结果。请判断该仓库整体属于哪个业务域，并给出：
1. domain: 该仓库的核心业务域名称（如 API网关/计费引擎/流程编排/推理服务/配置管理/部署工具/测试框架/数据管理/网关代理 等）
2. description: 一句话描述该仓库的核心职责（不超过30字）
3. keywords: 5-10个路由关键词（用于AI检索时路由到该仓库）

输出严格 JSON，不要任何解释文字:
{"domain": "域名", "description": "一句话描述", "keywords": ["关键词1", "关键词2"]}`;
}

function parseJSON<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export async function enrichWithAI(ctx: EnrichContext): Promise<EnrichResult | null> {
  const moduleEntries = [...ctx.modules.entries()].filter(([, facts]) => facts.length >= 5);

  if (moduleEntries.length === 0) {
    log.debug('enrichWithAI: no qualifying modules, skipping');
    return null;
  }

  log.debug(`enrichWithAI: ${moduleEntries.length} modules, AI model: ${getAICliName()}`);

  // Step 1: AI enrichment per module (parallel)
  const tasks = moduleEntries.map(([moduleName, moduleFacts]) => ({
    prompt: buildModulePrompt(moduleName, moduleFacts, ctx.interfaceInventory),
    parse: (raw: string) => {
      const result = parseJSON<ModuleAIResult>(raw);
      return result ? { name: moduleName, result } : null;
    },
  }));

  let moduleResults: Array<{ name: string; result: ModuleAIResult }>;
  try {
    const results = await callClaudeParallel(tasks, 3);
    moduleResults = results.filter((r): r is { name: string; result: ModuleAIResult } => r !== null);
  } catch (e) {
    log.warn(`enrichWithAI: module analysis failed (non-blocking): ${(e as Error).message}`);
    return null;
  }

  if (moduleResults.length === 0) {
    log.debug('enrichWithAI: all module analyses returned null');
    return null;
  }

  // Step 2: Repo-level domain classification (single call)
  let domains: Array<{ name: string; components: string[]; apiCount: number }> = [];
  let repoDomain = '';
  let repoDescription = '';
  let repoKeywords: string[] = [];
  try {
    const domainPrompt = buildDomainPrompt(ctx.project, moduleResults, ctx.interfaceInventory);
    const domainTasks = [{
      prompt: domainPrompt,
      parse: (raw: string) => {
        return parseJSON<{ domain: string; description: string; keywords: string[] }>(raw);
      },
    }];
    const [domainResult] = await callClaudeParallel(domainTasks, 1);
    if (domainResult) {
      repoDomain = domainResult.domain;
      repoDescription = domainResult.description;
      repoKeywords = domainResult.keywords ?? [];
      const apiCount = ctx.interfaceInventory.entries.reduce((sum, e) => sum + e.count, 0);
      domains = [{ name: repoDomain, components: moduleResults.map(m => m.name), apiCount }];
    }
  } catch {
    log.debug('enrichWithAI: domain classification failed, continuing without');
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
    // Cross-module edges based on import facts
    const moduleImports = ctx.facts.filter(f => f.kind === 'relation' && f.file.startsWith(name + '/'));
    const targetModules = new Set<string>();
    for (const imp of moduleImports) {
      const targetParts = imp.name.split('/');
      if (targetParts[0] && targetParts[0] !== name) {
        targetModules.add(targetParts[0]);
      }
    }
    for (const target of targetModules) {
      if (moduleResults.some(m => m.name === target)) {
        edges.push({
          from: name,
          to: target,
          relation: 'DEPENDS_ON',
          confidence: 'EXTRACTED',
          source: 'code-heuristic',
          reason: `${name} imports from ${target}`,
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

export async function writeManifest(manifest: CodebaseOutputManifestV2, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, '_manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
}
