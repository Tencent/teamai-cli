import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Opened, StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { OpId } from '@teamai/runtime-protocol';
import type { WorkflowEnv } from '../env-resolution.js';
import type { SessionArchive } from '../session-flow/archive.js';
import type { LocalConfig } from '../types.js';
import type { DriverCan } from '../workflow/requirements.js';
import { attemptRun } from '../workflow/runtimes/attempt.js';
import { runPromptStep, type StagedLease } from '../workflow/steps/prompt.js';
import { AttemptIdSchema, RunIdSchema, type RunLock } from '../workflow/store.js';
import { soleEntry } from './helpers/runtime-entry.js';

describe('a prompt step on a runtime that picks its tool where it runs the step', () => {
  it('passes the run\'s stop on to an open whose runtime accepted the place and never reports it ready', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-prompt-picked-there-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const cancelled: OpId[] = [];
    let endOpen: ((opened: Opened) => void) | undefined;
    const runtime: StepRuntime<DriverCan> = {
      name: 'fleet',
      init: async () => ({ ok: true, can: {}, launchesAgents: true }),
      // Accepts the place, then reports it ready never; a cancel of the open ends it.
      open: async (_request, onAccepted) => {
        await onAccepted('h-1');

        return new Promise((resolve) => { endOpen = resolve; });
      },
      exec: async () => ({ kind: 'exited', code: 0, stdout: '' }),
      prompt: async () => ({ kind: 'cancelled' }),
      cancel: async (op) => {
        cancelled.push(op);
        endOpen?.({ kind: 'failed', failure: { code: 'cancelled', message: 'The offer was withdrawn before a member claimed it.' } });
      },
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
    const [run, attempt] = [RunIdSchema.parse('r0123abcd'), AttemptIdSchema.parse('a00000001')];
    const controller = new AbortController();
    const teamEnv = { facts: { declared: [], sources: {} }, values: new Map(), secrets: {} } as unknown as WorkflowEnv;
    const lease = { attempt, revision: 1, step: 'review', kind: 'prompt', prompt: 'Review.', cwd: root } as unknown as StagedLease;

    const reporting = runPromptStep({
      config, lock: { run } as RunLock, driver: { kind: 'local', machine: 'here', workspace: root }, lease, archive: {} as SessionArchive, signal: controller.signal, mode: 'unattended', secrets: {},
      onRuntime: { run: attemptRun({ config, run, attempt, runtime, entry: soleEntry(runtime), driver: 'gpu-fleet' }), logins: [], launchesAgents: true, credentials: {}, found: [], teamEnv, isToolPickedThere: true },
    });
    await vi.waitFor(() => { expect(endOpen).toBeDefined(); });
    controller.abort();

    expect(await Promise.race([reporting, new Promise<'still opening'>((resolve) => { setTimeout(() => resolve('still opening'), 5_000); })])).toMatchObject({ attempt, outcome: 'failed' });
    expect(cancelled).toHaveLength(1);
  });
});
