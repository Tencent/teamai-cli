import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { newOpId, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../workflow/requirements.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';
import { homeEnvOf } from '../workflow/runtimes/sources.js';

const started: StepRuntime<DriverCan>[] = [];
let dir: string | undefined;

afterEach(async () => {
  await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// A nested run's worktree is deep: Claude Code cuts a project directory name past 200 characters and adds a hash.
it('keeps its agent\'s Claude session where teamai reads it for a cwd past 200 characters', async () => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-toy-project-')));
  const worktree = path.join(dir, ...Array.from({ length: 5 }, (_, at) => `a-nested-run-directory-of-some-length-${at}`));
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'));
  const home = path.join(dir, 'claude-home');
  expect(worktree.replace(/[^A-Za-z0-9]/g, '-').length).toBeGreaterThan(200);
  const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
  started.push(runtime);
  await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: { output: { ok: true }, transcript: true, home } }, mode: 'unattended' });
  const place = await runtime.open({ op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } }, async () => {});
  if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

  const end = await runtime.prompt({
    op: newOpId(), handle: place.handle, env: {}, unset: [], credentials: {}, cwd: worktree,
    lease: { step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false, prompt: 'Review.', result: path.join(dir, 'out', 'result.json') },
  }, {});

  expect(end).toMatchObject({ kind: 'finished' });
  if (end.kind !== 'finished') return;
  expect(fs.existsSync(path.join(home, 'projects', encodeCwdClaude(worktree), `${end.session.id}.jsonl`))).toBe(true);
});
