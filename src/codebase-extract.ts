/**
 * Codebase knowledge extraction and graph building.
 *
 * Knowledge graph architecture and wiki protocol based on Team Wiki
 * by @lurkacai. Core concepts: structured code facts, graph-index,
 * evidence pages, router/hot/index navigation, and gaps detection.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';

import {
  collectCode,
  extractCodeFacts,
  buildCodeGraph,
  detectCodeIncrementalChanges,
  scanInterfaces,
  traceCallChains,
  buildIndexHubOverlay,
  mergeGraphs,
  saveGraphIndex,
} from './wiki-engine/adapters/index.js';
import type { CodeFact, InterfaceInventory, CallChain } from './wiki-engine/adapters/index.js';
import {
  loadFactsCache,
  saveFactsCache,
  loadInterfacesCache,
  saveInterfacesCache,
  pruneFactsByFiles,
  mergeInterfaceInventories,
} from './wiki-engine/code-knowledge/code-incremental.js';
import { writeIfChanged } from './utils/fs.js';
import type { GraphIndex } from './wiki-engine/core/graph-index.schema.js';
import { routerTemplate, indexTemplate, HOT_TEMPLATE } from './wiki-engine/adapters/templates.js';
import type { DomainGroup, IndexStats } from './wiki-engine/adapters/templates.js';

export interface ExtractCodebaseOptions {
  path?: string;
  incremental?: boolean;
  json?: boolean;
  project?: string;
  maxFiles?: number;
  skipEnrich?: boolean;
  /** 产出根目录（teamwiki/ 写到此目录下）。默认与 path 相同。 */
  outputRoot?: string;
  /** Remote repository URL, persisted into source-manifest.json baseline. */
  repoUrl?: string;
  /** Branch name, persisted into source-manifest.json baseline. */
  branch?: string;
  /** Source MR/PR URL to record as ingested into source-manifest.json (P5). */
  sourceMrUrl?: string;
}

interface ExtractResult {
  project: string;
  filesScanned: number;
  facts: { total: number; byKind: Record<string, number> };
  graph: { nodes: number; edges: number };
  incremental: boolean;
  outputDir: string;
}

interface KnowledgeGap {
  id: string;
  kind: string;
  description: string;
  source: string;
}

function detectKnowledgeGaps(
  facts: CodeFact[],
  graph: GraphIndex,
  files: Array<{ relativePath: string }>,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];
  const scannedFiles = new Set(files.map((f) => f.relativePath));
  const nodeSlugs = new Set(graph.nodes.map((n) => n.slug));
  const connectedNodes = new Set<string>();
  for (const edge of graph.edges) {
    connectedNodes.add(edge.from);
    connectedNodes.add(edge.to);
  }

  // 1. 未解析的外部依赖：import target 不在扫描范围内
  const relationFacts = facts.filter((f) => f.kind === 'relation');
  const unresolvedImports = new Set<string>();
  for (const rel of relationFacts) {
    const target = rel.name;
    if (target.startsWith('.')) continue; // 相对路径跳过
    if (target.startsWith('node:')) continue; // Node 内置模块跳过
    const matchesAnyFile = [...scannedFiles].some((f) => f.includes(target.replace(/\//g, path.sep)));
    if (!matchesAnyFile) {
      unresolvedImports.add(target);
    }
  }
  if (unresolvedImports.size > 5) {
    gaps.push({
      id: 'unresolved-external-deps',
      kind: 'EXTERNAL_DEP_UNDOCUMENTED',
      description: `${unresolvedImports.size} external dependencies not documented (e.g. ${[...unresolvedImports].slice(0, 3).join(', ')})`,
      source: 'relation facts',
    });
  }

  // 2. 接口无实现：有 interface 声明但图谱中无 IMPLEMENTS 边指向它
  const interfaces = facts.filter((f) => f.kind === 'interface');
  const components = facts.filter((f) => f.kind === 'component');
  const componentNames = new Set(components.map((c) => c.name.toLowerCase()));
  const unimplemented: string[] = [];
  for (const iface of interfaces) {
    const name = iface.name.toLowerCase();
    const hasImpl = componentNames.has(name) ||
      componentNames.has(name.replace(/^i/, '').toLowerCase()) ||
      componentNames.has((name + 'impl').toLowerCase());
    if (!hasImpl) {
      unimplemented.push(iface.name);
    }
  }
  if (unimplemented.length > 3) {
    gaps.push({
      id: 'interface-no-impl',
      kind: 'IMPL_MISSING',
      description: `${unimplemented.length} interfaces with no matching implementation (e.g. ${unimplemented.slice(0, 3).join(', ')})`,
      source: 'interface facts',
    });
  }

  // 3. 孤立组件：有节点但与图谱中其他节点无任何连接
  const orphanNodes = graph.nodes.filter(
    (n) => !connectedNodes.has(n.slug),
  );
  if (orphanNodes.length > 5 && orphanNodes.length > graph.nodes.length * 0.3) {
    gaps.push({
      id: 'high-orphan-ratio',
      kind: 'LOW_CONNECTIVITY',
      description: `${orphanNodes.length}/${graph.nodes.length} nodes have no graph connections, dependencies may not be fully extracted`,
      source: 'graph-index.json',
    });
  }

  // 4. 无错误处理模式：有组件但无 error 类型定义
  const errorFacts = facts.filter((f) => f.kind === 'error');
  if (components.length > 10 && errorFacts.length === 0) {
    gaps.push({
      id: 'no-error-patterns',
      kind: 'ERROR_HANDLING_UNDOCUMENTED',
      description: `Project has ${components.length} components but no error types detected, error handling may be undocumented`,
      source: 'code scan',
    });
  }

  // 5. 无配置项目：有组件但无 config/env 提取
  const configFacts = facts.filter((f) => f.kind === 'config');
  if (components.length > 10 && configFacts.length === 0) {
    gaps.push({
      id: 'no-config-detected',
      kind: 'CONFIG_UNDOCUMENTED',
      description: `Project has ${components.length} components but no config/env vars detected, configuration may be undocumented`,
      source: 'code scan',
    });
  }

  return gaps;
}

function buildEvidencePages(
  facts: CodeFact[],
  project: string,
  interfaceInventory?: InterfaceInventory,
  callChains?: CallChain[],
): Map<string, string> {
  const pages = new Map<string, string>();
  const byKind = new Map<string, CodeFact[]>();

  for (const fact of facts) {
    if (fact.kind === 'relation') continue;
    const existing = byKind.get(fact.kind) ?? [];
    existing.push(fact);
    byKind.set(fact.kind, existing);
  }

  for (const [kind, kindFacts] of byKind) {
    const lines = [
      '---',
      `title: ${project} ${kind}`,
      'domain: code-knowledge',
      `source:`,
      ...Array.from(new Set(kindFacts.map((f) => f.file))).map((f) => `  - ${f}`),
      '---',
      '',
      `# ${kind.charAt(0).toUpperCase() + kind.slice(1)}`,
      '',
    ];

    for (const fact of kindFacts) {
      lines.push(`- \`${fact.name}\` ← ${fact.file}:${fact.lineStart} [${fact.confidence}]`);
      if (fact.detail) {
        lines.push(`  \`\`\`\n  ${fact.detail.trim()}\n  \`\`\``);
      }
    }

    pages.set(`${kind}.md`, lines.join('\n'));
  }

  const relationFacts = facts.filter((f) => f.kind === 'relation');
  if (relationFacts.length > 0) {
    const byDir = new Map<string, CodeFact[]>();
    for (const fact of relationFacts) {
      const seg = fact.file.split('/')[0] || '_root';
      const existing = byDir.get(seg) ?? [];
      existing.push(fact);
      byDir.set(seg, existing);
    }
    for (const [seg, segFacts] of byDir) {
      const lines = [
        '---',
        `title: ${project} relations (${seg})`,
        'domain: code-knowledge',
        '---',
        '',
        `# Relations (${seg})`,
        '',
      ];
      for (const fact of segFacts) {
        lines.push(`- \`${fact.name}\` ← ${fact.file}:${fact.lineStart}`);
      }
      pages.set(`relation-${seg}.md`, lines.join('\n'));
    }
  }

  // Interface Inventory page
  if (interfaceInventory && interfaceInventory.entries.length > 0) {
    const ifLines = [
      '---',
      `title: ${project} interface inventory`,
      'domain: code-knowledge',
      '---',
      '',
      '# Interface Inventory',
      '',
      '| Component | Type | Count | Confidence | Patterns |',
      '|-----------|------|-------|------------|----------|',
    ];
    for (const entry of interfaceInventory.entries) {
      const patterns = entry.patterns.slice(0, 2).map(p => `\`${p.trim()}\``).join(', ');
      ifLines.push(`| ${entry.component} | ${entry.type} | ${entry.count} | ${entry.confidence} | ${patterns} |`);
    }
    ifLines.push('');
    pages.set('interfaces.md', ifLines.join('\n'));
  }

  // Dependency Paths page
  if (callChains && callChains.length > 0) {
    const ccLines = [
      '---',
      `title: ${project} dependency paths`,
      'domain: code-knowledge',
      '---',
      '',
      '# Dependency Paths',
      '',
      'Static import dependency paths (not runtime call traces).',
      '',
      `${callChains.length} dependency path(s) traced from entry points (max depth 4).`,
      '',
    ];
    for (const chain of callChains.slice(0, 20)) {
      ccLines.push(`## ${chain.entryPoint}`);
      ccLines.push('');
      for (const step of chain.steps) {
        const indent = step.layer === 'entry' ? '' : step.layer === 'orchestration' ? '  ' : step.layer === 'service' ? '    ' : '      ';
        ccLines.push(`${indent}- [${step.layer}] \`${step.symbol}\` ← ${step.file}:${step.lineStart}`);
      }
      ccLines.push('');
    }
    pages.set('dependency-paths.md', ccLines.join('\n'));
  }

  const indexLines = [
    '---',
    `title: ${project} code knowledge index`,
    'domain: code-knowledge',
    '---',
    '',
    `# ${project}`,
    '',
    `Facts: ${facts.length} | Pages: ${pages.size}`,
    '',
  ];

  // Interface summary in index
  if (interfaceInventory && interfaceInventory.entries.length > 0) {
    const byType: Record<string, number> = {};
    for (const e of interfaceInventory.entries) {
      byType[e.type] = (byType[e.type] ?? 0) + e.count;
    }
    indexLines.push('## Interface Inventory');
    indexLines.push('');
    indexLines.push(`| Type | Count |`);
    indexLines.push(`|------|-------|`);
    for (const [type, count] of Object.entries(byType)) {
      indexLines.push(`| ${type} | ${count} |`);
    }
    indexLines.push('');
  }

  indexLines.push('## Pages');
  indexLines.push('');
  for (const pageName of pages.keys()) {
    indexLines.push(`- [${pageName}](./${pageName})`);
  }
  pages.set('index.md', indexLines.join('\n'));

  return pages;
}

function buildModuleSummaries(
  facts: CodeFact[],
  graph: GraphIndex,
  project: string,
): Map<string, string> {
  const modules = new Map<string, CodeFact[]>();

  // 按顶层目录分组（排除 relation facts）
  for (const fact of facts) {
    if (fact.kind === 'relation') continue;
    const parts = fact.file.split('/');
    const module = parts.length > 1 ? parts[0] : '_root';
    const existing = modules.get(module) ?? [];
    existing.push(fact);
    modules.set(module, existing);
  }

  const summaries = new Map<string, string>();

  // 只为有 5+ 个 facts 的模块生成摘要
  for (const [module, moduleFacts] of modules) {
    if (moduleFacts.length < 5) continue;

    // 统计该模块的引用次数（作为 edge target 的次数）
    const fileRefs = new Map<string, number>();
    for (const edge of graph.edges) {
      if (edge.to.startsWith(module + '/') || edge.to === module) {
        fileRefs.set(edge.to, (fileRefs.get(edge.to) ?? 0) + 1);
      }
    }

    // 按 kind 统计
    const kindCounts: Record<string, number> = {};
    for (const f of moduleFacts) {
      kindCounts[f.kind] = (kindCounts[f.kind] ?? 0) + 1;
    }

    // 按引用次数排序，取 top 20 核心组件
    const ranked = moduleFacts
      .filter(f => f.kind === 'component' || f.kind === 'interface')
      .map(f => ({ ...f, refs: fileRefs.get(f.file) ?? 0 }))
      .sort((a, b) => b.refs - a.refs)
      .slice(0, 20);

    // 该模块依赖的其他模块
    const depsTo = new Set<string>();
    const depsFrom = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.from.startsWith(module + '/')) {
        const targetMod = edge.to.split('/')[0];
        if (targetMod !== module) depsTo.add(targetMod);
      }
      if (edge.to.startsWith(module + '/')) {
        const sourceMod = edge.from.split('/')[0];
        if (sourceMod !== module) depsFrom.add(sourceMod);
      }
    }

    const lines = [
      '---',
      `title: ${project} — ${module} module`,
      'domain: code-knowledge',
      `source: [${module}/]`,
      '---',
      '',
      `# ${module}`,
      '',
      `**${moduleFacts.length} facts** (${Object.entries(kindCounts).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
      '',
    ];

    if (depsTo.size > 0) {
      lines.push(`**Depends on**: ${[...depsTo].join(', ')}`);
    }
    if (depsFrom.size > 0) {
      lines.push(`**Depended by**: ${[...depsFrom].join(', ')}`);
    }
    if (depsTo.size > 0 || depsFrom.size > 0) lines.push('');

    lines.push('## Core components');
    lines.push('');
    for (const item of ranked) {
      const refStr = item.refs > 0 ? ` (${item.refs} refs)` : '';
      lines.push(`- \`${item.name}\` ← ${item.file}:${item.lineStart}${refStr}`);
    }

    if (moduleFacts.some(f => f.kind === 'config')) {
      lines.push('');
      lines.push('## Config');
      lines.push('');
      for (const f of moduleFacts.filter(f => f.kind === 'config').slice(0, 10)) {
        lines.push(`- \`${f.name}\` ← ${f.file}`);
      }
    }

    if (moduleFacts.some(f => f.kind === 'error')) {
      lines.push('');
      lines.push('## Errors');
      lines.push('');
      for (const f of moduleFacts.filter(f => f.kind === 'error').slice(0, 10)) {
        lines.push(`- \`${f.name}\` ← ${f.file}`);
      }
    }

    lines.push('');
    summaries.set(`${module}.md`, lines.join('\n'));
  }

  return summaries;
}

/**
 * Generate a deterministic overview.md from facts + graph (B16).
 * Provides basic architecture context without AI calls.
 */
function buildOverview(
  facts: CodeFact[],
  graph: GraphIndex,
  project: string,
  interfaceInventory: InterfaceInventory,
  callChains: CallChain[],
): string {
  const modules = new Map<string, CodeFact[]>();
  for (const fact of facts) {
    if (fact.kind === 'relation') continue;
    const mod = fact.file.split('/')[0] || '_root';
    const existing = modules.get(mod) ?? [];
    existing.push(fact);
    modules.set(mod, existing);
  }

  const lines = [
    '---',
    `title: ${project} overview`,
    'domain: code-knowledge',
    '---',
    '',
    `# ${project}`,
    '',
    `**${facts.length} facts** extracted from ${new Set(facts.map(f => f.file)).size} files.`,
    `Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges.`,
    '',
    '## Module Structure',
    '',
    '| Module | Facts | Components | Interfaces |',
    '|--------|-------|------------|------------|',
  ];

  const sortedModules = [...modules.entries()]
    .filter(([, mf]) => mf.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);

  for (const [mod, mf] of sortedModules) {
    const comps = mf.filter(f => f.kind === 'component').length;
    const ifaces = mf.filter(f => f.kind === 'interface').length;
    lines.push(`| ${mod} | ${mf.length} | ${comps} | ${ifaces} |`);
  }

  // Module dependency direction
  lines.push('');
  lines.push('## Dependencies');
  lines.push('');
  const depMap = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const fromMod = edge.from.split('/')[0] || '_root';
    const toMod = edge.to.split('/')[0] || '_root';
    if (fromMod !== toMod) {
      const existing = depMap.get(fromMod) ?? new Set();
      existing.add(toMod);
      depMap.set(fromMod, existing);
    }
  }
  if (depMap.size > 0) {
    for (const [mod, deps] of depMap) {
      lines.push(`- **${mod}** → ${[...deps].join(', ')}`);
    }
  } else {
    lines.push('(No cross-module dependencies detected)');
  }

  // Interface summary
  if (interfaceInventory.entries.length > 0) {
    lines.push('');
    lines.push('## Interfaces');
    lines.push('');
    const byType: Record<string, number> = {};
    for (const e of interfaceInventory.entries) {
      byType[e.type] = (byType[e.type] ?? 0) + e.count;
    }
    lines.push(`Types: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(', ')}`);
  }

  // Dependency paths summary
  if (callChains.length > 0) {
    lines.push('');
    lines.push('## Key Dependency Paths');
    lines.push('');
    for (const chain of callChains.slice(0, 5)) {
      const path = chain.steps.map(s => s.symbol).join(' → ');
      lines.push(`- ${chain.entryPoint}: ${path}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export async function extractCodebase(opts: ExtractCodebaseOptions): Promise<void> {
  const root = path.resolve(opts.path || '.');
  const project = opts.project || path.basename(root);
  const maxFiles = opts.maxFiles || 200;
  const outputBase = opts.outputRoot ? path.resolve(opts.outputRoot) : root;

  const wikiRoot = path.join(outputBase, 'teamwiki');
  const evidenceDir = path.join(wikiRoot, 'evidence', 'code', project);
  const manifestPath = path.join(wikiRoot, 'source-manifest.json');

  let changedFiles: string[] | undefined;
  let deletedFiles: string[] = [];
  if (opts.incremental) {
    try {
      const changes = await detectCodeIncrementalChanges(root, manifestPath, project);
      if (changes.added.length === 0 && changes.changed.length === 0 && changes.deleted.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'up-to-date', project }));
        } else {
          console.log(chalk.green(`[extract] ${project}: no changes, skipped.`));
        }
        return;
      }
      changedFiles = [...changes.added, ...changes.changed];
      deletedFiles = changes.deleted;
      if (!opts.json) {
        console.log(chalk.dim(`[extract] incremental: ${changedFiles.length} files changed, ${deletedFiles.length} deleted`));
      }
    } catch {
      if (!opts.json) {
        console.log(chalk.dim('[extract] no manifest history, running full extraction'));
      }
    }
  }

  const { files, manifest: collectionManifest } = await collectCode({ root, maxFiles, changedFiles });
  if (files.length === 0 && !changedFiles) {
    // 全量模式下无文件
    if (opts.json) {
      console.log(JSON.stringify({ status: 'no-files', project }));
    } else {
      console.log(chalk.yellow(`[extract] ${project}: no extractable source files found.`));
    }
    return;
  }

  // 提取变更文件的新 facts
  const newFacts = files.length > 0 ? extractCodeFacts(files) : [];

  // 增量模式：加载缓存 → 剪除 → 合并
  let facts: CodeFact[];
  let interfaceInventory: InterfaceInventory;
  const indicesDir = path.join(wikiRoot, '.indices');

  if (changedFiles !== undefined) {
    // 增量模式（含 changedFiles=[] 即仅删除场景）
    const oldFacts = await loadFactsCache(indicesDir);
    const oldInterfaces = await loadInterfacesCache(indicesDir);

    // 剪除已变更/删除的旧数据
    const filesToRemove = new Set([...changedFiles, ...deletedFiles]);
    const remainingFacts = pruneFactsByFiles(oldFacts, filesToRemove);

    // 合并：旧的保留 facts + 新提取的 facts
    const merged = [...remainingFacts, ...newFacts];
    // 去重（kind:name:file，同一文件中同名同类型只保留一份）
    const seen = new Set<string>();
    facts = [];
    for (const f of merged) {
      if (f.kind === 'relation') {
        facts.push(f);
      } else {
        const key = `${f.kind}:${f.name}:${f.file}`;
        if (!seen.has(key)) {
          seen.add(key);
          facts.push(f);
        }
      }
    }

    // 合并 interfaces（按 component+type 去重，新覆盖旧）
    const newInterfaces = files.length > 0 ? await scanInterfaces(files) : { entries: [], scannedAt: '' };
    interfaceInventory = mergeInterfaceInventories(oldInterfaces, newInterfaces);
  } else {
    // 全量模式
    facts = newFacts;
    interfaceInventory = await scanInterfaces(files);
  }

  const graph: GraphIndex = buildCodeGraph(facts);

  // Call chain tracing (entry → orchestration → service → data)
  // 增量模式下跳过 traceCallChains（只有变更文件的 content，无法完整追踪）
  // 读取已有的 dependency-paths.md 内容，避免因少量文件变更而清空调用链
  let callChains: CallChain[];
  const depPathsFile = path.join(evidenceDir, 'dependency-paths.md');
  if (changedFiles) {
    callChains = [];
  } else {
    callChains = traceCallChains(facts, files);
  }

  const pages = buildEvidencePages(facts, project, interfaceInventory, callChains);

  await mkdir(evidenceDir, { recursive: true });

  // 增量模式下复用已有 dependency-paths.md（仅有变更文件 content，无法重新追踪）
  if (changedFiles && !pages.has('dependency-paths.md')) {
    try {
      const existing = await readFile(depPathsFile, 'utf-8');
      pages.set('dependency-paths.md', existing);
    } catch { /* 无历史文件，跳过 */ }
  }

  for (const [filename, content] of pages) {
    await writeIfChanged(path.join(evidenceDir, filename), content);
  }

  // Build architecture overlay (directory-level contains edges)
  const pageSlugs = [...pages.keys()].map(p => `evidence/code/${project}/${p.replace('.md', '')}`);
  const overlay = buildIndexHubOverlay(project, 'evidence/code', pageSlugs);

  // Merge overlay into the per-repo graph
  const repoGraph = mergeGraphs(graph, overlay);

  // Write per-repo graph only; global aggregation is done by aggregateGlobalGraph()
  // in import-repo.ts after all per-repo graphs are in place (avoids write races).
  await saveGraphIndex(wikiRoot, repoGraph);

  // AI enrichment (optional, non-blocking; skipped with --skip-enrich)
  let aiDomains: DomainGroup[] = [];
  if (opts.skipEnrich) {
    if (!opts.json) console.log(chalk.dim('  [AI enrich: skipped (--skip-enrich)]'));
  } else try {
    const { enrichWithAI, writeManifest } = await import('./enrich-with-ai.js');
    const modules = new Map<string, CodeFact[]>();
    for (const fact of facts) {
      if (fact.kind === 'relation') continue;
      const mod = fact.file.split('/')[0] || '_root';
      const existing = modules.get(mod) ?? [];
      existing.push(fact);
      modules.set(mod, existing);
    }

    const enrichResult = await enrichWithAI({ project, facts, interfaceInventory, modules });
    if (enrichResult) {
      await writeManifest(enrichResult.manifest, evidenceDir);
      aiDomains = enrichResult.domains;
      // Persist AI-inferred domain classification for rebuildWikiIndex
      const domainMeta = {
        domain: enrichResult.repoDomain || (enrichResult.domains[0]?.name ?? ''),
        description: enrichResult.repoDescription || '',
        keywords: enrichResult.repoKeywords || [],
        components: enrichResult.domains[0]?.components ?? [],
      };
      await writeFile(path.join(evidenceDir, '_domains.json'), JSON.stringify(domainMeta, null, 2), 'utf-8');
      if (!opts.json) {
        const domainLabel = domainMeta.domain || 'uncategorized';
        console.log(`  AI enrich: ${enrichResult.manifest.components.length} modules, domain=${domainLabel}`);
      }
    }
  } catch (e) {
    if (!opts.json) {
      console.log(chalk.dim(`  [AI enrich skipped: ${(e as Error).message}]`));
    }
  }

  // 生成模块级摘要页（按顶层目录聚合）
  const moduleSummaries = buildModuleSummaries(facts, graph, project);
  if (moduleSummaries.size > 0) {
    const modulesDir = path.join(evidenceDir, 'modules');
    await mkdir(modulesDir, { recursive: true });
    for (const [filename, content] of moduleSummaries) {
      await writeIfChanged(path.join(modulesDir, filename), content);
    }
  }

  // 生成 overview.md — 确定性架构概览 (B16)
  const overview = buildOverview(facts, repoGraph, project, interfaceInventory, callChains);
  await writeIfChanged(path.join(evidenceDir, 'overview.md'), overview);

  // 生成 team-wiki 标准入口文件
  const proj = [{ slug: project, label: project }];
  const ifByType: Record<string, number> = {};
  for (const e of interfaceInventory.entries) {
    ifByType[e.type] = (ifByType[e.type] ?? 0) + e.count;
  }
  const indexStats: IndexStats = {
    totalFacts: facts.length,
    totalNodes: repoGraph.nodes.length,
    totalEdges: repoGraph.edges.length,
    interfaces: Object.keys(ifByType).length > 0 ? ifByType : undefined,
    callChains: callChains.length > 0 ? callChains.length : undefined,
  };
  await writeIfChanged(path.join(wikiRoot, 'router.md'), routerTemplate(proj, aiDomains.length > 0 ? aiDomains : undefined));
  await writeIfChanged(path.join(wikiRoot, 'hot.md'), HOT_TEMPLATE);
  await writeIfChanged(path.join(wikiRoot, 'index.md'), indexTemplate(proj, indexStats));

  // 生成 gaps/ — 知识缺口追踪
  const gaps = detectKnowledgeGaps(facts, graph, files);
  const gapsDir = path.join(wikiRoot, 'gaps');
  await mkdir(gapsDir, { recursive: true });
  const gapLines = [
    '---',
    'title: Knowledge Gaps',
    `domain: ${project}`,
    'source: []',
    '---',
    '',
    '# Knowledge Gaps',
    '',
    '在代码知识提取过程中发现的缺口。这些条目表示知识库尚未覆盖的领域，recall 命中 gap 时不应凭空回答。',
    '',
    '| ID | Kind | Status | Description | Source |',
    '|----|------|--------|-------------|--------|',
  ];
  for (const gap of gaps) {
    gapLines.push(`| ${gap.id} | ${gap.kind} | open | ${gap.description} | ${gap.source} |`);
  }
  if (gaps.length === 0) {
    gapLines.push('| — | — | — | 未发现明显知识缺口 | — |');
  }
  gapLines.push('');
  await writeIfChanged(path.join(gapsDir, 'detected.md'), gapLines.join('\n'));

  // 更新 facts 和 interfaces 缓存
  await saveFactsCache(indicesDir, facts);
  await saveInterfacesCache(indicesDir, interfaceInventory);

  // 构建完整的 manifest 文件列表
  let allManifestFiles = collectionManifest.files.map((f) => ({
    relativePath: f.relativePath,
    sha256: f.sha256,
    language: f.language,
  }));
  if (changedFiles !== undefined && changedFiles.length > 0) {
    // 有变更/新增文件：合并旧 manifest 中未变更的记录 + 新扫描的记录
    try {
      const oldManifestRaw = await readFile(manifestPath, 'utf-8');
      const oldManifest = JSON.parse(oldManifestRaw) as {
        files?: Array<{ relativePath: string; sha256: string; language?: string }>;
      };
      const changedSet = new Set([...changedFiles, ...deletedFiles]);
      const unchanged = (oldManifest.files ?? [])
        .filter((f) => !changedSet.has(f.relativePath))
        .map((f) => ({ relativePath: f.relativePath, sha256: f.sha256, language: f.language ?? '' }));
      allManifestFiles = [...unchanged, ...allManifestFiles];
    } catch { /* 无旧 manifest，只用当前的 */ }
  } else if (changedFiles !== undefined && changedFiles.length === 0 && deletedFiles.length > 0) {
    // 仅删除：从旧 manifest 过滤已删除文件（collectCode 返回全量，不需要合并）
    const deletedSet = new Set(deletedFiles);
    allManifestFiles = allManifestFiles.filter(f => !deletedSet.has(f.relativePath));
  }
  // Persist git baseline from prior incremental manifest when not explicitly supplied
  let prevRepoUrl: string | undefined;
  let prevBranch: string | undefined;
  let prevIngestedMrs: Array<{ url: string; headSha?: string; at: string }> = [];
  // Always carry forward prior baseline provenance (repoUrl / branch /
  // ingestedMrs) so a full re-extract does not silently drop it. A missing
  // or unreadable manifest just leaves the defaults.
  try {
    const prev = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
      repoUrl?: string;
      branch?: string;
      ingestedMrs?: Array<{ url: string; headSha?: string; at: string }>;
    };
    prevRepoUrl = prev.repoUrl;
    prevBranch = prev.branch;
    prevIngestedMrs = prev.ingestedMrs ?? [];
  } catch { /* no prior manifest */ }

  const headSha = collectionManifest.commit;
  const manifestObject: Record<string, unknown> = {
    version: 1,
    lastScan: new Date().toISOString(),
    files: allManifestFiles,
  };
  if (headSha) manifestObject.headSha = headSha;
  const repoUrl = opts.repoUrl ?? prevRepoUrl;
  const branch = opts.branch ?? prevBranch;
  if (repoUrl) manifestObject.repoUrl = repoUrl;
  if (branch) manifestObject.branch = branch;
  // P5: record ingested MR (upsert by url) when invoked via --from-mr
  let ingestedMrs = prevIngestedMrs;
  if (opts.sourceMrUrl) {
    const at = new Date().toISOString();
    const entry = { url: opts.sourceMrUrl, headSha, at };
    ingestedMrs = [...prevIngestedMrs.filter((m) => m.url !== opts.sourceMrUrl), entry];
  }
  if (ingestedMrs.length > 0) manifestObject.ingestedMrs = ingestedMrs;
  const manifestContent = JSON.stringify(manifestObject, null, 2);
  await writeFile(manifestPath, manifestContent, 'utf-8');

  const byKind: Record<string, number> = {};
  for (const fact of facts) {
    byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  }

  const result: ExtractResult = {
    project,
    filesScanned: files.length,
    facts: { total: facts.length, byKind },
    graph: { nodes: repoGraph.nodes.length, edges: repoGraph.edges.length },
    incremental: !!opts.incremental && !!changedFiles,
    outputDir: wikiRoot,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.green(`[extract] ${project} complete`));
    console.log(`  Files: ${result.filesScanned}`);
    console.log(`  Facts: ${result.facts.total} (${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(', ')})`);
    console.log(`  Graph: ${result.graph.nodes} nodes, ${result.graph.edges} edges`);
    if (interfaceInventory.entries.length > 0) {
      const byType: Record<string, number> = {};
      for (const e of interfaceInventory.entries) byType[e.type] = (byType[e.type] ?? 0) + e.count;
      console.log(`  Interfaces: ${Object.entries(byType).map(([t, c]) => `${t}:${c}`).join(', ')}`);
    }
    if (callChains.length > 0) {
      console.log(`  Call chains: ${callChains.length} chains (max depth ${Math.max(...callChains.map(c => c.depth))})`);
    }
    console.log(`  Output: ${wikiRoot}`);
  }
}
