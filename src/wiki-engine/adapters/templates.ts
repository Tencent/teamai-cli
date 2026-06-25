export function routerTemplate(projects: Array<{ slug: string; label: string }>): string {
  const links = projects.map(p => `- [[code/${p.slug}/index]] — ${p.label} 代码知识`).join('\n');
  return `# Team Wiki Router\n\nRoute broad questions to the relevant domain entrypoint.\n\n${links}\n`;
}

export function indexTemplate(projects: Array<{ slug: string; label: string }>): string {
  const domains = projects
    .map(p => `- [${p.slug}](./evidence/code/${p.slug}/index.md) — 代码知识图谱`)
    .join('\n');
  return [
    '# Team Wiki Index',
    '',
    `Last updated: ${new Date().toISOString()}`,
    '',
    '## Domains',
    '',
    domains,
    '',
    '## Navigation',
    '',
    '- [router.md](./router.md) — 领域路由入口',
    '- [hot.md](./hot.md) — 活跃工作记忆',
    '',
  ].join('\n');
}

export const HOT_TEMPLATE = [
  '# Hot Context',
  '',
  'Keep only active working memory here: current focus, recent decisions, open questions.',
  'Move durable conclusions into domain pages.',
  '',
].join('\n');
