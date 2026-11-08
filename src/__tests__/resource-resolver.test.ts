import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { RESOURCE_LAYOUTS, Resources, type ResourceLayout, type ResourceTree } from '../resources/resolver.js';

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
const widgets: ResourceLayout = { dir: 'widgets', marker: 'WIDGET.yaml', fileName: yamlStem };

/** A type of this test only, whose items are entries in `gadgets.yaml`: one `name=value` line each. */
const gadgets: ResourceLayout<string> = {
  dir: 'gadgets',
  marker: null,
  fileName: () => null,
  entryList: {
    file: 'gadgets.yaml',
    entries: (content) => content.split('\n').filter((line) => line.includes('=')).map((line) => ({
      name: line.slice(0, line.indexOf('=')),
      entry: line.slice(line.indexOf('=') + 1),
    })),
  },
};

interface Row {
  readonly case: string;
  readonly layout: ResourceLayout;
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

    expect(await Resources.resolve(gadgets, 'format', tree)).toMatchObject({
      kind: 'resolved',
      item: { layer: 'root', name: 'format', source: { kind: 'entry', path: 'gadgets/gadgets.yaml', index: 1, entry: 'run format' } },
      replaces: null,
    });
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
