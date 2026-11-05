import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
// oxlint-disable-next-line teamai/workflow-boundaries -- tests the child brief unit the skill driver writes
import { readChildResult, writeChildBrief } from '../workflow/drivers/skill/child-brief.js';
import { reportLiteral } from '../workflow/drivers/skill/literals.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const run = RunIdSchema.parse('r1730173017301730');
const attempt = AttemptIdSchema.parse('a17301730');

async function brief(changes: 'commit' | 'keep' | 'none' | 'confined'): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-child-brief-'));
  roots.push(root);
  const config: LocalConfig = {
    repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
  };
  const file = await writeChildBrief({
    config, run, attempt, step: 'fix', dir: path.join(root, 'place'), changes, prompt: 'Fix the bug.',
    by: 'child', report: reportLiteral('teamai', run, attempt), secrets: {},
  });

  return fs.readFileSync(file, 'utf8');
}

describe('a child brief', () => {
  it('asks a committing step for the paths it changed, with an example on both results', async () => {
    const text = await brief('commit');

    expect(text).toContain('{"kind":"output","output":...,"changed":["src/app.ts","src/legacy.ts"]}');
    expect(text).toContain('{"kind":"failure","failure":{"code":"blocked","message":"..."},"changed":["src/app.ts"]}');
  });

  it.each(['keep', 'none', 'confined'] as const)('does not ask a %s step to list paths', async (changes) => {
    expect(await brief(changes)).not.toContain('"changed"');
  });
});

describe('a child result', () => {
  async function result(body: unknown): Promise<Awaited<ReturnType<typeof readChildResult>>> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-child-result-'));
    roots.push(root);
    const config: LocalConfig = {
      repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' },
      username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
    };
    const file = path.join(root, 'data', 'workflows', 'runs', run, 'attempts', attempt, 'result.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body));

    return readChildResult({ config, run, attempt });
  }

  it('reports no paths when the child omits changed', async () => {
    expect(await result({ kind: 'output', output: 'Fixed it.' })).toEqual({ kind: 'output', output: 'Fixed it.', changed: [] });
    expect(await result({ kind: 'failure', failure: { code: 'blocked', message: 'no' } })).toEqual({
      kind: 'failure', failure: { code: 'blocked', message: 'no' }, changed: [],
    });
  });

  it('keeps relative paths, strips a leading ./, and drops absolute paths and paths that climb out', async () => {
    const read = await result({
      kind: 'output',
      output: 'Fixed it.',
      changed: ['./src/app.ts', '/etc/passwd', 'src/../secret', 'note.md', 'src/foo..bar', '../outside'],
    });

    expect(read).toEqual({ kind: 'output', output: 'Fixed it.', changed: ['src/app.ts', 'note.md', 'src/foo..bar'] });
  });
});
