import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), dim: vi.fn() },
}));

import { ImportLearnings } from '../import-local.js';
import { log } from '../utils/logger.js';

const TODAY = new Date().toISOString().slice(0, 10);

/** The classify step's result for a file, as teamai-import-learnings passes it. */
function classified(file: string, type: 'rule' | 'doc' | 'learning', title: string, personal = false) {
  return { item: { path: file, file }, outputs: { type, title, summary: `Summary of ${title}`, tags: ['k8s'], personal } };
}

function reviewed(file: string, choice: 'accept' | 'edit' | 'skip', note: string | null = null) {
  return { item: { item: { path: file, file } }, outputs: { choice, note } };
}

describe('teamai import classify-reply', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the classification the AI tool replied with, in or out of a code fence', () => {
    const reply = '```json\n{"type":"rule","title":"Deploy","summary":"S","tags":["a",1],"confidence":0.9,"isPersonal":false}\n```';

    expect(ImportLearnings.classifyReply({ path: '/r/deploy.md', reply })).toEqual({ type: 'rule', title: 'Deploy', summary: 'S', tags: ['a'], personal: false });
  });

  it('reads a reply that is not JSON as personal, so the file is left out, and says so', () => {
    expect(ImportLearnings.classifyReply({ path: '/r/deploy.md', reply: 'I think it is a rule.' })).toEqual({ type: 'learning', title: 'deploy.md', summary: '', tags: [], personal: true });
    expect(String(vi.mocked(log.warn).mock.calls[0]?.[0])).toMatch(/^AI classification parse failed, using conservative default \(isPersonal=true\): /);
  });
});

describe('teamai import write-learnings', () => {
  let repo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-write-'));
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('writes each accepted item into the directory of its type, with its type in the frontmatter, and leaves out personal ones', async () => {
    const result = await ImportLearnings.writeLearnings({
      classified: JSON.stringify([classified('/r/a.md', 'rule', 'Deploy rule'), classified('/r/b.md', 'doc', 'API guide'), classified('/r/c.md', 'learning', 'Pod startup'), classified('/r/d.md', 'learning', 'Mine', true)]),
      reviewed: '',
      target: repo,
      byType: 'true',
    });

    expect(result).toEqual({
      kept: 3,
      written: [path.join(repo, 'rules', `${TODAY}-deploy-rule.md`), path.join(repo, 'docs', `${TODAY}-api-guide.md`), path.join(repo, 'learnings', `${TODAY}-pod-startup.md`)],
    });
    expect(fs.readFileSync(path.join(repo, 'rules', `${TODAY}-deploy-rule.md`), 'utf8')).toBe(
      ['---', 'title: "Deploy rule"', 'type: rule', 'author: import', `date: ${TODAY}`, 'tags: ["k8s"]', '---', '', 'Summary of Deploy rule', ''].join('\n'),
    );
  });

  it('writes what the review accepted, an edited item under the note as its title, and nothing it skipped', async () => {
    const result = await ImportLearnings.writeLearnings({
      classified: JSON.stringify([classified('/r/a.md', 'rule', 'Deploy rule'), classified('/r/b.md', 'doc', 'API guide'), classified('/r/c.md', 'learning', 'Pod startup')]),
      reviewed: JSON.stringify([reviewed('/r/a.md', 'accept'), reviewed('/r/b.md', 'skip'), reviewed('/r/c.md', 'edit', ' Pod startup timeout ')]),
      target: repo,
      byType: 'true',
    });

    expect(result.written).toEqual([path.join(repo, 'rules', `${TODAY}-deploy-rule.md`), path.join(repo, 'learnings', `${TODAY}-pod-startup-timeout.md`)]);
    expect(fs.readFileSync(path.join(repo, 'learnings', `${TODAY}-pod-startup-timeout.md`), 'utf8')).toContain('title: "Pod startup timeout"\n');
  });

  it('writes a second item of the same title and day under a numbered name, beside a file already there', async () => {
    fs.mkdirSync(path.join(repo, 'rules'));
    fs.writeFileSync(path.join(repo, 'rules', `${TODAY}-deploy-rule.md`), 'imported earlier today');

    const result = await ImportLearnings.writeLearnings({
      classified: JSON.stringify([classified('/r/a.md', 'rule', 'Deploy rule'), classified('/r/b.md', 'rule', 'Deploy rule')]),
      reviewed: '',
      target: repo,
      byType: 'true',
    });

    expect(result.written).toEqual([path.join(repo, 'rules', `${TODAY}-deploy-rule-2.md`), path.join(repo, 'rules', `${TODAY}-deploy-rule-3.md`)]);
    expect(fs.readFileSync(path.join(repo, 'rules', `${TODAY}-deploy-rule.md`), 'utf8')).toBe('imported earlier today');
  });

  it('numbers a second item whose title fills the whole name, rather than looking for a free name forever', async () => {
    const title = 'Always pin the base image digest in every production Dockerfile build';
    const slug = 'always-pin-the-base-image-digest-in-every-production-dockerf';

    const result = await ImportLearnings.writeLearnings({
      classified: JSON.stringify([classified('/r/a.md', 'rule', title), classified('/r/b.md', 'rule', title)]),
      reviewed: '',
      target: repo,
      byType: 'true',
    });

    expect(result.written).toEqual([path.join(repo, 'rules', `${TODAY}-${slug}.md`), path.join(repo, 'rules', `${TODAY}-${slug}-2.md`)]);
  });

  it('says a file it could not write, in English, and goes on', async () => {
    fs.writeFileSync(path.join(repo, 'rules'), 'not a directory');

    const result = await ImportLearnings.writeLearnings({
      classified: JSON.stringify([classified('/r/a.md', 'rule', 'Deploy rule'), classified('/r/c.md', 'learning', 'Pod startup')]),
      reviewed: '',
      target: repo,
      byType: 'true',
    });

    expect(result.written).toEqual([path.join(repo, 'learnings', `${TODAY}-pod-startup.md`)]);
    expect(String(vi.mocked(log.error).mock.calls[0]?.[0])).toMatch(new RegExp(`^Failed to write \\[${path.join(repo, 'rules').replaceAll('/', '\\/')}`));
  });

  it('refuses a classification that is not what the classify step passes', async () => {
    await expect(ImportLearnings.writeLearnings({ classified: '[{"item":{}}]', reviewed: '', target: repo, byType: 'true' }))
      .rejects.toThrow(/^--classified is not what the teamai-import-learnings step passes: /);
  });
});
