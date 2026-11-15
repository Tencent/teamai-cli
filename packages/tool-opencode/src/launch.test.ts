import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent } from '@teamai/tool-testing/fake-agent';
import { launch } from './launch.js';
import { opencodeFake } from './testing/index.js';

const call = launch.opencode.call;
const made: string[] = [];

afterEach(async () => {
  const left = await leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

function scratch(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-')));

  made.push(root);

  return root;
}

describe('fake opencode', () => {
  it('answers in the recorded events, which the OpenCode call profile reads as the answer it was given', async () => {
    const root = scratch();
    const agent = fakeAgent(opencodeFake, { bin: path.join(root, 'b'), answer: 'It uses Jest.' });

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile: '', opencodeMajor: 2 }), 'Which test runner?', { cwd: root });

    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: undefined }) }).toMatchObject({ code: 0, read: { ok: true, text: 'It uses Jest.' } });
  });

  it('fails as the recorded error event, which the profile reads as a failure', async () => {
    const root = scratch();
    const agent = fakeAgent(opencodeFake, { bin: path.join(root, 'b') });

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile: '', opencodeMajor: 2 }), `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd: root });

    expect(call.read({ stdout: out.stdout, lastMessage: undefined })).toEqual({ ok: false, message: 'Model not found: opencode/no-such-model' });
  });

  it('prints its first event and goes silent when it hangs', async () => {
    const root = scratch();
    const agent = fakeAgent(opencodeFake, { bin: path.join(root, 'b'), always: ['hang'] });

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile: '', opencodeMajor: 2 }), 'Go.', { cwd: root, stopAfterOutputMs: 800 });

    expect(out.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ type: 'step_start' })]);
  });
});
