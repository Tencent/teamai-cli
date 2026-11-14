import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent } from '@teamai/tool-testing/fake-agent';
import { family } from '../index.js';
import { codexFake } from './index.js';
import { entriesUnder } from '@teamai/shared/entries-under';

const { call, step } = family.launch.codex;
const made: string[] = [];

afterEach(async () => {
  const left = await leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

/** A scratch folder outside any git repository (`root`, where a call runs) and a repository in it (`repo`, a step's). */
function scratch(): { root: string; repo: string; home: string; bin: string; codexHome: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')));
  const repo = path.join(root, 'repo');

  made.push(root);
  execFileSync('git', ['init', '-q', repo]);

  return { root, repo, home: path.join(root, 'h'), bin: path.join(root, 'b'), codexHome: path.join(root, 'c') };
}

const stepArgs = (prompt: string, resume?: string): string[] => step.args({ prompt, resultDir: '/r', streamsUsage: true, ...(resume && { resume }) }, { interactive: false, opencodeMajor: 2 });

/** The thread a `codex exec --json` run started, from its first event. */
const threadOf = (stdout: string): string => {
  const first: unknown = JSON.parse(stdout.split('\n')[0] ?? '');

  return first !== null && typeof first === 'object' && 'thread_id' in first && typeof first.thread_id === 'string' ? first.thread_id : '';
};

/** Every rollout under `<CODEX_HOME>/sessions`, relative to it. */
const rollouts = (codexHome: string): string[] => {
  const sessions = path.join(codexHome, 'sessions');

  return fs.existsSync(sessions) ? entriesUnder(sessions).map(({ relative }) => relative).filter((name) => name.endsWith('.jsonl')) : [];
};

const readSession = (codexHome: string, sessionId: string, projectPath: string) =>
  new CodexAdapter('codex', path.join(codexHome, 'sessions'), { processes: HOST_PROCESSES, executablesOf: (tool) => [tool], homeEnvAt: (_tool, dir) => ({ CODEX_HOME: dir }) }).readSession({ sessionId, projectPath });

describe('fake codex', () => {
  it('answers a call in the recorded format, which the Codex call profile reads as the answer it was given', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin, answer: 'It uses Jest.' });
    const lastMessageFile = path.join(root, 'last-message.txt');

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile, opencodeMajor: 1 }), 'Which test runner?', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    // codex-cli 0.167.0 printed input_tokens 42861 and output_tokens 196 for this turn.
    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: fs.readFileSync(lastMessageFile, 'utf8') }) })
      .toMatchObject({ code: 0, read: { ok: true, text: 'It uses Jest.', tokens: { input: 42861, output: 196 } } });
  });

  it('fails as the recorded failure, which the profile reads as a failure, and keeps a session with no answer', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const lastMessageFile = path.join(root, 'last-message.txt');

    const out = await runFakeAgent(agent.executable, call.args({ prompt: '', promptFile: '', lastMessageFile, opencodeMajor: 1 }), `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });
    const session = await readSession(codexHome, threadOf(out.stdout), root);

    // codex-cli 0.167.0, given a model it has no provider for, exited 1, wrote no -o file and kept the session.
    expect({ code: out.code, read: call.read({ stdout: out.stdout, lastMessage: undefined }), wrote: fs.existsSync(lastMessageFile), roles: session.messages.map((message) => message.role) })
      .toMatchObject({ code: 1, read: { ok: false, message: expect.stringContaining('gpt-nonexistent') }, wrote: false, roles: ['user'] });
  });

  it('refuses a step outside a git repository, as Codex does without --skip-git-repo-check', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    const out = await runFakeAgent(agent.executable, stepArgs('Review it.'), '', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    expect({ code: out.code, stdout: out.stdout, sessions: rollouts(codexHome) }).toEqual({ code: 1, stdout: '', sessions: [] });
  });

  it('prints its thread first, and only that when it hangs', async () => {
    const { repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin, always: ['hang'] });

    const out = await runFakeAgent(agent.executable, stepArgs('Go.'), '', { cwd: repo, env: { HOME: home, CODEX_HOME: codexHome }, stopAfterOutputMs: 800 });

    expect(out.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ type: 'thread.started', thread_id: expect.any(String) }]);
  });

  it('keeps a step\'s session where Codex does, under CODEX_HOME by the day it started, for the Codex reader', async () => {
    const { repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    const out = await runFakeAgent(agent.executable, stepArgs('Review it.'), '', { cwd: repo, env: { HOME: home, CODEX_HOME: codexHome } });
    const thread = threadOf(out.stdout);

    // codex-cli 0.167.0 wrote sessions/2026/11/11/rollout-2026-11-11T07-43-39-<thread>.jsonl for a run it started then.
    expect(rollouts(codexHome)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}/\\d{2}/\\d{2}/rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${thread}\\.jsonl$`))]);
    const session = await readSession(codexHome, thread, repo);
    expect({ code: out.code, id: session.sessionId, cwd: session.cwd }).toEqual({ code: 0, id: thread, cwd: repo });
  });

  it('continues the thread it is given to resume, in that thread\'s session', async () => {
    const { repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const env = { HOME: home, CODEX_HOME: codexHome };
    const first = await runFakeAgent(agent.executable, stepArgs('Review it.'), '', { cwd: repo, env });

    const resumed = await runFakeAgent(agent.executable, stepArgs('Now fix it.', threadOf(first.stdout)), '', { cwd: repo, env });

    expect({ thread: threadOf(resumed.stdout), sessions: rollouts(codexHome).length }).toEqual({ thread: threadOf(first.stdout), sessions: 1 });
  });

  it('refuses to resume a thread that has no session under its CODEX_HOME, as Codex does', async () => {
    const { repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    const out = await runFakeAgent(agent.executable, stepArgs('Now fix it.', '01a1c999-0000-7000-8000-000000000000'), '', { cwd: repo, env: { HOME: home, CODEX_HOME: codexHome } });

    expect({ code: out.code, stdout: out.stdout, sessions: rollouts(codexHome) }).toEqual({ code: 1, stdout: '', sessions: [] });
  });

  it('writes the step result it was told to into the directory the step argv lets it write, as Codex did', async () => {
    const { root, repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const result = path.join(root, 'attempt', 'out', 'result.json');
    const args = step.args({ prompt: 'Set the output word to done.', resultDir: path.dirname(result), streamsUsage: false }, { interactive: false, opencodeMajor: 2 });

    // TMPDIR elsewhere: Codex lets its sandbox write in the checkout, /tmp, TMPDIR and each --add-dir, and nowhere else.
    const out = await runFakeAgent(agent.executable, args, '', { cwd: repo, env: { HOME: home, CODEX_HOME: codexHome, TMPDIR: path.join(root, 't'), TEAMAI_WORKFLOW_RESULT: result } });

    // codex-cli 0.167.0 wrote this file in the recorded step.
    expect({ code: out.code, result: fs.readFileSync(result, 'utf8') }).toEqual({ code: 0, result: '{"output": {"word": "done"}}\n' });
  });

  it('writes no step result outside the directories its sandbox may write, as Codex did without --add-dir', async () => {
    const { root, repo, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });
    const result = path.join(root, 'attempt', 'out', 'result.json');

    // /tmp and TMPDIR excluded, as codex-cli 0.167.0 takes them: the scratch folder is under /tmp where TMPDIR is unset.
    const excluded = ['-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'];

    const out = await runFakeAgent(agent.executable, ['exec', ...excluded, '--json', 'Set the output word to done.'], '', { cwd: repo, env: { HOME: home, CODEX_HOME: codexHome, TMPDIR: path.join(root, 't'), TEAMAI_WORKFLOW_RESULT: result } });

    expect({ code: out.code, wrote: fs.existsSync(result) }).toEqual({ code: 0, wrote: false });
  });

  it('writes nothing under CODEX_HOME for an ephemeral run, as Codex does', async () => {
    const { root, home, bin, codexHome } = scratch();
    const agent = fakeAgent(codexFake, { bin });

    await runFakeAgent(agent.executable, ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '-'], 'Judge it.', { cwd: root, env: { HOME: home, CODEX_HOME: codexHome } });

    expect(rollouts(codexHome)).toEqual([]);
  });
});
