import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompts: string[] = [];
let answers: string[] = [];

vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: (prompt: string, cb: (answer: string) => void) => {
        prompts.push(prompt);
        cb(answers.shift() ?? 's');
      },
      close: () => undefined,
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), dim: vi.fn() },
}));

import { interactiveReview, pushAccepted } from '../import-local.js';
import { log } from '../utils/logger.js';
import { readDocument } from '../documents/okf.js';
import type { ClassifiedItem, ImportSession } from '../types.js';

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const item: ClassifiedItem = {
  sourcePath: '/tmp/notes/k8s.md',
  rawContent: '# K8s',
  type: 'learning',
  title: 'K8s pod startup',
  summary: 'Pods time out on startup',
  tags: ['k8s'],
  confidence: 0.9,
  isPersonal: false,
};

describe('import review output', () => {
  let tmpDir: string;
  let written: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    prompts.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-import-review-'));
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints the review card, the edit prompt and the invalid-choice hint in English', async () => {
    answers = ['x', 'e', 'Pod startup timeout'];

    const session = await interactiveReview([item], { sessionPath: path.join(tmpDir, 'session.json') });

    const output = written.join('');
    expect(output).toContain('  Path: /tmp/notes/k8s.md\n');
    expect(output).toContain('  Summary: Pods time out on startup\n');
    expect(output).toContain('  Enter A (accept), E (edit) or S (skip)\n');
    expect(prompts).toContain('  New title: ');
    expect(output + prompts.join('')).not.toMatch(CJK);
    expect(session.items[0]?.learningDraft?.title).toBe('Pod startup timeout');
  });

  it('reports written and failed files in English', async () => {
    const session: ImportSession = {
      id: '1',
      createdAt: new Date().toISOString(),
      mode: 'local',
      progress: 1,
      items: [{ id: 'item-0', sourcePath: item.sourcePath, status: 'accepted', learningDraft: { title: 'Pod startup', content: '---\ntype: learning\n---\n# Pod startup\n' } }],
    };

    const ok = await pushAccepted(session, tmpDir, {});
    expect(ok).toEqual({ pushed: 1, skipped: 0 });
    const learned = fs.readdirSync(path.join(tmpDir, 'learnings'))[0]!;
    expect(readDocument(fs.readFileSync(path.join(tmpDir, 'learnings', learned), 'utf8')).diagnostics).toEqual([]);
    const infoCalls = vi.mocked(log.info).mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((msg) => msg.startsWith(`Wrote: ${path.join(tmpDir, 'learnings')}`))).toBe(true);

    // A file where the learnings directory should be makes the write fail.
    const blockedRepo = path.join(tmpDir, 'blocked');
    fs.mkdirSync(blockedRepo);
    fs.writeFileSync(path.join(blockedRepo, 'learnings'), 'not a directory');
    const failed = await pushAccepted(session, blockedRepo, {});
    expect(failed).toEqual({ pushed: 0, skipped: 1 });
    const errorCalls = vi.mocked(log.error).mock.calls.map(([msg]) => String(msg));
    expect(errorCalls.some((msg) => msg.startsWith(`Failed to write [${path.join(blockedRepo, 'learnings')}`))).toBe(true);
    expect([...infoCalls, ...errorCalls].join('\n')).not.toMatch(CJK);
  });
});
