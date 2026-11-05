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

vi.mock('../providers/github/mr-fetch.js', () => ({
  fetchGitHubPR: vi.fn(async (url: string) => ({ title: 'Retry budget', description: '', commits: [], diff: '', url })),
}));
vi.mock('../tool-launch/call.js', () => ({
  callTool: vi.fn(async () => ({ text: `---\ntitle: Retry budget\n---\n${DRAFT_BODY}\n`, tool: 'claude' })),
}));
const { question } = vi.hoisted(() => ({ question: vi.fn(async (_prompt: string) => 'n') }));
vi.mock('node:readline/promises', () => ({
  default: { createInterface: vi.fn(() => ({ question, close: vi.fn() })) },
}));

import { importFromMR, parseLearningDraft } from '../import-mr.js';
import { log, setSilent } from '../utils/logger.js';
import { callTool } from '../tool-launch/call.js';

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

describe('importFromMR AI draft metadata', () => {
  let root: string;
  const url = 'https://github.com/o/r/pull/1';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-mr-metadata-'));
    vi.mocked(log.info).mockClear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { tags: 'agent', displayed: undefined },
    { tags: 42, displayed: undefined },
    { tags: { topic: 'agent' }, displayed: undefined },
    { tags: ['agent', null, 42, { topic: 'retry' }, ['nested'], 'retry'], displayed: 'agent, retry' },
    { tags: ['agent', 'retry'], displayed: 'agent, retry' },
  ])('saves the original draft when tags are $tags', async ({ tags, displayed }) => {
    const content = `---\ntitle: Retry budget\ntags: ${JSON.stringify(tags)}\n---\n${DRAFT_BODY}\n`;
    vi.mocked(callTool).mockResolvedValueOnce({ text: content, tool: 'claude' });

    const result = await importFromMR({ url, all: true, learningsDirs: [], outputDir: root });

    expect(result.learning).toEqual({ title: 'Retry budget', content });
    expect(result.learningFile).toBe(path.join(root, 'learning.md'));
    expect(fs.readFileSync(result.learningFile!, 'utf8')).toBe(content);
    expect(vi.mocked(log.info).mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith('   Tags:')))
      .toEqual(displayed ? [`   Tags: ${displayed}`] : []);
  });

  it.each([{ title: 42 }, { title: true }, { title: { text: 'Retry budget' } }, { title: ['Retry budget'] }])(
    'uses the MR title to queue a draft with a non-string title $title', async ({ title }) => {
      const content = `---\ntitle: ${JSON.stringify(title)}\ntags: [agent]\n---\n${DRAFT_BODY}\n`;
      vi.mocked(callTool).mockResolvedValueOnce({ text: content, tool: 'claude' });
      const queueLearning = vi.fn(async (filename: string) => path.join(root, filename));

      const result = await importFromMR({ url, all: true, learningsDirs: [], queueLearning });

      expect(result.learning).toEqual({ title: 'Retry budget', content });
      expect(queueLearning).toHaveBeenCalledWith(expect.stringMatching(/^retry-budget-.*\.md$/), content);
      expect(result.learningFile).toBe(await queueLearning.mock.results[0].value);
    },
  );
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
});
