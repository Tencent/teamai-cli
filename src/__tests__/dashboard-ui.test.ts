import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getDashboardHtml } from '../dashboard-html.js';
import { renderDashboardReport } from '../viz-render.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { scorersClient } from '../dashboard/scorers-client.js';
import { summarizeSessionCosts, type DailySessionSnapshot } from '../session-trends.js';
import type { VizData } from '../viz.js';

const snapshot = (date: string, costs: Array<[string, number, number]>): DailySessionSnapshot => ({
  date, prompts: 2, durationMs: 1000, succeeded: 1, corrected: 0,
  requestDaily: Object.fromEntries(costs.map(([day, pricedRequests, costMicros]) => [day, {
    pricedRequests, costMicros, cacheReadTokens: 0, cacheEligibleInputTokens: 0, priceVersion: 'test',
  }])),
});

describe('unified dashboard', () => {
  it('embeds valid scripts without loading external code or demo fixtures', () => {
    const html = getDashboardHtml(3721);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(2);
    for (const [, js] of scripts) expect(() => new Function(js)).not.toThrow();
    expect(html).not.toContain('SAMPLE DATA');
    expect(html).not.toContain('Shared team resources');
    expect(html).not.toMatch(/<script src=/);
    expect(html).toContain("new EventSource(api('/events'))");
    expect(html).toContain('/api/context');
    expect(html).toContain('/api/sessions');
  });

  it('filters Repository by the session\'s repoKey, labelled with its repoLabel (#809)', () => {
    const html = getDashboardHtml(3721);
    expect(html).toContain("s.repoKey === $('repo').value");
    expect(html).toContain("['repo','repoKey','repoLabel','All repositories']");
  });

  it('adds a Resources page listing rule delivery state (#1028)', () => {
    const html = getDashboardHtml(3721);
    expect(html).toContain("resources: 'Resources'");
    expect(html).toContain('/api/resources/rules');
    expect(html).toContain("errorPanel('Could not load rules.','rules')");
    expect(html).toContain('Omitted by tag subscriptions');
  });

  it('adds a Distribution page that previews before it saves and never runs pull (#1028)', () => {
    const html = getDashboardHtml(3721);
    expect(html).toContain("distribution: 'Distribution'");
    expect(html).toContain("'/api/distribution'");
    expect(html).toContain("'/api/distribution/preview'");
    expect(html).toContain("'/api/distribution/roles'");
    expect(html).toContain("'/api/distribution/projects'");
    // One primary radio plus additional-role checkboxes; projects replace the list on save.
    expect(html).toContain('data-role-primary');
    expect(html).toContain('data-role-extra');
    expect(html).toContain('data-project');
    // Save stays disabled until a preview exists; a saved selection lands on the next pull.
    expect(html).toContain("(saving||!preview?' disabled':'')");
    expect(html).toContain('Saved. Takes effect on the next pull.');
    expect(html).toContain('All namespaces (flat delivery)');
  });

  it('counts priced sessions rather than requests; includes resumed costs in first-stop cohorts', () => {
    const result = summarizeSessionCosts(new Map([
      ['current', snapshot('2026-09-16', [['2026-09-15', 8, 600_000], ['2026-09-16', 2, 400_000]])],
      ['free-priced', snapshot('2026-09-10', [['2026-09-10', 1, 0]])],
      ['unknown', snapshot('2026-09-12', [])],
      ['previous-resumed', snapshot('2026-09-09', [['2026-09-09', 2, 300_000], ['2026-09-16', 3, 200_000]])],
      ['too-old', snapshot('2026-09-02', [['2026-09-02', 1, 999_999]])],
      ['future', snapshot('2026-09-17', [['2026-09-17', 1, 999_999]])],
    ]), new Date('2026-09-16T12:00:00Z'));
    expect(result.current).toEqual({ avgSessionCostMicros: 500_000, pricedSessions: 2 });
    expect(result.previous).toEqual({ avgSessionCostMicros: 500_000, pricedSessions: 1 });
    expect(summarizeSessionCosts(new Map()).current.avgSessionCostMicros).toBeNull();
  });

  it('keeps every KB report section and escapes untrusted knowledge and author strings', () => {
    const data: VizData = {
      generatedAt: new Date().toISOString(), root: '/tmp/fixture', source: { scope: 'team', label: 'Team' },
      totalEntries: 1, totalRecalls: 0, overallCoveragePct: 0, contributorCount: 1,
      coverage: [{ type: 'docs', total: 1, covered: 0, coveragePct: 0 }], topRecalled: [],
      silent: [{ docId: 'x', title: '<img src=x onerror=alert(1)>', author: '<script>bad</script>', type: 'docs', date: '', tags: [], recalledCount: 0, upvotedCount: 0, lastRecalledAt: null }],
      trend: [], authors: [{ author: '<script>bad</script>', entries: 1, totalRecalled: 0 }],
      maintenance: { promote: [], prune: [], stale: [] },
    };
    const sections = renderDashboardReport(data);
    for (const id of ['overview','coverage','top-recalled','silent','trend','authors']) expect(sections.context).toContain(`id="${id}"`);
    for (const text of ['Promotable Learnings','Suggested for Archive','Stale (Needs Quality Update)']) expect(sections.maintenance).toContain(text);
    expect(sections.context).not.toContain('<script>bad');
    expect(sections.context).not.toContain('<img src=x');
    expect(sections.context).toContain('&lt;img');
  });

  it('adds a Scorers page whose every label has a zh-CN translation (#1182)', () => {
    const html = getDashboardHtml(3721);
    expect(html).toContain("scorers: 'Scorers'");
    expect(html).toContain("apiQuery('/api/scorers',params)");
    expect(html).toContain('Labels from sessions and workflow runs show how the tools did on the work that came along. To compare tools, models or team assets on the same tasks, run a benchmark.');
    const literals = [...scorersClient.matchAll(/\b(?:label|t)\('((?:[^'\\]|\\.)+)'\)/g)].map((match) => (match[1] ?? '').replace(/\\'/g, "'"));
    const dimensions = Object.values(z.record(z.string()).parse(JSON.parse(scorersClient.match(/const scorerDimensions=(\{[^}]*\})/)?.[1] ?? 'null')));
    const headings = [...scorersClient.matchAll(/\[((?:'[A-Z][A-Z ,]+',?)+)\]/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((heading) => heading[1] ?? ''));
    const all = [...new Set([...literals, ...dimensions, ...headings])];
    expect(all.length).toBeGreaterThan(60);
    expect(all.filter((text) => !Object.hasOwn(dashboardMessages, text))).toEqual([]);
  });

  it('every data-i18n label in the report has a zh-CN translation (guards silent drift)', () => {
    // Rich fixture that exercises every non-empty branch so all data-i18n tags render.
    const data: VizData = {
      generatedAt: new Date().toISOString(), root: '/tmp/fixture', source: { scope: 'team', label: 'Team' },
      totalEntries: 3, totalRecalls: 5, overallCoveragePct: 60, contributorCount: 2,
      coverage: [{ type: 'docs', total: 3, covered: 2, coveragePct: 60 }],
      topRecalled: [{ docId: 'a', title: 'A', author: 'x', type: 'docs', date: '', tags: [], recalledCount: 5, upvotedCount: 1, lastRecalledAt: null }],
      silent: [{ docId: 'b', title: 'B', author: 'x', type: 'docs', date: '', tags: [], recalledCount: 0, upvotedCount: 0, lastRecalledAt: null }],
      trend: [{ period: '2026-08', count: 1 }, { period: '2026-09', count: 2 }],
      authors: [{ author: 'x', entries: 3, totalRecalled: 5 }],
      maintenance: {
        promote: [{ docId: 'p', filename: 'p.md', path: '/p.md', title: 'P', suggestedCategory: 'skills', confidence: 0.95, upvotedCount: 3, userCount: 2 }],
        prune: [{ filename: 'q.md', path: '/q.md', confidence: 0.2, lastActivity: '2026-01-01T00:00:00Z', reason: 'inactive' }],
        stale: [{ docId: 's', path: '/s.md', type: 'docs', recalledCount: 9, upvotedCount: 0, userCount: 4 }],
      },
    };
    const { context, maintenance } = renderDashboardReport(data);
    // Every element/attribute tagged data-i18n exposes translatable text; collect the
    // trimmed text of the tagged node (text before the next tag) and require a zh key.
    const tagged = [...`${context}${maintenance}`.matchAll(/data-i18n[^>]*>([^<]+)</g)].map(m => m[1].trim());
    expect(tagged.length).toBeGreaterThan(10);
    const missing = tagged.filter(text => text && !Object.hasOwn(dashboardMessages, text));
    expect(missing).toEqual([]);
  });
});
