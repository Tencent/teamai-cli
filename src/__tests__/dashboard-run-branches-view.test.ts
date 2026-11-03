import { describe, expect, it } from 'vitest';
import { dashboardMessages } from '../dashboard/locales.js';
import { runBranchesView } from '../dashboard/run-branches-view.js';
import type { RunBranches } from '../dashboard/workflow-runs.js';

const messages: Record<string, string> = dashboardMessages;

/** The Branches of a run's details as the page renders `branches` in `language`, with every message key it asked for. */
function render(branches: RunBranches, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const label = (text: string) => e(t(text));
  const when = (iso: string) => iso;
  const command = (text: string) => `<code class="cmd" data-copy="${e(text)}">${e(text)}</code>`;
  const html = new Function('t', 'e', 'label', 'when', 'command', `${runBranchesView}\nreturn runBranchesHtml;`)(t, e, label, when, command) as (b: RunBranches) => string;
  return { html: html(branches), keys };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const run = 'r0123456789abcdef';
const branch = (name: string) => `teamai/${run}/${name}/p1`;

const CLEANED: RunBranches = {
  state: 'cleaned', by: 'success', at: '2026-11-03T08:00:00.000Z',
  kept: [{ branch: branch('change'), why: 'pr' }, { branch: branch('notes'), why: 'unmerged' }], deleted: [branch('build-0')],
  failed: [{ branch: branch('build-1'), reason: 'on origin: deleting is not allowed' }],
};
const KEPT = {
  state: 'kept', retention: { kind: 'after', ms: 14 * 86_400_000, text: '14d', file: '/home/ana/.teamai/config.yaml' }, eligibleAt: '2026-11-17T08:00:00.000Z',
  branches: [{ branch: branch('change'), isPullRequest: true }, { branch: branch('docs'), isPullRequest: false }],
} satisfies RunBranches;
const NEVER: RunBranches = { state: 'kept', retention: { kind: 'never', text: 'never' }, branches: KEPT.branches };

describe("a settled run's Branches", () => {
  it('names each branch a succeeded run kept and why, those it deleted, and those doctor --fix still has to delete', () => {
    const shown = text(render(CLEANED).html);

    expect(shown).toContain(`Kept ${branch('change')} Pull request ${branch('notes')} Not held by a kept branch`);
    expect(shown).toContain(`Deleted ${branch('build-0')}`);
    expect(shown).toContain(`Not deleted: teamai doctor --fix tries again ${branch('build-1')} on origin: deleting is not allowed`);
    expect(render(CLEANED).html).toContain('data-copy="teamai doctor --fix"');
  });

  it('says from when doctor --fix removes what a failed run kept, and under which retention', () => {
    const shown = text(render(KEPT).html);

    expect(shown).toContain(`Kept for inspection ${branch('change')} Pull request ${branch('docs')}`);
    expect(shown).toContain('teamai doctor --fix removes them, except pull request branches. Eligible from 2026-11-17T08:00:00.000Z workflows.retention 14d · /home/ana/.teamai/config.yaml');
    expect(text(render(NEVER).html)).toContain('workflows.retention is never, so teamai doctor --fix keeps them.');
  });

  it('has a zh-CN translation for every message it shows', () => {
    const keys = [CLEANED, { ...CLEANED, by: 'retention' as const }, KEPT, NEVER].flatMap((b) => render(b, 'zh-CN').keys);
    expect(keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
