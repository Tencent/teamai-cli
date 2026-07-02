export interface DomainGroup {
  name: string;
  components: string[];
  apiCount?: number;
}

export interface ProjectEntry {
  slug: string;
  label: string;
  description?: string;
  keywords?: string[];
}

export interface ModuleEntry {
  slug: string;
  responsibilities?: string[];
  category?: string;
  topComponents?: string[];
}

export function routerTemplate(
  projects: ProjectEntry[],
  domains?: DomainGroup[],
): string {
  const allKeywords = new Set<string>();
  for (const p of projects) {
    if (p.keywords) p.keywords.forEach(k => allKeywords.add(k));
  }
  const baseTerms = ['路由', '索引', '入口', '知识库', '代码知识', 'architecture', 'module', 'dependency'];
  const anchorTerms = [...baseTerms, ...allKeywords].slice(0, 20);

  const lines = [
    '# Team Wiki Router',
    `<!-- search-anchor: ${anchorTerms.join(', ')} -->`,
    '',
    'Route broad questions to the relevant domain entrypoint.',
    '',
    '## 问题路由表',
    '',
    '| 问题类型 | 目标文档 | 示例问题 |',
    '|----------|----------|---------|',
    '| 谁依赖谁 / 模块关系 | G1 组件关系矩阵 | "X 模块的上下游是什么" |',
    '| 调用链 / 数据流 | G2 数据流图 | "请求从入口到数据库经过哪些模块" |',
    '| 完整业务流程 | G5 场景序列图 | "用户登录的完整流程是什么" |',
    '| 传递依赖 / 爆炸半径 | G6 多跳路径 | "如果 X 挂了会影响什么" |',
    '| 架构概览 / 技术栈 | overview.md | "项目整体架构是什么" |',
    '| 某模块职责 / 依赖 | modules/<dir>.md | "recall 模块做什么" |',
    '',
    '## 项目域入口',
    '',
  ];

  if (domains && domains.length > 0) {
    for (const domain of domains) {
      lines.push(`### ${domain.name}${domain.apiCount ? ` (${domain.apiCount} APIs)` : ''}`);
      lines.push('');
      for (const comp of domain.components) {
        const proj = projects.find(p => p.slug === comp || p.label === comp);
        if (proj) {
          const desc = proj.description ? ` — ${proj.description}` : '';
          const kw = proj.keywords?.length ? ` [${proj.keywords.slice(0, 5).join(', ')}]` : '';
          lines.push(`- [[evidence/code/${proj.slug}/index]]${desc}${kw}`);
        } else {
          lines.push(`- ${comp}`);
        }
      }
      lines.push('');
    }
    const grouped = new Set(domains.flatMap(d => d.components));
    const ungrouped = projects.filter(p => !grouped.has(p.slug) && !grouped.has(p.label));
    if (ungrouped.length > 0) {
      lines.push('### Other');
      lines.push('');
      for (const p of ungrouped) {
        const desc = p.description ? ` — ${p.description}` : ' — 代码知识';
        lines.push(`- [[evidence/code/${p.slug}/index]]${desc}`);
      }
      lines.push('');
    }
  } else {
    for (const p of projects) {
      const desc = p.description ? ` — ${p.description}` : ' — 代码知识';
      const kw = p.keywords?.length ? ` [${p.keywords.slice(0, 5).join(', ')}]` : '';
      lines.push(`- [[evidence/code/${p.slug}/index]]${desc}${kw}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface IndexStats {
  totalFacts?: number;
  totalNodes?: number;
  totalEdges?: number;
  interfaces?: Record<string, number>;
  callChains?: number;
}

export function indexTemplate(
  projects: ProjectEntry[],
  stats?: IndexStats,
  modules?: ModuleEntry[],
): string {
  const allKeywords = projects.flatMap(p => p.keywords ?? []).slice(0, 15);
  const searchAnchor = allKeywords.length > 0
    ? `\n<!-- search-anchor: ${allKeywords.join(', ')} -->`
    : '';

  const sections = ['# Team Wiki Index'];
  if (searchAnchor) sections.push(searchAnchor);
  sections.push('', `Last updated: ${new Date().toISOString()}`, '');

  if (stats) {
    sections.push('## Stats', '');
    if (stats.totalFacts) sections.push(`- Facts: ${stats.totalFacts}`);
    if (stats.totalNodes) sections.push(`- Graph nodes: ${stats.totalNodes}`);
    if (stats.totalEdges) sections.push(`- Graph edges: ${stats.totalEdges}`);
    if (stats.interfaces) {
      const ifStr = Object.entries(stats.interfaces).map(([t, c]) => `${t}:${c}`).join(', ');
      sections.push(`- Interfaces: ${ifStr}`);
    }
    if (stats.callChains) sections.push(`- Call chains: ${stats.callChains}`);
    sections.push('');
  }

  if (modules && modules.length > 0) {
    sections.push('## 模块速查', '');
    sections.push('| 模块 | 职责 | 关键组件 | 层级 |');
    sections.push('|------|------|---------|------|');
    for (const mod of modules.slice(0, 20)) {
      const resp = mod.responsibilities?.slice(0, 2).join('; ') ?? '—';
      const comps = mod.topComponents?.slice(0, 3).join(', ') ?? '—';
      const cat = mod.category ?? '—';
      sections.push(`| ${mod.slug} | ${resp} | ${comps} | ${cat} |`);
    }
    sections.push('');
  }

  sections.push('## 文档导航', '');
  for (const p of projects) {
    const desc = p.description ?? p.label;
    sections.push(`### ${p.slug}`, '');
    sections.push(`- [overview.md](./evidence/code/${p.slug}/overview.md) — 架构概览`);
    sections.push(`- [modules/](./evidence/code/${p.slug}/modules/) — 模块级摘要（推荐首选）`);
    sections.push(`- [docs/](./evidence/code/${p.slug}/docs/) — 深度设计文档 + G-document`);
    sections.push(`- [component.md](./evidence/code/${p.slug}/component.md) — 原始符号清单`);
    sections.push('');
  }

  sections.push('## Navigation', '', '- [router.md](./router.md) — 问题路由入口', '- [hot.md](./hot.md) — 活跃工作记忆', '');

  return sections.join('\n');
}

export const HOT_TEMPLATE = [
  '# Hot Context',
  '',
  'Keep only active working memory here: current focus, recent decisions, open questions.',
  'Move durable conclusions into domain pages.',
  '',
].join('\n');

export interface GraphReadmeOptions {
  hasG5?: boolean;
  hasG6?: boolean;
}

export function graphReadmeTemplate(project: string, opts?: GraphReadmeOptions): string {
  const { hasG5 = true, hasG6 = true } = opts ?? {};
  const lines = [
    `# ${project} — G-Document 路由`,
    '<!-- search-anchor: 图谱, graph, G1, G2, G5, G6, 依赖, 调用链, 流程, 爆炸半径 -->',
    '',
    '根据问题类型选择对应文档：',
    '',
    '| 关键词 | 文档 | 说明 |',
    '|--------|------|------|',
    '| 依赖/上游/下游/imports | [graph-g1-relations.md](./graph-g1-relations.md) | N×N 组件依赖矩阵 |',
    '| 调用链/数据流/请求路径 | [graph-g2-dataflow.md](./graph-g2-dataflow.md) | 入口→数据层调用链 |',
  ];
  if (hasG5) {
    lines.push('| 流程/场景/sequence | [graph-g5-scenarios.md](./graph-g5-scenarios.md) | 核心业务场景序列图 |');
  }
  if (hasG6) {
    lines.push('| 传递依赖/影响范围/blast | [graph-g6-multihop.md](./graph-g6-multihop.md) | 多跳传递依赖分析 |');
  }
  lines.push('');
  return lines.join('\n');
}
