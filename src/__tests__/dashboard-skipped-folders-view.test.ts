import { describe, expect, it } from 'vitest';
import { handoffView } from '../dashboard/handoff-view.js';
import { skippedFoldersView } from '../dashboard/skipped-folders-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import type { DashboardSkippedFolder } from '../dashboard/resources.js';

const messages: Record<string, string> = dashboardMessages;

type Views = {
  skippedFoldersPanel: (folders: DashboardSkippedFolder[]) => string;
  skippedFoldersNotice: (folders: DashboardSkippedFolder[]) => string;
};

/** Both views as the page renders them, in `language`, with every message key they asked to translate. */
function views(language: 'en' | 'zh-CN' = 'en'): Views & { keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const number = (value: number) => String(value);
  const link = (key: string, text: string) => `<button class="link" data-page="${key}">${label(text)} →</button>`;
  const built = new Function('t', 'e', 'label', 'number', 'link', `${handoffView}\n${skippedFoldersView}\nreturn { skippedFoldersPanel, skippedFoldersNotice };`)(t, e, label, number, link) as Views;

  return { ...built, keys };
}

const FOLDERS: DashboardSkippedFolder[] = [
  { path: 'agents/reviewer/', type: 'agents', kind: 'Agent folder', marker: 'AGENT.md' },
  { path: 'scorers/tone/', type: 'scorers', kind: 'Scorer folder', marker: 'SCORER.md' },
];

describe('skipped folders on the dashboard (#1791)', () => {
  it('renders nothing when no folder is skipped', () => {
    const { skippedFoldersPanel, skippedFoldersNotice } = views();

    expect(skippedFoldersPanel([])).toBe('');
    expect(skippedFoldersNotice([])).toBe('');
  });

  it('lists each folder with its kind and marker, and the command that fixes it', () => {
    const html = views().skippedFoldersPanel(FOLDERS);

    expect(html).toContain('agents/reviewer/');
    expect(html).toContain('Agent folder');
    expect(html).toContain('AGENT.md');
    expect(html).toContain('scorers/tone/');
    expect(html).toContain('SCORER.md');
    expect([...html.matchAll(/data-copy="([^"]*)"/g)].map((match) => match[1])).toEqual(['teamai update &amp;&amp; teamai pull']);
  });

  it('points the overview at the Resources page with the count', () => {
    const html = views().skippedFoldersNotice(FOLDERS);

    expect(html).toContain('2 team folders are skipped');
    expect(html).toContain('data-page="resources"');
  });

  it('says one folder in the singular', () => {
    expect(views().skippedFoldersNotice(FOLDERS.slice(0, 1))).toContain('1 team folder is skipped');
  });

  it('has a Chinese message for every text it shows', () => {
    const rendered = views('zh-CN');
    rendered.skippedFoldersPanel(FOLDERS);
    rendered.skippedFoldersNotice(FOLDERS);
    rendered.skippedFoldersNotice(FOLDERS.slice(0, 1));

    expect(rendered.keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
