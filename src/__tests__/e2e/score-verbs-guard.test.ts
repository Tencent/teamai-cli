/**
 * Real CLI: the score verbs a teamai-score run's steps call write nothing when an agent calls them from its own shell,
 * with no attempt marker or with one it made up.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

let root = '';
let home = '';
let dir = '';

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-guard-')));
  home = path.join(root, 'home');
  dir = path.join(root, 'evidence');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({ entries: [] }));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function cli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const { CLAUDE_CODE_SESSION_ID: _session, TEAMAI_WORKFLOW_ATTEMPT: _attempt, TEAMAI_RUN_DIR: _dir, ...inherited } = process.env;
  const ran = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...inherited, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...env }, encoding: 'utf8' });

  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe('teamai score label and write outside a teamai-score attempt', () => {
  it.each([
    ['no attempt marker', {}, 'TEAMAI_WORKFLOW_ATTEMPT and TEAMAI_RUN_DIR name no workflow attempt'],
    ['a made-up attempt marker', { TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a01234567', TEAMAI_RUN_DIR: path.join(os.tmpdir(), 'made-up') }, 'run r0123456789abcdef is not on this machine'],
  ])('refuse with %s and write no label', (_case, env, why) => {
    for (const args of [['score', 'label', '--evidence', dir, '--answer', '{"label":"good","reasoning":"x"}', '--judge', 'success'], ['score', 'write', '--evidence', dir]]) {
      const { status, stdout, stderr } = cli(args, env);

      expect(status).toBe(1);
      expect(JSON.parse(stdout)).toEqual({ error: { code: 'score_attempt_required', message: expect.stringContaining(why) } });
      // A failed step keeps its command's stderr, so the run that called the verb says why it refused.
      expect(stderr).toContain(`score_attempt_required: `);
      expect(stderr).toContain(why);
    }

    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('teamai score subjects --lapsed where the config does not load', () => {
  it('refuses with why the config could not be read, not as if teamai were not set up', () => {
    const broken = path.join(root, 'broken-home');
    fs.mkdirSync(path.join(broken, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(broken, '.teamai', 'config.yaml'), 'repo: [unclosed\n');

    const { status, stdout } = cli(['score', 'subjects', '--lapsed'], { HOME: broken, USERPROFILE: broken });

    expect(status).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: { code: 'not_initialized', message: expect.stringContaining('could not be read') } });
  });
});
