import { describe, expect, it } from 'vitest';
import { dashboardMessages } from '../dashboard/locales.js';
import type { MemberSettingsPanel } from '../dashboard/member-settings.js';
import { memberSettingsView } from '../dashboard/member-settings-view.js';

/** The panel as the page renders `settings`, in `language`, with every message key it asked to translate. */
function render(settings: MemberSettingsPanel, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? dashboardMessages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const panel = new Function('t', 'e', 'label', `${memberSettingsView}\nreturn memberSettingsPanel;`)(t, e, label) as (settings: MemberSettingsPanel) => string;
  return { html: panel(settings), keys };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const MACHINE = '/home/ana/.teamai/config.yaml';
const WORKSPACE = '/home/ana/.teamai/projects/work-a/config.yaml';

const settings: Extract<MemberSettingsPanel, { configured: true }> = {
  configured: true,
  scope: 'workspace',
  home: '/home/ana',
  machineFile: MACHINE,
  rows: [
    { key: 'ai.tool', value: 'claude', source: { level: 'scope', value: 'claude', file: WORKSPACE }, below: [{ level: 'machine', value: 'codex', file: MACHINE }], unused: [] },
    { key: 'recallEnabled', value: true, source: { level: 'machine', value: true, file: MACHINE }, below: [{ level: 'team', value: false, file: '/team/teamai.yaml' }], unused: [] },
    { key: 'updatePolicy', value: 'skip', source: { level: 'scope', value: 'skip', file: MACHINE }, below: [], unused: [{ level: 'scope', value: 'auto', file: WORKSPACE, used: false }] },
    { key: 'workflows.tools.default', value: 'codex', source: { level: 'environment', value: 'codex', variable: 'TEAMAI_AI_TOOL' }, below: [], unused: [] },
  ],
  unread: ['excludedSkills', 'username'],
};

describe('the member settings panel', () => {
  it('shows each setting with its value, the level and file that set it, and the levels below it', () => {
    const shown = text(render(settings).html);

    expect(shown).toContain('ai.tool claude This workspace ~/.teamai/projects/work-a/config.yaml This machine codex');
    expect(shown).toContain('recallEnabled true This machine ~/.teamai/config.yaml Team false');
    expect(shown).toContain('updatePolicy skip User config ~/.teamai/config.yaml This workspace auto not used');
    expect(shown).toContain('workflows.tools.default codex Environment TEAMAI_AI_TOOL');
    expect(shown).toContain('The first level that sets a setting wins: Environment › This workspace › This machine › Team › Default');
  });

  it('names the keys of the machine file that no command reads', () => {
    expect(text(render(settings).html)).toContain('Not read: excludedSkills, username Without a user-scope install, only member settings are read from ~/.teamai/config.yaml');
    expect(render({ ...settings, unread: [] }).html).not.toContain('Not read');
  });

  it('says every setting has its default when no level sets one, and nothing before teamai is set up', () => {
    expect(text(render({ ...settings, rows: [] }).html)).toContain('No level sets a member setting here, so each one has its default.');
    expect(render({ configured: false }).html).toBe('');
  });

  it('shows a file outside the home directory in full', () => {
    const elsewhere = { ...settings.rows[0], source: { level: 'scope' as const, value: 'claude', file: '/home/ana-other/config.yaml' } };

    expect(text(render({ ...settings, rows: [elsewhere] }).html)).toContain('This workspace /home/ana-other/config.yaml');
  });

  it('escapes values and file names', () => {
    const html = render({ ...settings, rows: [{ ...settings.rows[0], value: '<b>x</b>' }] }).html;

    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('has a Chinese message for every text it shows, leaving setting names, values and files as they are written', () => {
    const variants: MemberSettingsPanel[] = [settings, { ...settings, scope: 'user', rows: [] }, { ...settings, scope: 'self', unread: [] }];
    const keys = variants.flatMap((variant) => render(variant).keys);

    expect(keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
    const chinese = text(render(settings, 'zh-CN').html);
    expect(chinese).toContain(dashboardMessages['Member settings']);
    expect(chinese).toContain('ai.tool claude');
    expect(chinese).toContain('~/.teamai/projects/work-a/config.yaml');
  });
});
