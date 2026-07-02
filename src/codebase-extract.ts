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
  createGraphIndex,
  saveGraphIndex,
  loadGraphIndex,
} from './wiki-engine/adapters/index.js';
import type { CodeFact, InterfaceInventory, CallChain } from './wiki-engine/adapters/index.js';
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
      description: `${unresolvedImports.size} 个外部依赖未在知识库中记录（如 ${[...unresolvedImports].slice(0, 3).join(', ')}）`,
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
      description: `${unimplemented.length} 个接口未发现对应实现（如 ${unimplemented.slice(0, 3).join(', ')}）`,
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
      description: `${orphanNodes.length}/${graph.nodes.length} 个节点无图谱连接，依赖关系可能未被完整提取`,
      source: 'graph-index.json',
    });
  }

  // 4. 无错误处理模式：有组件但无 error 类型定义
  const errorFacts = facts.filter((f) => f.kind === 'error');
  if (components.length > 10 && errorFacts.length === 0) {
    gaps.push({
      id: 'no-error-patterns',
      kind: 'ERROR_HANDLING_UNDOCUMENTED',
      description: `项目有 ${components.length} 个组件但未检测到错误类型定义，错误处理模式可能未文档化`,
      source: 'code scan',
    });
  }

  // 5. 无配置项目：有组件但无 config/env 提取
  const configFacts = facts.filter((f) => f.kind === 'config');
  if (components.length > 10 && configFacts.length === 0) {
    gaps.push({
      id: 'no-config-detected',
      kind: 'CONFIG_UNDOCUMENTED',
      description: `项目有 ${components.length} 个组件但未检测到配置项/环境变量，配置管理可能未文档化`,
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
      if (!opts.json) {
        console.log(chalk.dim(`[extract] incremental: ${changedFiles.length} files changed`));
      }
    } catch {
      if (!opts.json) {
        console.log(chalk.dim('[extract] no manifest history, running full extraction'));
      }
    }
  }

  const { files } = await collectCode({ root, maxFiles, changedFiles });
  if (files.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ status: 'no-files', project }));
    } else {
      console.log(chalk.yellow(`[extract] ${project}: no extractable source files found.`));
    }
    return;
  }

  const facts = extractCodeFacts(files);
  const graph: GraphIndex = buildCodeGraph(facts);

  // Interface detection (HTTP/MQ/RPC)
  const interfaceInventory = await scanInterfaces(files);

  // Call chain tracing (entry → orchestration → service → data)
  const callChains = traceCallChains(facts, files);

  const pages = buildEvidencePages(facts, project, interfaceInventory, callChains);

  await mkdir(evidenceDir, { recursive: true });

  for (const [filename, content] of pages) {
    await writeFile(path.join(evidenceDir, filename), content, 'utf-8');
  }

  // Build architecture overlay (directory-level contains edges)
  const pageSlugs = [...pages.keys()].map(p => `evidence/code/${project}/${p.replace('.md', '')}`);
  const overlay = buildIndexHubOverlay(project, 'evidence/code', pageSlugs);

  // Merge overlay into the per-repo graph
  const repoGraph = mergeGraphs(graph, overlay);

  // Load existing global graph and merge to avoid overwriting other repos' data
  const existingGraph = await loadGraphIndex(wikiRoot) ?? createGraphIndex();
  const mergedGraph = mergeGraphs(existingGraph, repoGraph);

  // Write graph-index.json using protocol function (B5)
  await saveGraphIndex(wikiRoot, mergedGraph);

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
        const domainLabel = domainMeta.domain || '未分类';
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
      await writeFile(path.join(modulesDir, filename), content, 'utf-8');
    }
  }

  // 生成 overview.md — 确定性架构概览 (B16)
  const overview = buildOverview(facts, mergedGraph, project, interfaceInventory, callChains);
  await writeFile(path.join(evidenceDir, 'overview.md'), overview, 'utf-8');

  // 生成 team-wiki 标准入口文件
  const proj = [{ slug: project, label: project }];
  const ifByType: Record<string, number> = {};
  for (const e of interfaceInventory.entries) {
    ifByType[e.type] = (ifByType[e.type] ?? 0) + e.count;
  }
  const indexStats: IndexStats = {
    totalFacts: facts.length,
    totalNodes: mergedGraph.nodes.length,
    totalEdges: mergedGraph.edges.length,
    interfaces: Object.keys(ifByType).length > 0 ? ifByType : undefined,
    callChains: callChains.length > 0 ? callChains.length : undefined,
  };
  await writeFile(path.join(wikiRoot, 'router.md'), routerTemplate(proj, aiDomains.length > 0 ? aiDomains : undefined), 'utf-8');
  await writeFile(path.join(wikiRoot, 'hot.md'), HOT_TEMPLATE, 'utf-8');
  await writeFile(path.join(wikiRoot, 'index.md'), indexTemplate(proj, indexStats), 'utf-8');

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
  await writeFile(path.join(gapsDir, 'detected.md'), gapLines.join('\n'), 'utf-8');

  const manifest = {
    version: 1,
    lastScan: new Date().toISOString(),
    files: files.map((f) => ({
      relativePath: f.relativePath,
      sha256: f.sha256,
      language: f.language,
    })),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  const byKind: Record<string, number> = {};
  for (const fact of facts) {
    byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  }

  const result: ExtractResult = {
    project,
    filesScanned: files.length,
    facts: { total: facts.length, byKind },
    graph: { nodes: mergedGraph.nodes.length, edges: mergedGraph.edges.length },
    incremental: !!opts.incremental && !!changedFiles,
    outputDir: wikiRoot,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.green(`[extract] ${project} 完成`));
    console.log(`  文件: ${result.filesScanned}`);
    console.log(`  事实: ${result.facts.total} (${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(', ')})`);
    console.log(`  图谱: ${result.graph.nodes} nodes, ${result.graph.edges} edges`);
    if (interfaceInventory.entries.length > 0) {
      const byType: Record<string, number> = {};
      for (const e of interfaceInventory.entries) byType[e.type] = (byType[e.type] ?? 0) + e.count;
      console.log(`  接口: ${Object.entries(byType).map(([t, c]) => `${t}:${c}`).join(', ')}`);
    }
    if (callChains.length > 0) {
      console.log(`  调用链: ${callChains.length} chains (max depth ${Math.max(...callChains.map(c => c.depth))})`);
    }
    console.log(`  输出: ${wikiRoot}`);
  }
}
