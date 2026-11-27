import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { claudeFake } from '@teamai/tool-claude/testing';
import { opencodeFake } from '@teamai/tool-opencode/testing';
import { fakeAgent, type FakeAgent, type FakeAgentOptions, type FakeAgentRecording } from '@teamai/tool-testing/fake-agent';
import { createToolCaller } from '../workflow/runtimes/tool-caller.js';

const made: string[] = [];
const agents: FakeAgent[] = [];

afterEach(async () => {
  const left = (await Promise.all(agents.splice(0).map((agent) => agent.stopLeft()))).flat();

  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

/** A fake of `recording` in a fresh dir with its own HOME, and a caller that finds only it. */
function only(recording: FakeAgentRecording, options: Omit<FakeAgentOptions, 'bin'> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-')));

  made.push(root);
  vi.stubEnv('HOME', path.join(root, 'h'));
  const agent = fakeAgent(recording, { bin: path.join(root, 'b'), ...options });

  agents.push(agent);
  const caller = createToolCaller({ resolveTool: (command) => (command === recording.executable ? agent.executable : null), resolveScope: async () => undefined });

  return { root, agent, caller };
}

const Color = z.object({ color: z.string() });

/** A `copilot` that prints only its reply, as `copilot -p <prompt> -s` does. */
const PLAIN_COPILOT: FakeAgentRecording = {
  executable: 'copilot',
  version: '1.0.0',
  data: {},
  script: String.raw`
  await say(reply ?? 'done');
  process.exit(0);
`,
};

/** A `claude` that streams a tool result holding a secret, then ends as Claude does on its turn limit: no reason. */
const CLAUDE_OUT_OF_TURNS: FakeAgentRecording = {
  executable: 'claude',
  version: '2.1.319',
  data: {},
  script: String.raw`
  await say(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }));
  await say(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'API_KEY=hunter2' }] } }));
  await say(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's-1' }));
  process.exit(1);
`,
};

describe('a call that must reply with a value', () => {
  it('asks again in the same session when the reply holds no valid value, and returns the corrected one', async () => {
    const { root, agent, caller } = only(claudeFake, { answers: [{ when: 'Retries remaining', answer: '{"color":"blue"}' }], answer: 'Sure, the color is blue.' });

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 2 });

    expect(called).toMatchObject({ tool: 'claude', reply: { color: 'blue' }, asked: 2 });
    const [first, second] = agent.calls();
    const sessions = fs.readdirSync(path.join(root, 'h', '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-')));

    expect(first?.args).toEqual(['-p', '--output-format', 'json']);
    expect(sessions).toEqual([`${second?.args[4]}.jsonl`]);
    expect(second?.args).toEqual(['-p', '--output-format', 'json', '--resume', expect.any(String)]);
    expect(second?.prompt).toContain('Sure, the color is blue.');
  });

  it('stops asking at the cap and gives no value', async () => {
    const { root, agent, caller } = only(claudeFake, { answer: 'no JSON here' });

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 2 });

    expect({ reply: called.reply, asked: called.asked, calls: agent.calls().length }).toEqual({ reply: undefined, asked: 3, calls: 3 });
  });

  it('keeps the last answer when asking again fails', async () => {
    const { root, caller } = only(claudeFake, { answer: 'no JSON here', before: "if (prompt.includes('Retries remaining')) { process.stderr.write('rate limited'); process.exit(2); }" });

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 2 });

    expect({ reply: called.reply, text: called.text, asked: called.asked }).toEqual({ reply: undefined, text: 'no JSON here', asked: 2 });
  });

  it('asks again only within the time the call was given', async () => {
    const { root, agent, caller } = only(claudeFake, { answer: 'no JSON here', always: ['slow'], slowMs: 700 });
    const started = performance.now();

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 5, timeout: 2000 });

    expect({ reply: called.reply, tooLong: performance.now() - started > 4000, calls: agent.calls().length < 6 }).toEqual({ reply: undefined, tooLong: false, calls: true });
  });

  it('resumes an OpenCode session by its id', async () => {
    const { root, agent, caller } = only(opencodeFake, { answers: [{ when: 'Retries remaining', answer: '{"color":"red"}' }], answer: 'red' });

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 1 });

    expect(called.reply).toEqual({ color: 'red' });
    expect(agent.calls()[1]?.args).toEqual(['run', '--standalone', '--format', 'json', '--session', expect.stringMatching(/^ses_/)]);
  });

  it('asks once when the first reply holds the value', async () => {
    const { root, agent, caller } = only(claudeFake, { answer: 'Here it is:\n```json\n{"color":"green"}\n```' });

    const called = await caller.callForReply('Name one color.', Color, { launchedBy: 'answer', cwd: root, retries: 2 });

    expect({ reply: called.reply, asked: called.asked, calls: agent.calls().length }).toEqual({ reply: { color: 'green' }, asked: 1, calls: 1 });
  });
});

describe('a call with an idle limit', () => {
  it('fails a tool that goes silent for longer than the limit', async () => {
    const { root, caller } = only(opencodeFake, { always: ['hang'] });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 500 })).rejects.toMatchObject({
      kind: 'call_failed',
      message: 'AI call printed nothing for 0.5s, longer than its idle limit (tool: opencode). Raise the idle limit if this tool works silently for longer.',
    });
  });

  it('keeps a tool that streams for longer than the limit but never stays silent that long', async () => {
    const { root, caller } = only(opencodeFake, { always: ['slow'], slowMs: 400, answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 1000 })).resolves.toMatchObject({ text: 'still here' });
  });

  it('asks Claude, which prints its json output only once it ends, for its stream-json output instead, and reads the reply from it', async () => {
    const { root, agent, caller } = only(claudeFake, { always: ['slow'], slowMs: 300, answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 1000 })).resolves.toMatchObject({ text: 'still here' });
    expect(agent.calls()[0]?.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
  });

  it('names how a streamed Claude call ended when it gives no reason, and never quotes the transcript it streamed', async () => {
    const { root, caller } = only(CLAUDE_OUT_OF_TURNS);

    const failure = caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 1000 });

    await expect(failure).rejects.toMatchObject({ kind: 'call_failed', message: 'AI call failed (tool: claude): it ended with error_max_turns' });
    await expect(failure).rejects.not.toThrow('hunter2');
  });

  it('calls Claude for its json output when no idle limit is set', async () => {
    const { root, agent, caller } = only(claudeFake, { answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root })).resolves.toMatchObject({ text: 'still here' });
    expect(agent.calls()[0]?.args).toEqual(['-p', '--output-format', 'json']);
  });

  it('keeps a tool whose call prints only once it ends for as long as it works, as under no limit', async () => {
    // GitHub Copilot's `-p … -s` prints only its reply, once it ends.
    const { root, caller } = only(PLAIN_COPILOT, { always: ['slow'], slowMs: 1500, answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 500 })).resolves.toMatchObject({ text: 'still here' });
  });

  it('keeps a tool under an idle limit longer than a timer can wait, as under no limit', async () => {
    const { root, caller } = only(opencodeFake, { always: ['slow'], slowMs: 50, answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, idleTimeout: 30 * 24 * 60 * 60 * 1000 })).resolves.toMatchObject({ text: 'still here' });
  });
});

describe('a call with a timeout', () => {
  it('keeps a tool under a timeout longer than a timer can wait, as under no timeout', async () => {
    const { root, caller } = only(opencodeFake, { always: ['slow'], slowMs: 50, answer: 'still here' });

    await expect(caller.callTool('Go.', { launchedBy: 'answer', cwd: root, timeout: 30 * 24 * 60 * 60 * 1000 })).resolves.toMatchObject({ text: 'still here' });
  });
});
