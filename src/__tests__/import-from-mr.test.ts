/**
 * The verbs a teamai-import-from-mr run's steps call: fetch-mr reads an MR as the extraction prompt shows it, draft-mr
 * keeps the AI tool's learning and names the learnings it overlaps (#823 item 9), publish-mr writes what the review
 * accepted, and finish-mr sums up a run of several MRs (#1104).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

/** The team repo the verbs' config names, set per test. */
let teamRepo = '';
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(async () => ({
    localConfig: {
      repo: { localPath: teamRepo, remote: 'r', kind: 'git' as const },
      username: 'alice',
      scope: 'user' as const,
      additionalRoles: [],
      projects: ['alpha'],
    },
    teamConfig: { team: 't', repo: 'r' },
  })),
}));

vi.mock('../providers/github/mr-fetch.js', () => ({
  fetchGitHubPR: vi.fn(async (url: string) => ({
    title: 'Retry budget',
    description: 'Caps retries.',
    commits: [{ hash: 'abcdef0123456789', message: 'cap retries' }],
    diff: `+${'x'.repeat(4000)}`,
    url,
    author: 'dev',
    mergedAt: '2026-09-20T10:00:00Z',
  })),
}));

import { ImportFromMr } from '../import-from-mr.js';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';
import { log } from '../utils/logger.js';

const DRAFT_BODY = 'gateway retry budget exhausted under burst traffic backoff jitter';
const URLS = ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'];
const infos = (): string[] => vi.mocked(log.info).mock.calls.map(([message]) => String(message));
const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

let root: string;
let runDir: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-from-mr-')));
  teamRepo = path.join(root, 'team-repo');
  fs.mkdirSync(teamRepo, { recursive: true });
  runDir = process.env.TEAMAI_RUN_DIR;
  process.env.TEAMAI_RUN_DIR = path.join(root, 'run');
  fs.mkdirSync(path.join(root, 'run'));
});

afterEach(() => {
  if (runDir === undefined) delete process.env.TEAMAI_RUN_DIR;
  else process.env.TEAMAI_RUN_DIR = runDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('teamai import fetch-mr', () => {
  it('prints the MR as the extraction prompt shows it, and says which of several MRs it is', async () => {
    const fetched = await ImportFromMr.fetch({ url: URLS[1], mrs: JSON.stringify(URLS), threads: 'true' });

    expect(fetched).toEqual({
      url: URLS[1],
      title: 'Retry budget',
      description: 'Caps retries.',
      commits: '- abcdef01: cap retries',
      diff: `+${'x'.repeat(2999)}`,
      threads: '',
      thread_count: 0,
      author: 'dev',
      date: '2026-09-20',
    });
    expect(infos()).toEqual([`[2/2] ${URLS[1]}`]);
  });

  it('reads the review threads unless --threads is false (#1187)', async () => {
    await ImportFromMr.fetch({ url: URLS[0], mrs: JSON.stringify([URLS[0]]), threads: 'true' });
    await ImportFromMr.fetch({ url: URLS[0], mrs: JSON.stringify([URLS[0]]), threads: 'false' });

    expect(vi.mocked(fetchGitHubPR).mock.calls.map(([, opts]) => opts)).toEqual([{ discussions: true }, { discussions: false }]);
    expect(infos()).toEqual([]);
  });
});

describe('teamai import draft-mr', () => {
  const learning = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(teamRepo, 'learnings', rel)), { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'learnings', rel), `---\ntitle: note\n---\n${DRAFT_BODY}\n`);
  };

  /** The team declares projects alpha and beta, each with a learning the draft overlaps; alpha is active. */
  const twoProjects = (manifest = 'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n'
    + '  - id: beta\n    name: Beta\n    resources:\n      learnings: [beta]\n'): void => {
    fs.mkdirSync(path.join(teamRepo, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'manifest', 'projects.yaml'), manifest);
    learning('alpha/x.md');
    learning('beta/y.md');
  };

  it('keeps the learning in the run directory, titled by its frontmatter, and says it with its tags', async () => {
    const reply = '```markdown\n---\ntitle: Retry budget per route\ntags: [retry, gateway]\n---\nBody\n```';

    const drafted = await ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply });

    expect(drafted).toEqual({ title: 'Retry budget per route', file: expect.stringMatching(/\/run\/mr-[^/]+\/learning\.md$/), tags: ['retry', 'gateway'], overlaps: [], repo_url: 'https://github.com/o/r.git' });
    expect(fs.readFileSync(drafted.file, 'utf8')).toBe('---\ntitle: Retry budget per route\ntags: [retry, gateway]\n---\nBody');
    expect(infos()).toEqual(['✅ Learning draft generated: Retry budget per route', '   Tags: retry, gateway']);
  });

  it('takes the MR title when the frontmatter has none', async () => {
    expect((await ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply: 'just prose' })).title).toBe('Retry budget');
  });

  it.each([
    { tags: 'agent', said: [] },
    { tags: 42, said: [] },
    { tags: { topic: 'agent' }, said: [] },
    { tags: ['agent', null, 42, { topic: 'retry' }, ['nested'], 'retry'], said: ['agent', 'retry'] },
  ])('keeps the draft as written and says only its string tags when they are $tags', async ({ tags, said }) => {
    const reply = `---\ntitle: Retry budget\ntags: ${JSON.stringify(tags)}\n---\nBody`;

    const drafted = await ImportFromMr.draft({ url: URLS[0], title: 'MR title', reply });

    expect(drafted).toMatchObject({ title: 'Retry budget', tags: said });
    expect(fs.readFileSync(drafted.file, 'utf8')).toBe(reply);
  });

  it.each([{ title: 42 }, { title: true }, { title: { text: 'x' } }, { title: ['x'] }])('takes the MR title when the frontmatter title is $title', async ({ title }) => {
    expect((await ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply: `---\ntitle: ${JSON.stringify(title)}\n---\nBody` })).title).toBe('Retry budget');
  });

  it('names an overlapping learning of the active project namespace, and none of another', async () => {
    twoProjects();

    const drafted = await ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply: `---\ntitle: Retry\n---\n${DRAFT_BODY}\n` });

    expect(drafted.overlaps).toEqual([path.join('alpha', 'x.md')]);
    expect(warnings()).toEqual([`Possible duplicate: this learning overlaps 1 existing learning(s): ${path.join('alpha', 'x.md')}.`]);
  });

  it('compares the shared root only when projects.yaml does not parse, and says so', async () => {
    twoProjects('projects: [unclosed\n');
    learning('shared.md');

    const drafted = await ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply: `---\ntitle: Retry\n---\n${DRAFT_BODY}\n` });

    expect(drafted.overlaps).toEqual(['shared.md']);
    expect(warnings()[0]).toMatch(/^The duplicate check reads the shared learnings only: Invalid projects manifest YAML/);
  });

  it('refuses an empty reply, so the step fails input_rejected', async () => {
    await expect(ImportFromMr.draft({ url: URLS[0], title: 'Retry budget', reply: ' ' })).rejects.toThrow(`--reply is empty: the AI tool wrote no learning for ${URLS[0]}.`);
  });
});

/** The extract step's results for `urls`, a draft file each, with `failed` ones failed. */
function extracted(urls: readonly string[], failed: readonly string[] = []): string {
  return JSON.stringify(urls.map((url, index) => {
    if (failed.includes(url)) return { item: url, outcome: 'failed', outputs: { title: null, file: null, tags: null, overlaps: null, repo_url: null } };
    const file = path.join(root, 'run', `draft-${index}.md`);
    fs.writeFileSync(file, `---\ntitle: "Lesson ${index + 1}"\ndate: 2026-09-20\n---\n\nBody ${index + 1}\n`);

    return { item: url, outcome: 'success', outputs: { title: `Lesson ${index + 1}`, file, tags: [], overlaps: [], repo_url: '' } };
  }));
}

function reviewed(answers: ReadonlyArray<[string, 'accept' | 'edit' | 'skip', string | null]>): string {
  return JSON.stringify(answers.map(([url, choice, note]) => ({ item: { item: url }, outputs: { choice, note } })));
}

describe('teamai import publish-mr --drafts true', () => {
  it('writes one learning-<n>.md per MR of several, which a shared learning.md would overwrite', async () => {
    const out = path.join(root, 'out');

    const result = await ImportFromMr.publish({ extracted: extracted(URLS), reviewed: '', target: out, drafts: 'true' });

    expect(result.published).toEqual([path.join(out, 'learning-1.md'), path.join(out, 'learning-2.md')]);
    expect(fs.readFileSync(path.join(out, 'learning-2.md'), 'utf8')).toBe('---\ntitle: "Lesson 2"\ndate: 2026-09-20\n---\n\nBody 2\n');
    expect(infos()).toEqual([`Learning written: ${path.join(out, 'learning-1.md')}`, `Learning written: ${path.join(out, 'learning-2.md')}`]);
  });

  it('writes learning.md for a single MR', async () => {
    const out = path.join(root, 'out');

    await ImportFromMr.publish({ extracted: extracted([URLS[0]]), reviewed: '', target: out, drafts: 'true' });

    expect(fs.readdirSync(out)).toEqual(['learning.md']);
  });

  it('writes what the review accepted, an edited draft under the note as its title, and nothing it skipped or that failed', async () => {
    const out = path.join(root, 'out');
    const three = [...URLS, 'https://github.com/o/r/pull/3'];

    const result = await ImportFromMr.publish({
      extracted: extracted(three, [URLS[1]]),
      reviewed: reviewed([[URLS[0], 'skip', null], [three[2], 'edit', ' Cap gateway retries ']]),
      target: out,
      drafts: 'true',
    });

    expect(result.published).toEqual([path.join(out, 'learning-3.md')]);
    expect(fs.readFileSync(path.join(out, 'learning-3.md'), 'utf8')).toBe('---\ntitle: "Cap gateway retries"\ndate: 2026-09-20\n---\n\nBody 3\n');
  });

  it('refuses extract results that are not what the step passes', async () => {
    await expect(ImportFromMr.publish({ extracted: '[{"item":1}]', reviewed: '', target: root, drafts: 'true' }))
      .rejects.toThrow(/^--extracted is not what the teamai-import-from-mr step passes: /);
  });
});

describe('teamai import finish-mr', () => {
  it('sums up several MRs, names the one that failed, exits 1, and passes on each draft', () => {
    const ended = ImportFromMr.finish({ extracted: extracted(URLS, [URLS[0]]) });

    expect(ended).toEqual({ text: '', exit_code: 1, learnings: [{ url: URLS[1], title: 'Lesson 2', file: path.join(root, 'run', 'draft-1.md'), repo_url: '' }] });
    expect(infos()).toEqual(['Import from MR complete: 1 succeeded, 1 failed', `  failed: ${URLS[0]}`]);
  });

  it('says nothing for a single MR, and exits 1 when it failed', () => {
    expect(ImportFromMr.finish({ extracted: extracted([URLS[0]], [URLS[0]]) }).exit_code).toBe(1);
    expect(ImportFromMr.finish({ extracted: extracted([URLS[0]]) }).exit_code).toBe(0);
    expect(infos()).toEqual([]);
  });
});
