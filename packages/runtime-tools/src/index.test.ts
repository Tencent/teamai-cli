import { describe, expect, it } from 'vitest';
import { newOpId, type PromptRequest } from '@teamai/runtime-protocol/step-runtime';
import { toolsStepRuntime, type StepLauncher } from './index.js';

describe('the tools runtime\'s prompt', () => {
  it('fails a prompt whose launch throws, and keeps it as ended rather than running', async () => {
    const throwing = async (): Promise<never> => { throw new Error('EACCES: permission denied, mkdir \'/work/out\''); };
    const launcher: StepLauncher = { run: throwing, runInteractive: throwing };
    const runtime = toolsStepRuntime({ can: { exec: false, tools: ['claude'] }, launch: { host: { opencodeMajor: throwing, agyGatewayEnv: () => ({}), writeResult: throwing }, stepTool: () => undefined }, launcher });
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);
    const op = newOpId();
    const request: PromptRequest = {
      op, handle: place.handle, env: {}, unset: [], credentials: {}, cwd: '/work',
      lease: { step: 'review', tool: 'claude', permissions: 'approval-required', interactive: false, prompt: 'Review the change.', result: '/work/out/result.json' },
    };

    expect(await runtime.prompt(request, {})).toEqual({ kind: 'failed', failure: { code: 'tool_failed', message: 'The tools runtime could not launch claude: EACCES: permission denied, mkdir \'/work/out\'' } });
    expect(await runtime.reattach(place.handle)).toMatchObject({ kind: 'alive', ops: [{ op, state: 'failed' }] });
    await expect(runtime.cancel(op)).resolves.toBeUndefined();
  });
});
