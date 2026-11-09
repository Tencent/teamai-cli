import { describe, expect, it } from 'vitest';
import { handoffView } from '../dashboard/handoff-view.js';
import { layeredResourcesView } from '../dashboard/layered-resources-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import type { LayeredResourceList, LayeredResources } from '../dashboard/layered-resources.js';

const messages: Record<string, string> = dashboardMessages;

/** What the endpoint serves for a workspace with a team repo. */
type Served = LayeredResources & { configured: true };

type Views = {
  layeredResourcesPanel: (data: Served | { configured: false } | null, open: Set<string>) => string;
  layeredResourcesNotice: (data: Served | { configured: false } | null) => string;
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
  const built = new Function('t', 'e', 'label', 'number', 'link', `${handoffView}\n${layeredResourcesView}\nreturn { layeredResourcesPanel, layeredResourcesNotice };`)(t, e, label, number, link) as Views;

  return { ...built, keys };
}

const DEPLOY_TWICE = 'workflows/deploy.yaml:1: field "(root)": Workflow "deploy" is defined twice in one place, as workflows/deploy.yaml and as workflows/deploy/; a workflow defined twice has no runnable version';
const HTTP_FOLDER = 'mcp/jira-lite/MCP.yaml: transport http is refused in a folder, which holds the files of a server teamai starts (stdio). A URL server carries no files: declare it in mcp.yaml. mcp was not applied this run, so your installed team MCP servers are unchanged. Fix the file in the team repo and push.';
const IMPORT_BLOCKED = 'teamai\'s default teamai-import-from-repo cannot start: step "enrich" with.wiki_root is not an input workflow "teamai-codebase-enrich" declares';
const MR_HINT_REFUSED = 'hooks/teamai-mr-hint/ is refused, and teamai\'s default stays in force until it is fixed: HOOK.yaml: with.lookback_days must be a whole number from 1 to 90';

const DATA: Served = {
  configured: true,
  language: 'zh',
  types: [
    {
      type: 'workflows',
      marker: 'WORKFLOW.yaml',
      resources: [
        {
          name: 'teamai-codebase-enrich',
          layer: { kind: 'root' },
          form: 'folder',
          path: 'workflows/teamai-codebase-enrich/',
          replaces: { layer: { kind: 'teamai' }, form: 'file', path: 'workflows/teamai-codebase-enrich.yaml' },
          state: { kind: 'in-force' },
          folder: {
            files: [{ path: 'WORKFLOW.yaml', bytes: 812, executable: false }, { path: 'plan.sh', bytes: 2048, executable: true }],
            bytes: 2860,
            limit: 1024 * 1024,
            delivered: { path: '/home/m/.teamai/workflows/folders/ab12cd', present: false, by: 'run' },
            runs: null,
            variant: null,
            reads: null,
          },
        },
        { name: 'deploy', layer: { kind: 'root' }, form: 'file', path: 'workflows/deploy.yaml', replaces: null, state: { kind: 'conflict', reason: 'duplicate', message: DEPLOY_TWICE }, folder: null },
        { name: 'release', layer: { kind: 'namespace', namespace: 'billing' }, form: 'file', path: 'workflows/billing/release.yaml', replaces: null, state: { kind: 'inactive' }, folder: null },
        { name: 'teamai-import-rules', layer: { kind: 'teamai' }, form: 'file', path: 'workflows/teamai-import-rules.yaml', replaces: null, state: { kind: 'in-force' }, folder: null },
        { name: 'teamai-import-from-repo', layer: { kind: 'teamai' }, form: 'file', path: 'workflows/teamai-import-from-repo.yaml', replaces: null, state: { kind: 'blocked', message: IMPORT_BLOCKED }, folder: null },
      ],
      problems: [],
      notes: [],
    },
    {
      type: 'hooks',
      marker: 'HOOK.yaml',
      resources: [{
        name: 'block-secrets',
        layer: { kind: 'root' },
        form: 'folder',
        path: 'hooks/block-secrets/',
        replaces: null,
        state: { kind: 'in-force' },
        folder: {
          files: [{ path: 'HOOK.yaml', bytes: 120, executable: false }, { path: 'scan.sh', bytes: 7, executable: true }],
          bytes: 127,
          limit: null,
          delivered: { path: '/home/m/.teamai/hooks/block-secrets', present: true, by: 'pull' },
          runs: { command: 'bash "/home/m/.teamai/hooks/block-secrets/scan.sh"', args: [], env: [] },
          variant: null,
          reads: null,
        },
      }],
      problems: [],
      notes: [],
    },
    {
      type: 'mcp',
      marker: 'MCP.yaml',
      resources: [
        { name: 'jira-lite', layer: { kind: 'root' }, form: 'folder', path: 'mcp/jira-lite/', replaces: null, state: { kind: 'invalid', message: HTTP_FOLDER, fallback: 'installed' }, folder: null },
        { name: 'github', layer: { kind: 'root' }, form: 'entry', path: 'mcp/mcp.yaml', replaces: null, state: { kind: 'blocked', message: HTTP_FOLDER }, folder: null },
      ],
      problems: [],
      notes: [],
    },
    {
      type: 'benchmarks',
      marker: 'SUITE.yaml',
      resources: [],
      problems: [{ path: 'benchmarks/smoke/', message: 'benchmarks/smoke/ holds both SUITE.yaml and suite.yaml' }],
      notes: [],
    },
  ],
  defaultHooks: [
    {
      name: 'teamai-friction-reminder',
      state: { kind: 'replaced', path: 'hooks/teamai-friction-reminder/' },
      params: [{ key: 'min_tools', teamai: 15, team: 30 }, { key: 'min_score', teamai: 20, team: null }],
      texts: [{ text: 'task', file: 'task.zh.md', replaced: true }, { text: 'gap', file: 'gap.md', replaced: false }],
      delivered: { path: '/home/m/.teamai/hooks/teamai-friction-reminder', present: true },
    },
    {
      name: 'teamai-mr-hint',
      state: { kind: 'refused', path: 'hooks/teamai-mr-hint/', messages: [MR_HINT_REFUSED] },
      params: [{ key: 'lookback_days', teamai: 14, team: 500 }],
      texts: [{ text: 'offer-command', file: 'offer-command.zh.md', replaced: false }],
      delivered: null,
    },
    { name: 'teamai-env-hint', state: { kind: 'teamai' }, params: [], texts: [{ text: 'exec', file: 'exec.md', replaced: false }], delivered: null },
  ],
};

const RECALL_REFUSED = 'rules/teamai-recall/ is not used, so teamai\'s recall rule stays in force: rules/teamai-recall/RULE.md does not contain "Nothing was searched:". Fix the folder in the team repo.';

/** A rule folder in force, the team's recall folder pull refuses, and teamai's recall rule that stays in force. */
const RULES: LayeredResourceList = {
  type: 'rules',
  marker: 'RULE.md',
  resources: [
    {
      name: 'api-style',
      layer: { kind: 'root' },
      form: 'folder',
      path: 'rules/api-style/',
      replaces: null,
      state: { kind: 'in-force' },
      folder: {
        files: [{ path: 'RULE.md', bytes: 71, executable: false }, { path: 'RULE.zh.md', bytes: 42, executable: false }, { path: 'checklist.md', bytes: 15, executable: false }],
        bytes: 128,
        limit: null,
        delivered: { path: '/home/m/app/.teamai/delivered/rules/api-style', present: true, by: 'pull' },
        runs: null,
        variant: 'RULE.zh.md',
        reads: [{ tool: 'claude', reach: 'worktree', path: '/home/m/app/.teamai/delivered/rules/api-style' }, { tool: 'codex', reach: 'worktree', path: '.teamai/delivered/rules/api-style' }],
      },
    },
    {
      name: 'teamai-recall',
      layer: { kind: 'root' },
      form: 'folder',
      path: 'rules/teamai-recall/',
      replaces: null,
      state: { kind: 'refused', message: RECALL_REFUSED },
      folder: { files: [{ path: 'RULE.md', bytes: 33, executable: false }], bytes: 33, limit: null, delivered: null, runs: null, variant: 'RULE.md', reads: null },
    },
    {
      name: 'teamai-recall',
      layer: { kind: 'teamai' },
      form: 'folder',
      path: 'rules/teamai-recall/',
      replaces: null,
      state: { kind: 'in-force' },
      folder: { files: [{ path: 'RULE.md', bytes: 1200, executable: false }], bytes: 1200, limit: null, delivered: null, runs: null, variant: 'RULE.md', reads: null },
    },
  ],
  problems: [],
  notes: [],
};

/** A team definition of no type in particular, for states the fixture does not cover. */
const DEPLOY = { name: 'deploy', layer: { kind: 'root' as const }, form: 'file' as const, path: 'workflows/deploy.yaml', replaces: null, state: { kind: 'in-force' as const }, folder: null };

/** `DATA` with nothing wrong in it. */
const CLEAN: Served = {
  ...DATA,
  types: DATA.types.map((list) => ({ ...list, problems: [], resources: list.resources.filter((resource) => resource.state.kind === 'in-force') })),
  defaultHooks: DATA.defaultHooks.filter((hook) => hook.state.kind !== 'refused'),
};

describe('the Overview notice of resource problems (#1787)', () => {
  it('renders nothing when nothing is wrong, or the workspace has no team repo', () => {
    const { layeredResourcesNotice } = views();

    expect([layeredResourcesNotice(CLEAN), layeredResourcesNotice({ configured: false }), layeredResourcesNotice(null)]).toEqual(['', '', '']);
  });

  it('counts conflicts, invalid definitions and refused replacements, and links to the Resources page', () => {
    const html = views().layeredResourcesNotice(DATA);

    expect(html).toContain('4 resource problems');
    expect(html).toContain('1 conflict · 2 invalid · 1 refused');
    expect(html).toContain('data-page="resources"');
  });
});

/** `text` as the page escapes it. */
const escaped = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The text a reader sees in the row of `html` for the definition `name` at `path` of `type`, or '' when it has none. */
function row(html: string, type: string, path: string, name: string): string {
  const key = escaped(`${type}:${path}#${name}`);
  const start = html.indexOf(`<tr data-row="${key}"`);

  return start === -1 ? '' : html.slice(start, html.indexOf('</tr>', start)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

describe('the resource layers on the Resources page (#1787)', () => {
  it('names each team definition\'s layer, form and state, what it replaces, and what pull prints with the fix', () => {
    const html = views().layeredResourcesPanel(DATA, new Set());
    const enrich = row(html, 'workflows', 'workflows/teamai-codebase-enrich/', 'teamai-codebase-enrich');
    const deploy = row(html, 'workflows', 'workflows/deploy.yaml', 'deploy');
    const release = row(html, 'workflows', 'workflows/billing/release.yaml', 'release');
    const jira = row(html, 'mcp', 'mcp/jira-lite/', 'jira-lite');
    const github = row(html, 'mcp', 'mcp/mcp.yaml', 'github');

    expect([enrich, deploy, release, jira, github].map((found) => found !== '')).toEqual([true, true, true, true, true]);
    expect(enrich).toMatch(/Team root[\s\S]*Folder[\s\S]*In force[\s\S]*teamai default[\s\S]*workflows\/teamai-codebase-enrich\.yaml/);
    expect(deploy).toMatch(/Defined twice[\s\S]*Keep one of them in the team repo, and push\./);
    expect(deploy).toContain(escaped(DEPLOY_TWICE));
    expect(release).toMatch(/Namespace billing[\s\S]*Not active here/);
    expect(jira).toMatch(/Invalid[\s\S]*Your installed copy stays/);
    expect(jira).toContain(escaped(HTTP_FOLDER));
    expect(github).toMatch(/Entry in mcp\/mcp\.yaml[\s\S]*Held this pull/);
  });

  it('folds teamai\'s defaults in force into one row, lists them when it is open, and shows a held one on its own', () => {
    const { layeredResourcesPanel } = views();
    const closed = layeredResourcesPanel(DATA, new Set());
    const opened = layeredResourcesPanel(DATA, new Set(['workflows:teamai']));

    expect([closed.includes('1 teamai default in force'), closed.includes('teamai-import-rules'), opened.includes('teamai-import-rules')]).toEqual([true, false, true]);
    expect(row(closed, 'workflows', 'teamai:workflows/teamai-import-from-repo.yaml', 'teamai-import-from-repo')).toContain(`teamai default File Held this pull ${escaped(IMPORT_BLOCKED)}`);
  });

  it('shows a folder\'s files, size against the limit, where it lands and what it runs once its row is open', () => {
    const { layeredResourcesPanel } = views();
    const enrich = 'workflows:workflows/teamai-codebase-enrich/#teamai-codebase-enrich';
    const secrets = 'hooks:hooks/block-secrets/#block-secrets';
    const closed = layeredResourcesPanel(DATA, new Set());
    const opened = layeredResourcesPanel(DATA, new Set([enrich, secrets])).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

    expect([closed.includes('plan.sh'), closed.includes(`data-layered-toggle="${escaped(enrich)}" aria-expanded="false"`)]).toEqual([false, true]);
    expect(opened).toMatch(/WORKFLOW\.yaml 812 B plan\.sh Executable 2 KB Total 2\.8 KB · Workflow folder limit 1 MB/);
    expect(opened).toContain('Each run keeps this version at /home/m/.teamai/workflows/folders/ab12cd Not kept yet: the next run keeps it');
    expect(opened).toContain('Pull delivers it to /home/m/.teamai/hooks/block-secrets Delivered');
    expect(opened).toContain(`Runs ${escaped('bash "/home/m/.teamai/hooks/block-secrets/scan.sh"')}`);
  });

  it('shows the text a rule folder is read from and where each tool reads it, and the team\'s recall folder pull refuses', () => {
    const { layeredResourcesPanel } = views();
    const key = 'rules:rules/api-style/#api-style';
    const closed = layeredResourcesPanel({ ...DATA, types: [RULES] }, new Set());
    const opened = layeredResourcesPanel({ ...DATA, types: [RULES] }, new Set([key])).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

    expect(row(closed, 'rules', 'rules/teamai-recall/', 'teamai-recall')).toContain(`Team root Folder Refused ${escaped(RECALL_REFUSED)} Fix it in the team repo, and push.`);
    expect([closed.includes('Rule folders'), closed.includes('1 teamai default in force'), closed.includes('RULE.zh.md')]).toEqual([true, true, false]);
    expect(opened).toContain('Rule text from RULE.zh.md Pull delivers it to /home/m/app/.teamai/delivered/rules/api-style Delivered');
    expect(opened).toContain('Where each tool reads ${TEAMAI_RULE_DIR} claude /home/m/app/.teamai/delivered/rules/api-style Reads it in the worktree '
      + 'codex .teamai/delivered/rules/api-style Reads it in the worktree');
  });

  it('opens teamai\'s definition and the team\'s of the same path apart, and says how to turn recall on', () => {
    const { layeredResourcesPanel } = views();
    const off = { ...RULES, resources: RULES.resources.slice(1).map((resource) => ({ ...resource, state: { kind: 'off' as const } })) };
    const html = layeredResourcesPanel({ ...DATA, types: [off] }, new Set(['rules:teamai:rules/teamai-recall/#teamai-recall']));

    expect(html.match(/data-detail="/g)).toHaveLength(1);
    expect(html).toContain('data-detail="rules:teamai:rules/teamai-recall/#teamai-recall"');
    expect(row(html, 'rules', 'rules/teamai-recall/', 'teamai-recall')).toContain('Team root Folder Off Recall is off for this member. teamai recall enable');
  });

  it('lists what pull cannot read as a definition, with its message', () => {
    const html = views().layeredResourcesPanel(DATA, new Set());

    expect(html).toMatch(/benchmarks\/smoke\/[\s\S]*benchmarks\/smoke\/ holds both SUITE\.yaml and suite\.yaml/);
  });
});

describe('teamai\'s default hooks on the Resources page (#1787)', () => {
  /** The visible text of default hook `name`'s row. */
  function hookRow(html: string, name: string): string {
    const start = html.indexOf(`<tr data-row="default-hooks:${name}"`);

    return start === -1 ? '' : html.slice(start, html.indexOf('</tr>', start)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  }

  it('names where each comes from, what the team changed, and why pull refuses a replacement', () => {
    const html = views().layeredResourcesPanel(DATA, new Set());

    expect(hookRow(html, 'teamai-friction-reminder')).toMatch(/Team folder hooks\/teamai-friction-reminder\/ .*1 of 2 parameters changed .*1 of 2 texts changed/);
    expect(hookRow(html, 'teamai-mr-hint')).toMatch(/Refused .*Fix it in the team repo, and push\./);
    expect(html).toContain(escaped(MR_HINT_REFUSED));
    expect(hookRow(html, 'teamai-env-hint')).toMatch(/teamai default .*No parameters .*0 of 1 texts changed/);
  });

  it('compares each parameter with teamai\'s and names the file each text is read from, once open', () => {
    const html = views().layeredResourcesPanel(DATA, new Set(['default-hooks:teamai-friction-reminder']));
    const detailAt = html.indexOf('data-detail="default-hooks:teamai-friction-reminder"');
    // The detail holds tables of its own, so it runs to the next hook's row.
    const detail = html.slice(detailAt, html.indexOf('<tr data-row="default-hooks:teamai-mr-hint"', detailAt));

    expect(detail).toMatch(/<tr class="changed"><td><code[^>]*>min_tools<\/code><\/td><td>15<\/td><td>30<\/td><\/tr>/);
    expect(detail).toMatch(/<tr><td><code[^>]*>min_score<\/code><\/td><td>20<\/td><td><span class="muted">—<\/span><\/td><\/tr>/);
    expect(detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).toMatch(/task task\.zh\.md Changed by the team .*gap gap\.md Base text: this folder has no variant for the language/);
  });
});

describe('the resource layers in Chinese (#1787)', () => {
  it('has a Chinese message for every text it shows, in every state and with every row open', () => {
    const rendered = views('zh-CN');
    const every: Served = {
      ...DATA,
      types: [...DATA.types, {
        type: 'workflows',
        marker: 'WORKFLOW.yaml',
        resources: [
          ...(['kept', 'default', 'installed', 'none'] as const).map((fallback) => ({ ...DEPLOY, name: `invalid-${fallback}`, state: { kind: 'invalid' as const, message: 'x', fallback } })),
          { ...DEPLOY, name: 'two', state: { kind: 'conflict' as const, reason: 'two-namespaces' as const, message: 'x' } },
          { ...DEPLOY, name: 'replaced', state: { kind: 'replaced' as const, by: 'workflows/payments/replaced.yaml' } },
          { ...DEPLOY, name: 'refused', state: { kind: 'refused' as const, message: 'x' } },
          { ...DEPLOY, name: 'delivered', form: 'folder' as const, folder: { files: [], bytes: 0, limit: null, delivered: { path: '/x', present: false, by: 'pull' as const }, runs: { command: 'uv', args: ['a b'], env: ['TOKEN'] }, variant: null, reads: null } },
          { ...DEPLOY, name: 'kept', form: 'folder' as const, folder: { files: [], bytes: 0, limit: null, delivered: { path: '/x', present: true, by: 'run' as const }, runs: null, variant: null, reads: null } },
          { ...DEPLOY, name: 'teamai-a', layer: { kind: 'teamai' as const }, state: { kind: 'in-force' as const } },
          { ...DEPLOY, name: 'teamai-b', layer: { kind: 'teamai' as const }, state: { kind: 'in-force' as const } },
        ],
        problems: [],
        notes: ['a note'],
      }, { type: 'mcp', marker: 'MCP.yaml', resources: [], problems: [], notes: [] }, {
        ...RULES,
        resources: [
          ...RULES.resources,
          { ...DEPLOY, name: 'tagged', state: { kind: 'unsubscribed' as const } },
          { ...DEPLOY, name: 'recall-off', state: { kind: 'off' as const } },
          { ...RULES.resources[0], name: 'none', folder: { ...RULES.resources[0].folder, files: [], bytes: 0, limit: null, delivered: null, runs: null, variant: null, reads: [{ tool: 'cursor', reach: 'none' as const, path: '/x' }] } },
        ],
      }],
      defaultHooks: [...DATA.defaultHooks, { ...DATA.defaultHooks[0], name: 'teamai-todowrite-hint', delivered: { path: '/x', present: false } }],
    };
    const keysOf = (served: Served): string[] => served.types.flatMap((list) => [`${list.type}:teamai`, ...list.resources.map((resource) => `${list.type}:${resource.layer.kind === 'teamai' ? 'teamai:' : ''}${resource.path}#${resource.name}`)]).concat(served.defaultHooks.map((hook) => `default-hooks:${hook.name}`));
    rendered.layeredResourcesPanel(every, new Set());
    rendered.layeredResourcesPanel(every, new Set(keysOf(every)));
    rendered.layeredResourcesPanel({ ...every, language: null }, new Set(keysOf(every)));
    rendered.layeredResourcesNotice(DATA);
    rendered.layeredResourcesNotice({ ...CLEAN, types: [{ ...DATA.types[0], resources: [DATA.types[0].resources[1]] }] });

    expect([...new Set(rendered.keys.filter((key) => !Object.hasOwn(dashboardMessages, key)))]).toEqual([]);
  });
});
