import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  setSilent: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

const DRAFT_BODY = 'gateway retry budget exhausted under burst traffic backoff jitter';

/** The team repo `teamai import` runs against, set per test. */
let teamRepo = '';
/** The team's teamai.yaml `language`, set per test (#1187). */
let teamLanguage: 'en' | 'zh' | undefined;
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
    teamConfig: { team: 't', repo: 'r', ...(teamLanguage ? { language: teamLanguage } : {}) },
  })),
}));

vi.mock('../providers/github/mr-fetch.js', () => ({
  fetchGitHubPR: vi.fn(async (url: string) => ({ title: 'Retry budget', description: '', commits: [], diff: '', url })),
}));
vi.mock('../utils/ai-client.js', () => ({
  callClaude: vi.fn(async () => `---\ntitle: Retry budget\n---\n${DRAFT_BODY}\n`),
}));
const { question } = vi.hoisted(() => ({ question: vi.fn(async (_prompt: string) => 'n') }));
vi.mock('node:readline/promises', () => ({
  default: { createInterface: vi.fn(() => ({ question, close: vi.fn() })) },
}));

import { importFromMR, parseLearningDraft } from '../import-mr.js';
import { importCmd } from '../import.js';
import { log, setSilent } from '../utils/logger.js';
import { callClaude } from '../utils/ai-client.js';
import { fetchGitHubPR } from '../providers/github/mr-fetch.js';

describe('parseLearningDraft', () => {
  it('parses well-formed frontmatter', () => {
    const raw = '---\ntitle: "Hello"\ntags: [a, b]\n---\n\n# Body\n';
    const { data, content } = parseLearningDraft(raw);
    expect(data['title']).toBe('Hello');
    expect(data['tags']).toEqual(['a', 'b']);
    expect(content).toContain('# Body');
  });

  it('does not throw on markdown that breaks YAML alias parsing (regression: CI exit 1)', () => {
    // A line starting with '*' is a YAML alias reference and makes js-yaml throw.
    const raw = '---\n\n*说明:本次 MR 是 8 个 GitHub PR 的 squash 同步*\n---\n';
    expect(() => parseLearningDraft(raw)).not.toThrow();
    const { data } = parseLearningDraft(raw);
    expect(data).toEqual({});
  });

  it('strips a wrapping markdown code fence', () => {
    const raw = '```markdown\n---\ntitle: "X"\n---\n\nbody\n```';
    const { data } = parseLearningDraft(raw);
    expect(data['title']).toBe('X');
  });

  it('drops conversational text before the frontmatter', () => {
    const raw = 'Sure, here is the learning:\n\n---\ntitle: "Y"\n---\n\nbody';
    const { data } = parseLearningDraft(raw);
    expect(data['title']).toBe('Y');
  });
});

/**
 * The possible-duplicate notice (#823 item 9): it compares the draft with the
 * learnings recall would find here, the shared root and the active project
 * namespaces, names them before the confirmation, and claims nothing is marked.
 */
describe('importFromMR possible-duplicate notice', () => {
  let root: string;
  const url = 'https://github.com/o/r/pull/1';
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
  const learning = (rel: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `---\ntitle: note\n---\n${DRAFT_BODY}\n`);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-mr-overlap-'));
    vi.mocked(log.warn).mockClear();
    vi.mocked(setSilent).mockClear();
    vi.mocked(readline.createInterface).mockClear();
    question.mockClear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names an overlapping learning of an active namespace before asking, and none of an inactive one', async () => {
    learning('alpha/x.md');
    learning('beta/y.md');

    await importFromMR({ url, learningsDirs: [root], learningsNamespaces: ['alpha'], dryRun: true });

    const notices = warnings().filter((m) => m.includes('Possible duplicate'));
    expect(notices).toEqual([expect.stringContaining(path.join('alpha', 'x.md'))]);
    expect(notices[0]).not.toContain('y.md');
    const noticeOrder = vi.mocked(log.warn).mock.invocationCallOrder[warnings().indexOf(notices[0])];
    expect(noticeOrder).toBeLessThan(vi.mocked(readline.createInterface).mock.invocationCallOrder[0]);
    expect(warnings().join('\n')).not.toMatch(/supersed/i);
  });

  it('shows the notice with --all without asking', async () => {
    learning('shared.md');

    await importFromMR({ url, learningsDirs: [root], all: true, dryRun: true });

    expect(warnings()).toContainEqual(expect.stringMatching(/Possible duplicate.*shared\.md/));
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  /** A team repo declaring projects alpha and beta, each with an overlapping learning; `import` runs with alpha active. */
  const teamWithTwoProjects = (): void => {
    teamRepo = path.join(root, 'team-repo');
    fs.mkdirSync(path.join(teamRepo, 'manifest'), { recursive: true });
    fs.writeFileSync(
      path.join(teamRepo, 'manifest', 'projects.yaml'),
      'version: 1\nprojects:\n  - id: alpha\n    name: Alpha\n    resources:\n      learnings: [alpha]\n'
        + '  - id: beta\n    name: Beta\n    resources:\n      learnings: [beta]\n',
    );
    learning('team-repo/learnings/alpha/x.md');
    learning('team-repo/learnings/beta/y.md');
  };

  it.each([{ all: false }, { all: true }])('reaches the terminal from `teamai import --from-mr` before any prompt, with the active project namespace (all: $all)', async ({ all }) => {
    teamWithTwoProjects();
    const realHome = process.env.HOME;
    process.env.HOME = root;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: url, dryRun: true, all });
    } finally {
      write.mockRestore();
      process.env.HOME = realHome;
    }

    const notices = warnings().filter((m) => m.includes('Possible duplicate'));
    expect(notices).toEqual([`Possible duplicate: this learning overlaps 1 existing learning(s): ${path.join('alpha', 'x.md')}.`]);
    // Said while the logger is live: `import` silences it only for its tasks.
    const noticeOrder = vi.mocked(log.warn).mock.invocationCallOrder[warnings().indexOf(notices[0])];
    expect(noticeOrder).toBeLessThan(vi.mocked(setSilent).mock.invocationCallOrder[0]);
    if (all) expect(question).not.toHaveBeenCalled();
    else expect(noticeOrder).toBeLessThan(question.mock.invocationCallOrder[0]);
  });

  it('asks `Accept learning?` before its task list takes the terminal (#823 item 18)', async () => {
    // In a terminal, listr2 holds back what is written to stdout while a task
    // runs, so a prompt asked inside one never showed.
    teamWithTwoProjects();
    const realHome = process.env.HOME;
    process.env.HOME = root;
    const printed: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    let atPrompt = { silenced: true, printed: 'not asked' };
    question.mockImplementationOnce(async () => {
      atPrompt = { silenced: vi.mocked(setSilent).mock.calls.at(-1)?.[0] === true, printed: printed.join('') };
      return 'n';
    });
    try {
      await importCmd({ fromMr: url, dryRun: true });
    } finally {
      write.mockRestore();
      process.env.HOME = realHome;
    }

    expect(atPrompt).toEqual({ silenced: false, printed: '' });
    // The task list still runs, after the answer.
    expect(printed.join('')).toContain('Publish learning');
  });

  it('still extracts with --dry-run when projects.yaml does not parse, comparing the shared root only', async () => {
    teamRepo = path.join(root, 'team-repo');
    const realHome = process.env.HOME;
    process.env.HOME = root;
    fs.mkdirSync(path.join(teamRepo, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'manifest', 'projects.yaml'), 'projects: [unclosed\n');
    learning('team-repo/learnings/shared.md');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: url, dryRun: true, all: true });
    } finally {
      write.mockRestore();
      process.env.HOME = realHome;
    }

    expect(warnings()).toContainEqual(expect.stringMatching(/duplicate check reads the shared learnings only: Invalid projects manifest YAML/));
    expect(warnings()).toContainEqual(expect.stringMatching(/Possible duplicate.*shared\.md/));
  });
});


describe('teamai import --from-mr <url...> (#1104)', () => {
  let root: string;
  let exitCode: number | string | undefined;
  const urls = ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'];
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
  const infos = (): string[] => vi.mocked(log.info).mock.calls.map(([message]) => String(message));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-mr-many-'));
    teamRepo = path.join(root, 'team-repo');
    fs.mkdirSync(teamRepo, { recursive: true });
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.error).mockClear();
    vi.mocked(callClaude).mockClear();
    vi.mocked(fetchGitHubPR).mockClear();
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('extracts a draft from every URL in one run', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: urls, dryRun: true, all: true });
    } finally {
      write.mockRestore();
    }

    expect(vi.mocked(fetchGitHubPR).mock.calls.map(([url]) => url)).toEqual(urls);
    expect(callClaude).toHaveBeenCalledTimes(2);
    expect(infos()).toContainEqual(`[1/2] ${urls[0]}`);
    expect(infos()).toContainEqual(`[2/2] ${urls[1]}`);
  });

  it('reads the review threads by default and leaves them out with --no-discussions (#1187)', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: [urls[0]], dryRun: true, all: true });
      await importCmd({ fromMr: [urls[0]], dryRun: true, all: true, discussions: false });
    } finally {
      write.mockRestore();
    }

    expect(vi.mocked(fetchGitHubPR).mock.calls.map(([, opts]) => opts))
      .toEqual([{ discussions: true }, { discussions: false }]);
  });

  it('writes the learning in English when teamai.yaml sets language: en (#1187)', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    teamLanguage = 'en';
    try {
      await importCmd({ fromMr: [urls[0]], dryRun: true, all: true });
    } finally {
      teamLanguage = undefined;
      write.mockRestore();
    }

    expect(vi.mocked(callClaude).mock.calls[0][0]).toContain('Write in English');
  });

  it('keeps going when one MR fails, reports it and exits non-zero', async () => {
    vi.mocked(fetchGitHubPR).mockRejectedValueOnce(new Error('MR not found'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: urls, dryRun: true, all: true });
    } finally {
      write.mockRestore();
    }

    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(warnings()).toContainEqual(expect.stringContaining(`${urls[0]}`) && expect.stringContaining('MR not found'));
    expect(infos()).toContainEqual('Import from MR complete: 1 succeeded, 1 failed');
    expect(process.exitCode).toBe(1);
  });

  it('still reports the failure of the only URL as before', async () => {
    vi.mocked(fetchGitHubPR).mockRejectedValueOnce(new Error('MR not found'));
    // mockRestore() forgets the calls, so they are collected here.
    const exits: unknown[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: unknown) => {
      exits.push(code);
    }) as never);
    try {
      await importCmd({ fromMr: [urls[0]!], dryRun: true, all: true });
    } finally {
      exit.mockRestore();
    }

    expect(vi.mocked(log.error).mock.calls.map(([message]) => String(message))).toContainEqual('MR not found');
    expect(exits).toEqual([1]);
    expect(infos()).not.toContainEqual(expect.stringContaining('Import from MR complete'));
  });

  it('writes one draft per URL with --output, which a shared learning.md would overwrite', async () => {
    const out = path.join(root, 'out');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: urls, output: out, all: true });
    } finally {
      write.mockRestore();
    }

    expect(fs.readdirSync(out).sort()).toEqual(['learning-1.md', 'learning-2.md']);
  });

  it('writes learning.md for a single URL, as before', async () => {
    const out = path.join(root, 'out');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await importCmd({ fromMr: urls[0]!, output: out, all: true });
    } finally {
      write.mockRestore();
    }

    expect(fs.readdirSync(out)).toEqual(['learning.md']);
  });
});
