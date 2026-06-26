import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import chalk from 'chalk';

import { pathExists } from './utils/fs.js';
import type { CodeGraphIndex } from './wiki-engine/adapters/index.js';

export type WikiLintSeverity = 'high' | 'medium' | 'low' | 'info';

export interface WikiLintIssue {
  severity: WikiLintSeverity;
  category: string;
  location: string;
  message: string;
}

export interface WikiLintReport {
  issues: WikiLintIssue[];
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  graphHealth: {
    nodeCount: number;
    edgeCount: number;
    orphanNodes: number;
    connectivity: number;
  };
}

export async function lintTeamwiki(opts: {
  cwd: string;
  severity?: WikiLintSeverity;
}): Promise<WikiLintReport> {
  const wikiRoot = path.join(opts.cwd, 'teamwiki');
  const issues: WikiLintIssue[] = [];
  const minSeverity = opts.severity ?? 'info';
  const severityOrder: WikiLintSeverity[] = ['info', 'low', 'medium', 'high'];
  const minIdx = severityOrder.indexOf(minSeverity);

  function addIssue(issue: WikiLintIssue): void {
    if (severityOrder.indexOf(issue.severity) >= minIdx) {
      issues.push(issue);
    }
  }

  // Check graph-index.json exists
  const graphPath = path.join(wikiRoot, '.indices', 'graph-index.json');
  let graph: CodeGraphIndex | null = null;

  if (!await pathExists(graphPath)) {
    addIssue({
      severity: 'high',
      category: 'graph-missing',
      location: 'teamwiki/.indices/graph-index.json',
      message: 'graph-index.json 不存在，知识图谱未构建',
    });
  } else {
    try {
      const raw = await readFile(graphPath, 'utf-8');
      graph = JSON.parse(raw) as CodeGraphIndex;
    } catch {
      addIssue({
        severity: 'high',
        category: 'graph-corrupt',
        location: graphPath,
        message: 'graph-index.json 解析失败',
      });
    }
  }

  // Check evidence directory
  const evidenceDir = path.join(wikiRoot, 'evidence', 'code');
  if (!await pathExists(evidenceDir)) {
    addIssue({
      severity: 'high',
      category: 'evidence-missing',
      location: 'teamwiki/evidence/code/',
      message: 'evidence 目录不存在，无代码事实页',
    });
  } else {
    const projects = await readdir(evidenceDir);
    if (projects.length === 0) {
      addIssue({
        severity: 'medium',
        category: 'evidence-empty',
        location: 'teamwiki/evidence/code/',
        message: 'evidence 目录为空，未提取任何项目',
      });
    }

    for (const project of projects) {
      const projectDir = path.join(evidenceDir, project);
      const pStat = await stat(projectDir).catch(() => null);
      if (!pStat?.isDirectory()) {
        if (!pStat) {
          addIssue({ severity: 'low', category: 'stat-failed', location: `evidence/code/${project}`, message: '无法读取目录状态' });
        }
        continue;
      }

      const files = await readdir(projectDir);
      if (!files.includes('index.md')) {
        addIssue({
          severity: 'low',
          category: 'missing-index',
          location: `evidence/code/${project}/`,
          message: '缺少 index.md 总索引页',
        });
      }
    }
  }

  // Check navigation files (router.md, index.md, hot.md)
  for (const navFile of ['router.md', 'index.md', 'hot.md']) {
    if (!await pathExists(path.join(wikiRoot, navFile))) {
      addIssue({
        severity: 'low',
        category: 'nav-missing',
        location: `teamwiki/${navFile}`,
        message: `导航文件 ${navFile} 不存在，知识库入口不完整`,
      });
    }
  }

  // Check source-manifest.json
  const manifestPath = path.join(wikiRoot, 'source-manifest.json');
  if (!await pathExists(manifestPath)) {
    addIssue({
      severity: 'low',
      category: 'manifest-missing',
      location: 'teamwiki/source-manifest.json',
      message: 'source-manifest.json 不存在，增量更新不可用',
    });
  } else {
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      if (manifest.lastScan) {
        const daysSince = (Date.now() - new Date(manifest.lastScan).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 60) {
          addIssue({
            severity: 'medium',
            category: 'stale-manifest',
            location: 'teamwiki/source-manifest.json',
            message: `上次扫描距今 ${Math.floor(daysSince)} 天，建议重新执行 --extract`,
          });
        }
      }
    } catch {
      addIssue({
        severity: 'low',
        category: 'manifest-corrupt',
        location: manifestPath,
        message: 'source-manifest.json 解析失败',
      });
    }
  }

  // Graph health metrics
  let graphHealth = { nodeCount: 0, edgeCount: 0, orphanNodes: 0, connectivity: 0 };
  if (graph) {
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    const connectedNodes = new Set<string>();
    for (const edge of graph.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }
    const orphans = graph.nodes.filter(n => !connectedNodes.has(n.id) && !connectedNodes.has(n.file));
    const connectivity = graph.nodes.length > 0
      ? (graph.nodes.length - orphans.length) / graph.nodes.length
      : 0;

    graphHealth = {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      orphanNodes: orphans.length,
      connectivity: Math.round(connectivity * 100) / 100,
    };

    if (connectivity < 0.3) {
      addIssue({
        severity: 'medium',
        category: 'low-connectivity',
        location: 'teamwiki/.indices/graph-index.json',
        message: `图谱连通性 ${(connectivity * 100).toFixed(0)}% 过低（${orphans.length} 个孤立节点）`,
      });
    }

    if (graph.edges.length === 0 && graph.nodes.length > 10) {
      addIssue({
        severity: 'high',
        category: 'no-edges',
        location: 'teamwiki/.indices/graph-index.json',
        message: `图谱有 ${graph.nodes.length} 个节点但 0 条边，图谱构建可能失败`,
      });
    }
  }

  const summary = {
    total: issues.length,
    high: issues.filter(i => i.severity === 'high').length,
    medium: issues.filter(i => i.severity === 'medium').length,
    low: issues.filter(i => i.severity === 'low').length,
    info: issues.filter(i => i.severity === 'info').length,
  };

  return { issues, summary, graphHealth };
}

export function formatWikiLintReport(report: WikiLintReport): string {
  const lines: string[] = [];

  lines.push(chalk.bold('=== teamwiki/ 知识图谱健康度检查 ==='));
  lines.push('');
  lines.push(`图谱: ${report.graphHealth.nodeCount} nodes, ${report.graphHealth.edgeCount} edges, 连通性 ${(report.graphHealth.connectivity * 100).toFixed(0)}%`);
  if (report.graphHealth.orphanNodes > 0) {
    lines.push(chalk.dim(`  (${report.graphHealth.orphanNodes} 个孤立节点)`));
  }
  lines.push('');

  if (report.issues.length === 0) {
    lines.push(chalk.green('✓ 无问题'));
    return lines.join('\n');
  }

  const byCategory = new Map<string, WikiLintIssue[]>();
  for (const issue of report.issues) {
    const existing = byCategory.get(issue.category) ?? [];
    existing.push(issue);
    byCategory.set(issue.category, existing);
  }

  for (const [category, categoryIssues] of byCategory) {
    lines.push(chalk.bold(`[${category}] (${categoryIssues.length})`));
    for (const issue of categoryIssues) {
      const sevColor = issue.severity === 'high' ? chalk.red
        : issue.severity === 'medium' ? chalk.yellow : chalk.dim;
      lines.push(`  ${sevColor(`[${issue.severity}]`)} ${issue.location}: ${issue.message}`);
    }
    lines.push('');
  }

  lines.push(`总计: ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low, ${report.summary.info} info`);
  return lines.join('\n');
}
