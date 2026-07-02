import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { HOT_TEMPLATE } from './wiki-engine/adapters/templates.js';
import type { CodebaseOutputManifestV2 } from './wiki-engine/manifest-schema.js';

interface ProjectInfo {
  slug: string;
  description: string;
  facts: number;
  interfaces: Record<string, number>;
  callChains: number;
  responsibilities: string[];
  keywords: string[];
  domain: string;
}

export async function rebuildWikiIndex(teamwikiRoot: string): Promise<void> {
  const evidenceCodeDir = path.join(teamwikiRoot, 'evidence', 'code');
  if (!await pathExists(evidenceCodeDir)) return;

  const projects: ProjectInfo[] = [];
  let totalFacts = 0, totalNodes = 0, totalEdges = 0;
  const allInterfaces: Record<string, number> = {};
  let totalCallChains = 0;

  const dirs = await readdir(evidenceCodeDir);
  for (const dir of dirs) {
    const dirPath = path.join(evidenceCodeDir, dir);
    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const info: ProjectInfo = {
      slug: dir, description: '', facts: 0,
      interfaces: {}, callChains: 0,
      responsibilities: [], keywords: [], domain: '',
    };

    // Extract description from overview.md — first non-heading paragraph
    const overviewPath = path.join(dirPath, 'overview.md');
    if (await pathExists(overviewPath)) {
      const content = await readFile(overviewPath, 'utf-8');
      const bodyStart = content.indexOf('\n\n', content.indexOf('---', 3));
      if (bodyStart > 0) {
        const body = content.slice(bodyStart).trim();
        const paragraphs = body.split(/\n\n+/);
        const firstContent = paragraphs.find(p => !p.startsWith('#') && p.trim().length > 20);
        if (firstContent) {
          info.description = firstContent.replace(/\n/g, ' ').trim().slice(0, 120);
        }
      }
    }

    // Read facts count from project index.md
    const projectIndex = path.join(dirPath, 'index.md');
    if (await pathExists(projectIndex)) {
      const content = await readFile(projectIndex, 'utf-8');
      const factsMatch = content.match(/Facts:\s*(\d+)/);
      if (factsMatch) info.facts = parseInt(factsMatch[1], 10);
      const ifMatches = content.matchAll(/\|\s*(HTTP|MQ|RPC)\s*\|\s*(\d+)\s*\|/g);
      for (const m of ifMatches) {
        info.interfaces[m[1]] = (info.interfaces[m[1]] ?? 0) + parseInt(m[2], 10);
      }
    }

    // Read _manifest.json for responsibilities + keywords
    const manifestPath = path.join(dirPath, '_manifest.json');
    if (await pathExists(manifestPath)) {
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as CodebaseOutputManifestV2;
        for (const comp of manifest.components) {
          if (comp.responsibilities) info.responsibilities.push(...comp.responsibilities);
          info.keywords.push(comp.slug);
        }
      } catch { /* skip */ }
    }

    // Read _domains.json for AI-inferred domain classification (higher priority than heuristic)
    const domainsPath = path.join(dirPath, '_domains.json');
    if (await pathExists(domainsPath)) {
      try {
        const raw = await readFile(domainsPath, 'utf-8');
        const domainMeta = JSON.parse(raw) as { domain?: string; description?: string; keywords?: string[] };
        if (domainMeta.domain) {
          info.domain = domainMeta.domain;
        }
        if (domainMeta.description) {
          info.description = info.description || domainMeta.description;
        }
        if (domainMeta.keywords && domainMeta.keywords.length > 0) {
          info.keywords = [...domainMeta.keywords, ...info.keywords];
        }
      } catch { /* skip */ }
    }

    // Read call-chains count
    const chainsPath = path.join(dirPath, 'dependency-paths.md');
    if (await pathExists(chainsPath)) {
      const content = await readFile(chainsPath, 'utf-8');
      const chainMatch = content.match(/(\d+)\s*call chain/);
      if (chainMatch) info.callChains = parseInt(chainMatch[1], 10);
    }

    if (!info.domain) {
      info.domain = inferDomain(info.responsibilities, info.slug);
    }
    totalFacts += info.facts;
    totalCallChains += info.callChains;
    for (const [t, c] of Object.entries(info.interfaces)) {
      allInterfaces[t] = (allInterfaces[t] ?? 0) + c;
    }
    projects.push(info);
  }

  // Global graph stats
  const graphPath = path.join(teamwikiRoot, '.indices', 'graph-index.json');
  if (await pathExists(graphPath)) {
    try {
      const raw = await readFile(graphPath, 'utf-8');
      const graph = JSON.parse(raw);
      totalNodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
      totalEdges = Array.isArray(graph.edges) ? graph.edges.length : 0;
    } catch { /* skip */ }
  }

  // Group by domain
  const domainMap = new Map<string, ProjectInfo[]>();
  for (const p of projects) {
    const existing = domainMap.get(p.domain) ?? [];
    existing.push(p);
    domainMap.set(p.domain, existing);
  }

  // Generate router.md (table-based with routing keywords)
  const routerLines = [
    '# Team Wiki Router',
    '',
    '## 产品域路由',
    '',
    '| 域 | 入口 | 核心职责 | 路由关键词 |',
    '|---|---|---|---|',
  ];
  for (const [domain, domainProjects] of domainMap) {
    for (const p of domainProjects) {
      const entry = `[[code/${p.slug}/index]]`;
      const duty = p.description || p.responsibilities.slice(0, 2).join('；') || p.slug;
      const kw = p.keywords.slice(0, 6).join(', ') || p.slug;
      routerLines.push(`| ${domain} | ${entry} | ${duty.slice(0, 80)} | ${kw} |`);
    }
  }
  routerLines.push('');
  routerLines.push('## 路由规则');
  routerLines.push('');
  routerLines.push('1. **按组件名匹配** → 路由关键词列对应域');
  routerLines.push('2. **跨仓库依赖问题** → 查 graph-index.json 的 DEPENDS_ON 边');
  routerLines.push('3. **接口/API 问题** → 优先匹配有 interfaces.md 的仓库');
  routerLines.push('4. **调用链/排障** → 查对应仓库的 dependency-paths.md');
  routerLines.push('5. **模块职责概述** → 查 overview.md 或 modules/*.md');
  routerLines.push('');
  await writeFile(path.join(teamwikiRoot, 'router.md'), routerLines.join('\n'), 'utf-8');

  // Generate index.md (categorized with descriptions)
  const indexLines = [
    '# Team Wiki Index',
    '',
    `Last updated: ${new Date().toISOString()}`,
    '',
    '## Stats',
    '',
    `- 仓库: ${projects.length}`,
    `- Facts: ${totalFacts}`,
    `- 图谱节点: ${totalNodes}`,
    `- 图谱边: ${totalEdges}`,
  ];
  if (Object.keys(allInterfaces).length > 0) {
    indexLines.push(`- 接口: ${Object.entries(allInterfaces).map(([t, c]) => `${t}:${c}`).join(', ')}`);
  }
  if (totalCallChains > 0) indexLines.push(`- 调用链: ${totalCallChains}`);
  indexLines.push('');

  // Domain summaries
  indexLines.push('## Domain Summaries');
  indexLines.push('');
  for (const [domain, domainProjects] of domainMap) {
    const totalDomainApis = domainProjects.reduce((sum, p) =>
      sum + Object.values(p.interfaces).reduce((a, b) => a + b, 0), 0);
    const apiStr = totalDomainApis > 0 ? ` (${totalDomainApis} APIs)` : '';
    indexLines.push(`### ${domain}${apiStr}`);
    indexLines.push('');
    for (const p of domainProjects) {
      const desc = p.description || p.responsibilities[0] || '';
      indexLines.push(`- [${p.slug}](./evidence/code/${p.slug}/index.md) — ${desc}`);
    }
    indexLines.push('');
  }

  // Navigation
  indexLines.push('## Navigation');
  indexLines.push('');
  indexLines.push('- [router.md](./router.md) — 产品域路由（表格 + 路由规则）');
  indexLines.push('- [hot.md](./hot.md) — 活跃工作记忆');
  indexLines.push('');
  await writeFile(path.join(teamwikiRoot, 'index.md'), indexLines.join('\n'), 'utf-8');

  if (!await pathExists(path.join(teamwikiRoot, 'hot.md'))) {
    await writeFile(path.join(teamwikiRoot, 'hot.md'), HOT_TEMPLATE, 'utf-8');
  }

  log.debug(`rebuildWikiIndex: ${projects.length} projects, ${totalNodes} nodes, ${totalEdges} edges`);
}

function inferDomain(responsibilities: string[], slug: string): string {
  const respText = responsibilities.join(' ').toLowerCase();
  const slugLower = slug.toLowerCase();

  // Priority 1: slug-based (most reliable — project naming is intentional)
  if (/balance/.test(slugLower)) return '计费';
  if (/flow_config|_configs$/.test(slugLower)) return '配置';
  if (/flow/.test(slugLower)) return '流程引擎';
  if (/docker|image/.test(slugLower)) return '部署/镜像';
  if (/unit_test/.test(slugLower)) return '测试';
  if (/mock/.test(slugLower)) return '测试/模拟';
  if (/infer.*ext|extension/.test(slugLower)) return '推理服务';
  if (/nginx|proxy/.test(slugLower)) return '网关/代理';
  if (/tool|util/.test(slugLower)) return '工具';
  if (/api/.test(slugLower) && !/config/.test(slugLower)) return 'API 网关';

  // Priority 2: responsibilities-based (when slug is generic)
  if (/计费|扣费|charge|billing/.test(respText)) return '计费';
  if (/推理|infer|模型部署|serving/.test(respText)) return '推理服务';
  if (/流程|编排|workflow|saga/.test(respText)) return '流程引擎';
  if (/调度|schedule|负载|资源管理/.test(respText)) return '调度';
  if (/api.*网关|请求.*路由|参数校验|鉴权/.test(respText)) return 'API 网关';
  if (/部署|docker|镜像|容器/.test(respText)) return '部署/镜像';
  if (/测试|test|mock/.test(respText)) return '测试';
  if (/配置|config/.test(respText)) return '配置';
  if (/数据库|存储|redis|cache/.test(respText)) return '数据';
  if (/工具|tool|util/.test(respText)) return '工具';

  return '其他';
}
