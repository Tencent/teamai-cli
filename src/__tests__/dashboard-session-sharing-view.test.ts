import { describe, expect, it } from 'vitest';
import { dashboardMessages } from '../dashboard/locales.js';
import type { SessionSharing } from '../dashboard/session-sharing.js';
import { sessionSharingView } from '../dashboard/session-sharing-view.js';

/** The panel as the page renders `sharing`, in `language`, with every message key it asked to translate. */
function render(sharing: SessionSharing, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? dashboardMessages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const number = (value: number) => String(value);
  const panel = new Function('t', 'e', 'label', 'number', `${sessionSharingView}\nreturn sessionSharingPanel;`)(t, e, label, number) as (sharing: SessionSharing) => string;
  return { html: panel(sharing), keys };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const defaults: Extract<SessionSharing, { configured: true }> = {
  configured: true,
  runMode: { mode: 'attended', source: 'default' },
  archive: 'teamai-reports',
  publish: { attended: { policy: 'ask', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } },
  scoring: { state: 'ok', policies: { attended: { policy: 'off', source: { kind: 'default' } }, unattended: { policy: 'auto', source: { kind: 'default' } } }, dailyLimit: 10, scorers: ['quality'] },
  problems: ['teamai.yaml sessions.publish.unattended is "<b>yes</b>", not off, ask or auto, so it is ignored.'],
  unreadTools: ['pi'],
  captured: {
    attended: { active: 2, finished: 1, waitingToArchive: 0, archived: 0 },
    unattended: { waitingForDrain: 1, finished: 0, waitingToArchive: 0, archived: 3 },
  },
  stepSessionsWaitingToArchive: { attended: 0, unattended: 0 },
  pendingLabels: 2,
  next: [{ mode: 'unattended', command: 'TEAMAI_MODE=unattended teamai score --drain' }],
};

describe('the session sharing panel', () => {
  it('says per run mode whether sessions are published and scored and why, what waits, and the drain to run', () => {
    const { html } = render(defaults);
    const shown = text(html);

    expect(shown).toContain('Attended Neither published nor scored');
    expect(shown).toContain('Unattended Published and scored');
    expect(shown).toContain('by teamai score --drain before the job ends');
    expect(shown).toContain('Publish ask acts as off for now Set by the default');
    expect(shown).toContain('Score auto Set by the default');
    expect(shown).toMatch(/1 waiting for a drain/);
    expect(shown).toMatch(/3 archived/i);
    expect(text(html.match(/<code class="command">(.*?)<\/code>/)?.[1] ?? '').trim()).toBe('TEAMAI_MODE=unattended teamai score --drain');
    expect(shown).toContain('pi');
    expect(html).toContain('&lt;b&gt;yes&lt;/b&gt;');
    expect(html).not.toContain('<b>yes</b>');
  });

  it('lists pending labels once: with what waits while a drain takes them, else as kept on this machine', () => {
    const waiting = text(render(defaults).html);
    const stuck = text(render({ ...defaults, archive: 'none', next: [] }).html);

    expect(waiting).toContain('Labels waiting to be published: 2');
    expect(waiting).not.toContain('pending on this machine');
    expect(stuck).toContain('Labels 2 pending on this machine');
    expect(stuck).not.toContain('Labels waiting to be published');
  });

  it('shows the step sessions of ended runs that wait to be archived in their mode and with what waits', () => {
    const shown = text(render({ ...defaults, stepSessionsWaitingToArchive: { attended: 0, unattended: 2 } }).html);

    expect(shown).toContain('Unattended Published and scored');
    expect(shown).toMatch(/Unattended .* 2 step sessions waiting to be archived .*Waiting/);
    expect(shown).toContain('Step sessions waiting to be archived: 2');
    expect(text(render({ ...defaults, stepSessionsWaitingToArchive: { attended: 0, unattended: 1 } }).html)).toContain(' 1 step session waiting to be archived ');
  });

  it('has a Chinese message for every text it shows, leaving setting names as they are written', () => {
    const http = { policy: 'off', source: { kind: 'http-team' } } as const;
    const variants: SessionSharing[] = [
      defaults,
      { ...defaults, runMode: { mode: 'unattended', source: 'CI', ignored: 'yes' }, scoring: { ...defaults.scoring, scorers: [] } as typeof defaults.scoring,
        next: [{ mode: 'attended', command: 'TEAMAI_MODE=attended teamai score --drain' }, { mode: 'unattended', command: 'teamai score --drain' }],
        captured: { attended: { active: 0, finished: 0, waitingToArchive: 1, archived: 0 }, unattended: { waitingForDrain: 1, finished: 1, waitingToArchive: 1, archived: 0 } },
        stepSessionsWaitingToArchive: { attended: 1, unattended: 2 } },
      { ...defaults, runMode: { mode: 'attended', source: 'TEAMAI_MODE' }, archive: 'none', publish: { attended: http, unattended: http },
        scoring: { state: 'unavailable', reason: 'Scoring is off for this project.' }, unreadTools: [], problems: [], next: [] },
      { ...defaults, publish: { attended: { policy: 'auto', source: { kind: 'setting', key: 'config.yaml sessions.publish.attended' } }, unattended: { policy: 'off', source: { kind: 'setting', key: 'teamai.yaml sessions.publish.unattended' } } } },
    ];
    const keys = variants.flatMap((sharing) => render(sharing).keys);

    expect(keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
    expect(text(render(defaults, 'zh-CN').html)).toContain(dashboardMessages['Neither published nor scored']);
    const settings = text(render(variants[3], 'zh-CN').html);
    expect(settings).toContain('config.yaml sessions.publish.attended');
    expect(settings).toContain('teamai.yaml sessions.publish.unattended');
    expect(text(render(variants[2], 'zh-CN').html)).toContain(dashboardMessages['an HTTP team repo, which keeps no session archive']);
  });

  it('puts a full-width colon between a label and its value in Chinese, and a colon and a space in English', () => {
    const waiting = { ...defaults, runMode: { mode: 'unattended' as const, source: 'CI' as const, ignored: 'yes' } };

    const chinese = text(render(waiting, 'zh-CN').html);
    const english = text(render(waiting).html);

    for (const shown of [`${dashboardMessages['This machine']}：`, `${dashboardMessages['TEAMAI_MODE ignored']}：`, `${dashboardMessages['Unattended sessions waiting for a drain']}：`, `${dashboardMessages['Scorers that judge sessions']}：`]) {
      expect(chinese).toContain(shown);
    }
    expect(chinese).not.toMatch(/[\u4e00-\u9fff]: /);
    for (const shown of ['This machine: ', 'TEAMAI_MODE ignored: ', 'Unattended sessions waiting for a drain: ', 'Scorers that judge sessions: ']) {
      expect(english).toContain(shown);
    }
  });
});
