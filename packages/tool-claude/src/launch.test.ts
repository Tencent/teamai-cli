import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent } from '@teamai/tool-testing/fake-agent';
import { launch } from './launch.js';
import { claudeFake } from './testing/index.js';

const call = launch.claude.call;
const made: string[] = [];

afterEach(async () => {
  const left = await leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

function scratch(): { root: string; home: string; bin: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')));

  made.push(root);

  return { root, home: path.join(root, 'h'), bin: path.join(root, 'b') };
}

describe('fake claude', () => {
  it('answers in the recorded format, which the Claude call profile reads as the answer it was given', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin, answer: 'It uses Jest.' });

    const out = await runFakeAgent(agent.executable, call.args(), 'Which test runner?', { cwd: root, env: { HOME: home } });

    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: undefined }) }).toMatchObject({ code: 0, read: { ok: true, text: 'It uses Jest.', tokens: { input: 12, output: 3 } } });
  });

  it('fails as the recorded failure, which the profile reads as a failure', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin });

    const out = await runFakeAgent(agent.executable, call.args(), `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd: root, env: { HOME: home } });

    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: undefined }) }).toMatchObject({ code: 1, read: { ok: false, message: expect.stringContaining('claude-nonexistent') } });
  });

  it('streams an init line first, and only that when it hangs', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin, always: ['hang'] });

    const out = await runFakeAgent(agent.executable, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-fixture'], 'Go.', { cwd: root, env: { HOME: home }, stopAfterOutputMs: 800 });

    expect(out.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ type: 'system', subtype: 'init', session_id: expect.any(String), model: 'claude-fixture', cwd: root }]);
  });

  it('keeps its session and a subagent where Claude Code does, even from a cwd over 200 characters', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin, always: ['subagent'] });
    const cwd = path.join(root, 'a'.repeat(120), 'b'.repeat(120));

    fs.mkdirSync(cwd, { recursive: true });
    const out = await runFakeAgent(agent.executable, call.args(), 'Go.', { cwd, env: { HOME: home } });
    const sessionId = String(JSON.parse(out.stdout).session_id);
    const projects = path.join(home, '.claude', 'projects');
    const [project = ''] = fs.readdirSync(projects);

    expect(project).toMatch(/^-.{199}-[0-9a-z]+$/);
    expect(fs.readdirSync(path.join(projects, project)).sort()).toEqual([sessionId, `${sessionId}.jsonl`]);
    expect(fs.readdirSync(path.join(projects, project, sessionId, 'subagents'))).toEqual(['agent-a1.jsonl']);
  });

  it('keeps no session when the call asks for none', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin });

    await runFakeAgent(agent.executable, ['-p', '--no-session-persistence', '--output-format', 'json'], 'Go.', { cwd: root, env: { HOME: home } });

    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('puts a JSON reply in structured_output when the call gives a schema', async () => {
    const { root, home, bin } = scratch();
    const agent = fakeAgent(claudeFake, { bin, answer: '{"verdict":"pass"}' });

    const out = await runFakeAgent(agent.executable, ['-p', '--output-format', 'json', '--json-schema', '{}'], 'Judge.', { cwd: root, env: { HOME: home } });

    expect(JSON.parse(out.stdout)).toMatchObject({ type: 'result', structured_output: { verdict: 'pass' } });
  });
});

describe('the sign-in variables of Claude Code', () => {
  it('name the gateway Claude reads, as a base URL and the token it signs in to it with', () => {
    expect(launch.claude.signIn.gateway).toEqual({ url: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' });
  });
});
