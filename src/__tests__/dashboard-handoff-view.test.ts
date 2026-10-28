import { describe, expect, it } from 'vitest';
import { handoffView } from '../dashboard/handoff-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import type { HandoffRow } from '../dashboard/workflow-runs.js';
import { RunIdSchema } from '../workflow/store.js';

/** The panel as the page renders `rows`, in `language`, with every message key it asked to translate. */
function render(rows: HandoffRow[], language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? dashboardMessages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const number = (value: number) => String(value);
  const when = (iso: string) => iso;
  const panel = new Function('t', 'e', 'label', 'number', 'when', `${handoffView}\nreturn handoffPanel;`)(t, e, label, number, when) as (rows: HandoffRow[], local: Set<string>) => string;
  return { html: panel(rows, new Set()), keys };
}

/** What each row's Copy button copies, in row order. */
const copied = (html: string) => [...html.matchAll(/data-copy="([^"]*)"/g)].map((match) => match[1]);

function row(run: string, { isMine, offer }: Pick<HandoffRow, 'isMine' | 'offer'>): HandoffRow {
  return {
    run: RunIdSchema.parse(run), workflow: 'ship-issue', isMine, ownedAt: '2026-10-28T09:00:00.000Z', repository: 'github.com/acme/app',
    owner: isMine ? { id: 'install-alice', user: 'alice' } : { id: 'install-bob', user: 'bob' }, ...(offer ? { offer } : {}),
  };
}

const NONE = { env: [], prompts: [] };
const RUNNABLE = { at: '2026-10-28T09:05:00.000Z', needs: [], uses: NONE, lacks: [] };
const GATED = { at: '2026-10-28T09:05:00.000Z', needs: ['only a person can answer the approval at ship'], uses: NONE, lacks: [] };
const SIGNED = {
  at: '2026-10-28T09:05:00.000Z', needs: [], uses: { env: ['SIGNING_KEY'], prompts: ['notes'] },
  lacks: [{ reason: 'sign requires env SIGNING_KEY, which has no value here', fix: 'Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret)' }],
};

describe('the Handed-off runs panel', () => {
  it('gives each run the command that takes it from this install', () => {
    const { html } = render([
      row('r0000000000000001', { isMine: true, offer: RUNNABLE }),
      row('r0000000000000002', { isMine: false, offer: GATED }),
      row('r0000000000000003', { isMine: false, offer: RUNNABLE }),
      row('r0000000000000004', { isMine: false }),
      row('r0000000000000005', { isMine: true }),
    ]);
    expect(copied(html)).toEqual([
      // A runner's --next never takes this install's own offer, so the owner resumes it here to take it back.
      'teamai workflow resume r0000000000000001',
      // A person takes another install's run over with --claim, even on a machine that still holds an earlier copy.
      'teamai workflow resume r0000000000000002 --claim',
      'teamai workflow resume --next',
      'teamai workflow resume r0000000000000004 --claim',
    ]);
    expect(html).toContain('This install drives it');
  });

  it('says what a runner needs for the steps left, and what this machine lacks of it with what gives it', () => {
    const { html } = render([row('r0000000000000001', { isMine: false, offer: SIGNED })]);
    expect(html).toContain('A runner needs');
    expect(html).toContain('<code data-verbatim>SIGNING_KEY</code>');
    expect(html).toContain('a tool for <span data-verbatim>notes</span>');
    expect(html).toContain('Not on this machine');
    expect(html).toContain('sign requires env SIGNING_KEY, which has no value here');
    expect(html).toContain('Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret)');
    expect(html).not.toContain('Nothing: a runner can finish it');
  });

  it('has a zh-CN translation for every message it shows', () => {
    const { keys } = render([
      row('r0000000000000001', { isMine: true, offer: RUNNABLE }),
      row('r0000000000000002', { isMine: false, offer: GATED }),
      row('r0000000000000003', { isMine: false, offer: RUNNABLE }),
      row('r0000000000000004', { isMine: false }),
      row('r0000000000000005', { isMine: true }),
      row('r0000000000000006', { isMine: false, offer: SIGNED }),
    ], 'zh-CN');
    expect(render([], 'zh-CN').keys.concat(keys).filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
