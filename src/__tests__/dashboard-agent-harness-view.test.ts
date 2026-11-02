import { describe, expect, it } from 'vitest';
import { dashboardMessages } from '../dashboard/locales.js';
import type { AgentHarness } from '../agent-observation.js';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';

const messages: Record<string, string> = dashboardMessages;

/** The line a run's Steps and the Scorers failing labels show for a pass, as the page renders `harness` in `language`, with every message key it asked for. */
function render(harness: AgentHarness | undefined, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const line = new Function('t', 'e', 'label', `${agentHarnessView}\nreturn agentHarness;`)(t, e, label) as (harness: AgentHarness | undefined) => string;
  return { html: line(harness), keys };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const REVISION = 'c'.repeat(40);

/** Each part of the line that must not break inside, as text. */
const parts = (html: string): string[] => [...html.matchAll(/<span class="harness-part"[^>]*>(.*?)<\/span>(?= · |<\/span>$)/g)].map(([, part]) => text(part ?? ''));

describe('the harness line of a pass', () => {
  it("names the tool, model, effort, the step's own role marked as the step's, and the short team revision, with the full one on hover", () => {
    const { html } = render({ tool: 'claude', model: 'claude-review-1', effort: 'high', role: { of: 'step', names: ['review'] }, teamRevision: REVISION });

    expect(text(html)).toBe('claude · claude-review-1 · high · review step role · ccccccc');
    // The short revision stays on the line of the part before it, so it never sits alone on a line.
    expect(parts(html)).toEqual(['claude', 'claude-review-1', 'high', 'review step role · ccccccc']);
    // One unbreakable span holds both: a browser may break after an inline-block marker even at a no-break space.
    expect(html).toMatch(/<span class="harness-part"><span class="harness-part"><span data-verbatim>review<\/span> <span class="role-of step">step role<\/span><\/span>\u00a0·\u00a0<span class="harness-part" data-verbatim>ccccccc<\/span><\/span><\/span>$/);
    expect(html).toContain('<span class="role-of step">step role</span>');
    expect(html).toContain(`title="Team revision ${REVISION}"`);
  });

  it("names the member's roles, marked as the member's in the same kind of marker, on a pass that ran without a role of its own", () => {
    const { html } = render({ tool: 'codex', model: 'gpt-5', role: { of: 'member', names: ['frontend', 'ops'] }, teamRevision: REVISION });

    expect(text(html)).toBe('codex · gpt-5 · frontend, ops member role · ccccccc');
    expect(html).toContain('<span class="role-of member">member role</span>');
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
