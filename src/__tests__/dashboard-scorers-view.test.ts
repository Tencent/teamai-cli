import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../agent-observation.js';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { dashboardStyles } from '../dashboard/styles.js';
import { scorersClient } from '../dashboard/scorers-client.js';
import type { ScoreLabel } from '../scorers/label.js';
import { ScorerResults, type ViewedLabel } from '../scorers/results.js';

const messages: Record<string, string> = dashboardMessages;

const NOW = new Date('2026-10-28T12:00:00Z');
const REVIEWED = 'a'.repeat(40);
const MEMBER = 'b'.repeat(40);

/** A pass that ran on `tool` with `model`, delivered at `revision` for the member `frontend`, in a copy with `stepRole` when given. */
const ranAs = ({ tool, model, revision, stepRole }: { tool: string; model: string; revision: string; stepRole?: string }): AgentObservation => ({
  v: 1, tool: { name: tool }, model: { reported: model }, ...(tool === 'claude' ? { effort: { requested: 'high' } } : {}), teamai: '1.0.0', driver: 'local',
  team: { revision, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], ...(stepRole ? { stepRole } : {}) } },
});

function label(runId: string, step: string, { passed, scoredAt, agent }: { passed: boolean; scoredAt: string; agent?: AgentObservation }): ScoreLabel {
  return {
    scorer: 'review-quality', rubric: { sourceHash: 'rubric-1', teamRevision: REVIEWED }, label: passed ? 'thorough' : 'missed-defect', score: passed ? 1 : 0, passed,
    judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-judge-1' }, isolation: 'verified', access: 'read' },
    scoredAt, source: 'workflow', subject: { runId, step, pass: 1 }, ...(agent ? { agent } : {}),
  };
}

/**
 * A team lead's week of a code-review workflow: its `review` step runs with `role: review`, its `implement` step with
 * the member's role. One run is still listed, the others are gone, and one label was written before labels carried an agent.
 */
const viewed = (author: string, judged: ScoreLabel, runSource?: 'reported'): ViewedLabel => ({
  author, label: judged, ...(judged.agent ? { agent: judged.agent } : {}), ...(runSource ? { runSource } : {}),
});
const LABELS: ViewedLabel[] = [
  viewed('bob', label('r0000000000000001', 'review', { passed: false, scoredAt: '2026-10-27T10:00:00.000Z', agent: ranAs({ tool: 'claude', model: 'claude-review-1', revision: REVIEWED, stepRole: 'review' }) }), 'reported'),
  viewed('bob', label('r0000000000000002', 'review', { passed: true, scoredAt: '2026-10-26T10:00:00.000Z', agent: ranAs({ tool: 'claude', model: 'claude-review-1', revision: REVIEWED, stepRole: 'review' }) })),
  viewed('ana', label('r0000000000000003', 'implement', { passed: false, scoredAt: '2026-10-25T10:00:00.000Z', agent: ranAs({ tool: 'codex', model: 'gpt-5', revision: MEMBER }) })),
  viewed('ana', label('r0000000000000004', 'implement', { passed: false, scoredAt: '2026-10-24T10:00:00.000Z' })),
];

/** The Scorers page as the dashboard renders `labels` grouped by `groupBy`, in `language`, with every message key it asked for. */
async function renderPage(labels: ViewedLabel[], { groupBy = 'role', language = 'en' }: { groupBy?: string; language?: 'en' | 'zh-CN' } = {}): Promise<{ html: string; keys: string[] }> {
  const view = { configured: true, ...ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role' }, now: NOW }) };
  const keys: string[] = [];
  const t = (text: string): string => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] ?? text : text;
  };
  const e = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const scope = {
    t, e, label: (text: string) => e(t(text)), number: (value: number) => new Intl.NumberFormat('en').format(value), when: (value: string) => value,
    read: (key: string, fallback: string) => (key === 'teamai-dashboard-scorer-group' ? groupBy : fallback), save: () => undefined, $: () => undefined,
    apiQuery: (route: string) => route, errorPanel: (text: string) => text, render: () => undefined, page: 'scorers', workspaceGeneration: 0,
    fetch: async () => ({ ok: true, json: async () => view }), document: { addEventListener: () => undefined },
  };
  const page = new Function(...Object.keys(scope), `${agentHarnessView}\n${scorersClient}\nreturn { scorersPage, loadScorers };`)(...Object.values(scope)) as {
    scorersPage: () => string; loadScorers: () => Promise<void>;
  };
  await page.loadScorers();
  return { html: page.scorersPage(), keys };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The text of each row of the table under the heading `heading`. */
function rowsUnder(html: string, heading: string): string[] {
  const section = html.split('<section').find((part) => part.includes(`<h2>${heading} `)) ?? '';
  return [...section.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].slice(1).map(([, row]) => text(row ?? ''));
}

describe('the Scorers page of a workflow whose review step runs with a role of its own', () => {
  it("groups the labels by the role each pass ran with, and marks whether that was the step's role or the member's", async () => {
    const { html } = await renderPage(LABELS);

    expect(rowsUnder(html, 'By Role')).toEqual(['review step 2 1 1 50%', 'frontend member 1 0 1 0%', 'Not recorded 1 0 1 0%']);
    expect(html).toContain('<span class="role-of step">step</span>');
    expect(html).toContain('<span class="role-of member">member</span>');
  });

  it("lays both tables out as cards by the panel's own width, so a narrow panel beside the sidebar keeps every column", async () => {
    const { html } = await renderPage(LABELS);
    const cellNames = (table: string) => {
      const [row] = [...html.matchAll(new RegExp(`<table class="session-table ${table}">.*?<tbody>(<tr[^>]*>.*?</tr>)`, 'gs'))].map(([, first]) => first ?? '');
      return [...(row ?? '').matchAll(/<td[^>]*data-label="([^"]+)"/g)].map(([, name]) => name);
    };

    expect(html).toContain('<div class="table-scroll card-table"><table class="session-table scorer-groups">');
    expect(html).toContain('<div class="table-scroll card-table"><table class="session-table failing-labels">');
    expect(cellNames('scorer-groups')).toEqual(['VALUE', 'LABELS', 'PASSED', 'FAILED', 'PASS RATE']);
    expect(dashboardStyles).toContain('.card-table{container-type:inline-size}');
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.failing-labels thead,[^@]*\.scorer-groups thead[^{]*\{display:none\}/);
  });

  it('shows each failing label\'s harness on one line, opens a run still listed, and says when the harness was not recorded', async () => {
    const { html } = await renderPage(LABELS);

    expect(rowsUnder(html, 'Failing labels')).toEqual([
      '2026-10-27T10:00:00.000Z bob missed-defect claude · claude-review-1 · high · review step role · aaaaaaa Workflow run — r0000000000000001 ↗ review #1',
      '2026-10-25T10:00:00.000Z ana missed-defect codex · gpt-5 · frontend member role · bbbbbbb Workflow run — r0000000000000003 Run not found implement #1',
      '2026-10-24T10:00:00.000Z ana missed-defect Harness not recorded Workflow run — r0000000000000004 Run not found implement #1',
    ]);
    expect(html).toContain('<span class="role-of step">step role</span>');
    expect(html).toContain('data-run="r0000000000000001" data-run-source="reported"');
    expect(html).toContain(`title="Team revision ${REVIEWED}"`);
  });

  it('labels each cell of a failing label, so a phone shows it as a card that names its parts', async () => {
    const { html } = await renderPage(LABELS);
    const section = html.split('<section').find((part) => part.includes('<h2>Failing labels ')) ?? '';
    const [row] = [...section.matchAll(/<tbody>(<tr>.*?<\/tr>)/gs)].map(([, first]) => first ?? '');

    expect([...(row ?? '').matchAll(/<td[^>]*data-label="([^"]+)"/g)].map(([, name]) => name)).toEqual(['SCORED', 'AUTHOR', 'LABEL', 'HARNESS', 'PLATFORM', 'SKILLS', 'OPEN']);
    expect(section).toContain('class="session-table failing-labels"');
  });

  it('translates every label the role groups and the failing list ask for', async () => {
    const { keys } = await renderPage(LABELS, { language: 'zh-CN' });

    expect(keys).toEqual(expect.arrayContaining(['HARNESS', 'Harness not recorded', 'step role', 'member role', 'Team revision', 'step', 'member']));
    expect([...new Set(keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
