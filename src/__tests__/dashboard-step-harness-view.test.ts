import { describe, expect, it } from 'vitest';
import { dashboardMessages } from '../dashboard/locales.js';
import { stepHarnessView } from '../dashboard/step-harness-view.js';
import type { RunDetail } from '../dashboard/workflow-runs.js';

const messages: Record<string, string> = dashboardMessages;

type Harness = NonNullable<RunDetail['steps'][number]['harness']>;

/** The line the Steps table shows under a pass's step, as the page renders `harness` in `language`, with every message key it asked for. */
function render(harness: Harness | undefined, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const line = new Function('t', 'e', 'label', `${stepHarnessView}\nreturn stepHarness;`)(t, e, label) as (harness: Harness | undefined) => string;
  return { html: line(harness), keys };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const REVISION = 'c'.repeat(40);

describe("the harness line of a pass in a run's Steps table", () => {
  it("names the tool, model, effort and the step's own role, marked as the step's, with the team revision on hover", () => {
    const { html } = render({ tool: 'claude', model: 'claude-review-1', effort: 'high', role: { of: 'step', names: ['review'] }, teamRevision: REVISION });

    expect(text(html)).toBe('claude · claude-review-1 · high · review step role');
    expect(html).toContain(`title="Team revision ${REVISION}"`);
  });

  it("names the member's roles, marked as the member's, on a pass that ran without a role of its own", () => {
    const { html } = render({ tool: 'codex', model: 'gpt-5', role: { of: 'member', names: ['frontend', 'ops'] }, teamRevision: REVISION });

    expect(text(html)).toBe('codex · gpt-5 · frontend, ops member role');
  });

  it('shows nothing for a pass that ran no tool, and no hover for one with no team delivered', () => {
    expect(render(undefined).html).toBe('');
    expect(render({ tool: 'claude' }).html).not.toContain('title=');
    expect(text(render({ tool: 'claude' }).html)).toBe('claude');
  });

  it('escapes what the record holds and translates every label it asks for', () => {
    const { html, keys } = render({ tool: 'claude', model: '<b>x</b>', role: { of: 'step', names: ['review'] }, teamRevision: REVISION }, 'zh-CN');

    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(['Team revision', 'step role']));
  });
});
