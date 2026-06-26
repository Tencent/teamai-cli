export interface DomainGroup {
  name: string;
  components: string[];
  apiCount?: number;
}

export function routerTemplate(
  projects: Array<{ slug: string; label: string }>,
  domains?: DomainGroup[],
): string {
  const lines = ['# Team Wiki Router', '', 'Route broad questions to the relevant domain entrypoint.', ''];

  if (domains && domains.length > 0) {
    for (const domain of domains) {
      lines.push(`## ${domain.name}${domain.apiCount ? ` (${domain.apiCount} APIs)` : ''}`);
      lines.push('');
      for (const comp of domain.components) {
        const proj = projects.find(p => p.slug === comp || p.label === comp);
        if (proj) {
          lines.push(`- [[evidence/code/${proj.slug}/index]] — ${proj.label}`);
        } else {
          lines.push(`- ${comp}`);
        }
      }
      lines.push('');
    }
    const grouped = new Set(domains.flatMap(d => d.components));
    const ungrouped = projects.filter(p => !grouped.has(p.slug) && !grouped.has(p.label));
    if (ungrouped.length > 0) {
      lines.push('## Other');
      lines.push('');
      for (const p of ungrouped) {
        lines.push(`- [[evidence/code/${p.slug}/index]] — ${p.label} 代码知识`);
      }
      lines.push('');
    }
  } else {
    for (const p of projects) {
      lines.push(`- [[code/${p.slug}/index]] — ${p.label} 代码知识`);
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
  projects: Array<{ slug: string; label: string; description?: string }>,
  stats?: IndexStats,
): string {
  const domainLinks = projects
    .map(p => `- [${p.slug}](./evidence/code/${p.slug}/index.md) — ${p.description ?? p.label}`)
    .join('\n');

  const sections = [
    '# Team Wiki Index',
    '',
    `Last updated: ${new Date().toISOString()}`,
    '',
  ];

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

  sections.push('## Domains', '', domainLinks, '');
  sections.push('## Navigation', '', '- [router.md](./router.md) — 领域路由入口', '- [hot.md](./hot.md) — 活跃工作记忆', '');

  return sections.join('\n');
}

export const HOT_TEMPLATE = [
  '# Hot Context',
  '',
  'Keep only active working memory here: current focus, recent decisions, open questions.',
  'Move durable conclusions into domain pages.',
  '',
].join('\n');
