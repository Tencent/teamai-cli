import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { RESOURCE_LAYOUTS, Resources, type PlainLayout, type ResourceLayout, type ResourceTree } from '../resources/resolver.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory holding `files`, by `/`-separated path. */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-resolver-'));
  dirs.push(root);

  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  return root;
}

/** A tree over `team` and, when given, a teamai package holding `shipped`, whose defaults read as their content. */
function treeOf(team: Record<string, string>, active: readonly string[] | 'legacy', shipped?: Record<string, string>): ResourceTree<string> {
  const root = fixture(team);
  const namespaces = async (): Promise<readonly string[] | 'legacy'> => active;

  return shipped === undefined
    ? { team: { root, namespaces } }
    : { team: { root, namespaces }, teamai: { root: fixture(shipped), read: ({ content }) => content } };
}

const yamlStem = (file: string): string | null => (file.endsWith('.yaml') ? file.slice(0, -'.yaml'.length) : null);

/** A type of this test only, whose folders this release reads: no real type reserves `WIDGET.yaml`. */
const widgets: PlainLayout = { dir: 'widgets', marker: 'WIDGET.yaml', fileName: yamlStem };

/** A type of this test only, whose items are entries in `gadgets.yaml`: one `name=value` line each, `#` a note. */
const gadgets: ResourceLayout<string> = {
  dir: 'gadgets',
  marker: null,
  fileName: () => null,
  entryList: {
    file: 'gadgets.yaml',
    entries: (content, file) => {
      const lines = content.split('\n').filter((line) => line !== '');
      const broken = lines.find((line) => !line.includes('=') && !line.startsWith('#'));

      if (broken !== undefined) return { kind: 'invalid', message: `${file}: "${broken}" is not name=value` };

      return {
        kind: 'entries',
        entries: lines.filter((line) => line.includes('=')).map((line) => ({ name: line.slice(0, line.indexOf('=')), entry: line.slice(line.indexOf('=') + 1) })),
        notes: lines.filter((line) => line.startsWith('#')).map((line) => `${file}: ${line.slice(1)}`),
      };
    },
  },
};

/** `widgets` whose folder names are lower-case letters only. */
const strictWidgets: ResourceLayout = { ...widgets, nameRule: { pattern: /^[a-z]+$/, description: 'a widget name is lower-case letters only' } };

interface Row {
  readonly case: string;
  readonly layout: PlainLayout;
  /** The team's files, by path. */
  readonly team: Record<string, string>;
  readonly active: readonly string[] | 'legacy';
  /** The files of teamai's package, when the tree has its defaults. */
  readonly shipped?: Record<string, string>;
  readonly name: string;
  readonly expected: object;
}

const rows: Row[] = [
  {
    case: 'default only',
    layout: RESOURCE_LAYOUTS.workflows,
    team: {},
    active: [],
    shipped: { 'workflows/teamai-x.yaml': 'shipped x' },
    name: 'teamai-x',
    expected: {
      kind: 'resolved',
      item: { layer: 'teamai', name: 'teamai-x', source: { kind: 'file', path: 'workflows/teamai-x.yaml' }, shipped: 'shipped x' },
      replaces: null,
    },
  },
  {
    case: 'the team root replaces the default',
    layout: RESOURCE_LAYOUTS.workflows,
    team: { 'workflows/teamai-x.yaml': 'team x' },
    active: [],
    shipped: { 'workflows/teamai-x.yaml': 'shipped x' },
    name: 'teamai-x',
    expected: {
      kind: 'resolved',
      item: { layer: 'root', name: 'teamai-x', source: { kind: 'file', path: 'workflows/teamai-x.yaml' } },
      replaces: { layer: 'teamai', shipped: 'shipped x' },
    },
  },
  {
    case: 'a namespace replaces the root',
    layout: RESOURCE_LAYOUTS.workflows,
    team: { 'workflows/release.yaml': 'root', 'workflows/payments/release.yaml': 'payments' },
    active: ['payments'],
    name: 'release',
    expected: {
      kind: 'resolved',
      item: { layer: 'namespace', namespace: 'payments', name: 'release', source: { kind: 'file', path: 'workflows/payments/release.yaml' } },
      replaces: { layer: 'root', source: { path: 'workflows/release.yaml' } },
    },
  },
  {
    case: 'an inactive namespace is ignored',
    layout: RESOURCE_LAYOUTS.workflows,
    team: { 'workflows/release.yaml': 'root', 'workflows/billing/release.yaml': 'billing' },
    active: ['payments'],
    name: 'release',
    expected: { kind: 'resolved', item: { layer: 'root', source: { path: 'workflows/release.yaml' } }, replaces: null },
  },
  {
    case: 'legacy mode reads every namespace on disk',
    layout: RESOURCE_LAYOUTS.workflows,
    team: { 'workflows/release.yaml': 'root', 'workflows/payments/release.yaml': 'payments' },
    active: 'legacy',
    name: 'release',
    expected: {
      kind: 'resolved',
      item: { layer: 'namespace', namespace: 'payments', source: { path: 'workflows/payments/release.yaml' } },
      replaces: { layer: 'root', source: { path: 'workflows/release.yaml' } },
    },
  },
  {
    case: 'two active namespaces conflict, in the order they are active',
    layout: RESOURCE_LAYOUTS.workflows,
    team: { 'workflows/payments/release.yaml': 'payments', 'workflows/billing/release.yaml': 'billing' },
    active: ['payments', 'billing'],
    name: 'release',
    expected: {
      kind: 'conflict',
      name: 'release',
      reason: 'two-namespaces',
      first: { layer: 'namespace', namespace: 'payments', source: { path: 'workflows/payments/release.yaml' } },
      second: { layer: 'namespace', namespace: 'billing', source: { path: 'workflows/billing/release.yaml' } },
    },
  },
  {
    case: 'a file and a folder of one name are a duplicate',
    layout: widgets,
    team: { 'widgets/release.yaml': 'file', 'widgets/release/WIDGET.yaml': 'folder' },
    active: [],
    name: 'release',
    expected: {
      kind: 'conflict',
      name: 'release',
      reason: 'duplicate',
      first: { layer: 'root', source: { kind: 'file', path: 'widgets/release.yaml' } },
      second: { layer: 'root', source: { kind: 'folder', path: 'widgets/release/' } },
    },
  },
  {
    case: 'a folder in a namespace replaces a root file',
    layout: widgets,
    team: { 'widgets/release.yaml': 'root', 'widgets/payments/release/WIDGET.yaml': 'payments' },
    active: ['payments'],
    name: 'release',
    expected: {
      kind: 'resolved',
      item: { layer: 'namespace', namespace: 'payments', source: { kind: 'folder', path: 'widgets/payments/release/' } },
      replaces: { layer: 'root', source: { kind: 'file', path: 'widgets/release.yaml' } },
    },
  },
  {
    case: 'teamai ships a default as a folder',
    layout: widgets,
    team: {},
    active: [],
    shipped: { 'widgets/teamai-x/WIDGET.yaml': 'shipped x', 'widgets/teamai-x/notes.md': 'support' },
    name: 'teamai-x',
    expected: { kind: 'resolved', item: { layer: 'teamai', source: { kind: 'folder', path: 'widgets/teamai-x/' }, shipped: 'shipped x' }, replaces: null },
  },
];

describe('Resources.resolve', () => {
  it.each(rows)('$case', async ({ layout, team, active, shipped, name, expected }) => {
    expect(await Resources.resolve(layout, name, treeOf(team, active, shipped))).toMatchObject(expected);
  });

  it('resolves an entry inside an entry-list file', async () => {
    const tree = treeOf({ 'gadgets/gadgets.yaml': 'lint=run lint\nformat=run format\n' }, []);

    expect((await Resources.survey(gadgets, tree)).resolutions.find(({ name }) => name === 'format')).toMatchObject({
      kind: 'resolved',
      item: { layer: 'root', name: 'format', source: { kind: 'entry', path: 'gadgets/gadgets.yaml', index: 1, entry: 'run format' } },
      replaces: null,
    });
  });
});

describe('Resources.survey', () => {
  it('names an entry-list file that cannot be used, instead of reading it as one with no entries', async () => {
    const tree = treeOf({ 'gadgets/gadgets.yaml': 'lint=run lint\nformat run format\n' }, []);

    expect(await Resources.survey(gadgets, tree)).toEqual({
      resolutions: [],
      definitions: [],
      diagnostics: [{ kind: 'invalid', path: 'gadgets/gadgets.yaml', message: 'gadgets/gadgets.yaml: "format run format" is not name=value' }],
    });
  });

  it('names a folder that is a symlink, and gives no item for it, as it names a symlink inside a folder', async () => {
    const shared = fixture({ 'WIDGET.yaml': 'release' });
    const root = fixture({ 'widgets/build/WIDGET.yaml': 'build' });
    fs.symlinkSync(shared, path.join(root, 'widgets', 'release'), 'dir');
    const tree: ResourceTree<string> = { team: { root, namespaces: async () => [] } };

    const { resolutions, diagnostics } = await Resources.survey(widgets, tree);

    expect([resolutions.map(({ name }) => name), diagnostics]).toEqual([['build'], [{
      kind: 'invalid',
      path: 'widgets/release/',
      message: 'widgets/release/ is a symlink, and a folder holds its own files, never a link, so nothing is read from it. Put the directory itself in the team repo.',
    }]]);
  });

  it('names a folder whose name breaks the layout\'s name rule, and gives no item for it', async () => {
    const tree = treeOf({ 'widgets/Release/WIDGET.yaml': 'release', 'widgets/build/WIDGET.yaml': 'build' }, []);

    const { resolutions, diagnostics } = await Resources.survey(strictWidgets, tree);

    expect([resolutions.map(({ name }) => name), diagnostics]).toEqual([['build'], [{
      kind: 'invalid',
      path: 'widgets/Release/',
      message: 'widgets/Release/ is not a valid name: a widget name is lower-case letters only. Rename the folder.',
    }]]);
  });

  it('notes a directory that holds the marker beside files its type reads, which are now that folder\'s files', async () => {
    const tree = treeOf({
      'gadgets/payments/GADGET.yaml': 'marker',
      'gadgets/payments/gadgets.yaml': 'lint=run lint\n',
      'gadgets/payments/notes.md': 'support',
    }, ['payments']);

    const { resolutions, diagnostics } = await Resources.survey({ ...gadgets, marker: 'GADGET.yaml' }, tree);

    expect([resolutions.map(({ name }) => name), diagnostics]).toEqual([['payments'], [{
      kind: 'note',
      path: 'gadgets/payments/',
      message: 'gadgets/payments/ holds GADGET.yaml, so it is one folder, and gadgets.yaml in it is one of its files, no longer read on its own.',
    }]]);
  });

  it('never names a language variant of the marker in that note, since it is the folder\'s own text', async () => {
    const tree = treeOf({
      'widgets/release/WIDGET.yaml': 'marker',
      'widgets/release/WIDGET.zh.yaml': 'variant',
      'widgets/release/steps.yaml': 'was a widget',
    }, []);

    const { diagnostics } = await Resources.survey(widgets, tree);

    expect(diagnostics).toEqual([{
      kind: 'note',
      path: 'widgets/release/',
      message: 'widgets/release/ holds WIDGET.yaml, so it is one folder, and steps.yaml in it is one of its files, no longer read on its own.',
    }]);
  });

  it('names a file that only looks like a variant of the marker in that note: en and zh are the only languages', async () => {
    const root = fixture({ 'widgets/release/WIDGET.yaml': 'marker', 'widgets/release/WIDGET.old.yaml': 'an older marker' });

    const { diagnostics } = await Resources.layer(widgets, { root, namespace: null });

    expect(diagnostics).toEqual([{
      kind: 'note',
      path: 'widgets/release/',
      message: 'widgets/release/ holds WIDGET.yaml, so it is one folder, and WIDGET.old.yaml in it is one of its files, no longer read on its own.',
    }]);
  });

  it('lists every definition of the team\'s files, those a namespace that is not active holds included', async () => {
    const tree = treeOf({
      'widgets/release.yaml': 'root release',
      'widgets/payments/release/WIDGET.yaml': 'payments release',
      'widgets/billing/release.yaml': 'billing release',
    }, ['payments']);

    const { definitions, resolutions } = await Resources.survey(widgets, tree);

    expect([
      definitions.map((item) => [item.layer === 'namespace' ? item.namespace : item.layer, item.source.kind, item.source.path]).sort(),
      resolutions.map((resolution) => (resolution.kind === 'resolved' ? resolution.item.source.path : resolution.kind)),
    ]).toEqual([
      [['billing', 'file', 'widgets/billing/release.yaml'], ['payments', 'folder', 'widgets/payments/release/'], ['root', 'file', 'widgets/release.yaml']],
      ['widgets/payments/release/'],
    ]);
  });
});

describe('Resources.list', () => {
  it('gives each name one result: the team\'s in the order the scan meets them, then the names only teamai ships', async () => {
    const tree = treeOf({
      'workflows/build.yaml': 'root build',
      'workflows/release.yaml': 'root release',
      'workflows/payments/deploy.yaml': 'payments deploy',
      'workflows/payments/release.yaml': 'payments release',
      'workflows/billing/deploy.yaml': 'billing deploy',
    }, ['payments', 'billing'], { 'workflows/build.yaml': 'shipped build', 'workflows/teamai-x.yaml': 'shipped x' });

    const found = await Resources.list(RESOURCE_LAYOUTS.workflows, tree);

    expect(found.map((resolution) => (resolution.kind === 'resolved'
      ? [resolution.name, resolution.item.source.path, resolution.replaces?.source.path ?? null]
      : [resolution.name, resolution.kind, resolution.first.source.path, resolution.second.source.path]))).toEqual([
      ['build', 'workflows/build.yaml', 'workflows/build.yaml'],
      ['release', 'workflows/payments/release.yaml', 'workflows/release.yaml'],
      ['deploy', 'conflict', 'workflows/payments/deploy.yaml', 'workflows/billing/deploy.yaml'],
      ['teamai-x', 'workflows/teamai-x.yaml', null],
    ]);
  });
});

describe('Resources.layer', () => {
  it('reads one layer\'s items in scan order, with its diagnostics, and none of another layer\'s', async () => {
    const root = fixture({
      'gadgets/gadgets.yaml': 'lint=root lint\n',
      'gadgets/payments/gadgets.yaml': 'lint=payments lint\n# a payments note\n',
      'gadgets/payments/deploy/GADGET.yaml': 'marker',
      'gadgets/billing/gadgets.yaml': 'lint=billing lint\n',
    });

    expect(await Resources.layer({ ...gadgets, marker: 'GADGET.yaml' }, { root, namespace: 'payments' })).toMatchObject({
      items: [
        { layer: 'namespace', namespace: 'payments', name: 'lint', source: { kind: 'entry', path: 'gadgets/payments/gadgets.yaml', entry: 'payments lint' } },
        { layer: 'namespace', namespace: 'payments', name: 'deploy', source: { kind: 'folder', path: 'gadgets/payments/deploy/' } },
      ],
      diagnostics: [{ kind: 'note', path: 'gadgets/payments/gadgets.yaml', message: 'gadgets/payments/gadgets.yaml:  a payments note' }],
    });
  });

  it('reads no namespace in a directory that holds the marker: it is a folder', async () => {
    const root = fixture({ 'gadgets/payments/GADGET.yaml': 'marker', 'gadgets/payments/gadgets.yaml': 'lint=run lint\n' });

    expect(await Resources.layer({ ...gadgets, marker: 'GADGET.yaml' }, { root, namespace: 'payments' })).toEqual({ items: [], diagnostics: [] });
  });
});

/** A type of this test only whose names are paths, as rules' are: every `.md` at any depth, or a folder holding `NOTE.md`. */
const notes: PlainLayout = { dir: 'notes', marker: 'NOTE.md', fileName: (file) => (file.endsWith('.md') ? file.slice(0, -'.md'.length) : null) };

describe('Resources.walk', () => {
  it('names each file and folder by its path at any depth, and reads a folder\'s files as its own, not as items', async () => {
    const root = fixture({
      'notes/style.md': 'root file',
      'notes/fe/api.md': 'namespace file',
      'notes/fe/deep/naming.md': 'deeper file',
      'notes/review/NOTE.md': 'root folder',
      'notes/review/checklist.md': 'support',
      'notes/fe/forms/NOTE.md': 'namespace folder',
      'notes/fe/forms/examples/good.md': 'support',
      'notes/notes.txt': 'not an item',
    });

    const { items } = await Resources.walk(notes, root);

    expect(items.map(({ name, source }) => [name, source.kind, source.path])).toEqual([
      ['fe/api', 'file', 'notes/fe/api.md'],
      ['fe/deep/naming', 'file', 'notes/fe/deep/naming.md'],
      ['fe/forms', 'folder', 'notes/fe/forms/'],
      ['review', 'folder', 'notes/review/'],
      ['style', 'file', 'notes/style.md'],
    ]);
  });

  it('gives a file and a folder of one name as a duplicate, and neither as an item', async () => {
    const root = fixture({ 'notes/fe/style.md': 'file', 'notes/fe/style/NOTE.md': 'folder', 'notes/other.md': 'other' });

    const walked = await Resources.walk(notes, root);

    expect([walked.items.map(({ name }) => name), walked.duplicates.map(({ name, first, second }) => [name, first.source.path, second.source.path])]).toEqual([
      ['other'],
      [['fe/style', 'notes/fe/style.md', 'notes/fe/style/']],
    ]);
  });

  it('names a folder that is a symlink, at any depth, and gives no item for it', async () => {
    const shared = fixture({ 'NOTE.md': 'shared' });
    const root = fixture({ 'notes/fe/api.md': 'namespace file' });
    fs.symlinkSync(shared, path.join(root, 'notes', 'fe', 'forms'), 'dir');

    const walked = await Resources.walk(notes, root);

    expect([walked.items.map(({ name }) => name), walked.diagnostics]).toEqual([['fe/api'], [{
      kind: 'invalid',
      path: 'notes/fe/forms/',
      message: 'notes/fe/forms/ is a symlink, and a folder holds its own files, never a link, so nothing is read from it. Put the directory itself in the team repo.',
    }]]);
  });

  it('notes a folder that holds files its type reads, but not the marker\'s language variants, which are its own text', async () => {
    const root = fixture({ 'notes/payments/NOTE.md': 'marker', 'notes/payments/NOTE.zh.md': 'variant', 'notes/payments/refunds.md': 'was a note' });

    expect((await Resources.walk(notes, root)).diagnostics).toEqual([{
      kind: 'note',
      path: 'notes/payments/',
      message: 'notes/payments/ holds NOTE.md, so it is one folder, and refunds.md in it is one of its files, no longer read on its own.',
    }]);
  });
});

describe('Resources.list over a tree without namespaces', () => {
  it('never asks for the active namespaces, so a root-only team tree reads no manifest', async () => {
    let asked = 0;
    const root = fixture({ 'workflows/build.yaml': 'build', 'workflows/payments/notes.md': 'not a workflow' });

    const found = await Resources.list(RESOURCE_LAYOUTS.workflows, { team: { root, namespaces: async () => { asked += 1; return []; } } });

    expect([found.map(({ name }) => name), asked]).toEqual([['build'], 0]);
  });
});

describe('RESOURCE_LAYOUTS', () => {
  it('declares only markers src/folder-markers.ts reserves for the same directory, so an older release skips those folders', () => {
    const marked = Object.values(RESOURCE_LAYOUTS).filter((layout) => layout.marker !== null);
    const reserved = (layout: ResourceLayout): boolean => Object.entries(FOLDER_MARKERS).some(([dir, { marker }]) => dir === layout.dir && marker === layout.marker);

    expect(marked.length).toBeGreaterThan(0);
    expect(marked.filter((layout) => !reserved(layout)).map(({ dir, marker }) => `${dir}: ${marker}`)).toEqual([]);
  });
});
