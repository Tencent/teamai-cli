import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OpIdSchema, type PromptLeaseSchema, type RuntimeMessage } from '@teamai/runtime-protocol';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { agentIdOf } from './conversation.js';
import { restartDaemon, dir, worktree, daemonState, daemon, RUN, ATTEMPT, behave, received, stopped, start, isOp, isEnd, ready, opened, openRequest, createdAgent, agentsOf, delay, until, waitedOn, worktreeWorkspace, promptRequest, useRuntimeSuite } from './testing/suite.js';

describe('the agent id a prompt gets', () => {
  it('is a version 4 UUID that its op alone decides, so a runtime started again finds the same agent', () => {
    const [first, again, other] = ['op-0000000b', 'op-0000000b', 'op-0000000c'].map((op) => agentIdOf(OpIdSchema.parse(op)));

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  it('runs a prompt step as a Paseo agent in teamai\'s worktree, and ends finished with the tool\'s session and the output the agent wrote', async () => {
    behave({ output: { verdict: 'approve', findings: 2 } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b'));

    await runtime.next(isOp('op-0000000b', 'accepted'));
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();
    expect(end).toEqual({ op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` }, result: { output: { verdict: 'approve', findings: 2 } } });
    expect(create).toMatchObject({
      type: 'agent.create.request',
      idempotencyKey: 'op-0000000b',
      // The mode Paseo sets as Claude's default, as the member's own agents start in.
      config: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'auto', cwd: worktree, title: `teamai review · ${RUN}` },
    });
    // `paseo ls --label teamai-run=<run>` lists a run's agents, and `teamai-step` one step's.
    expect(create?.labels).toEqual({ 'teamai-attempt': `${RUN}/${ATTEMPT}`, 'teamai-run': RUN, 'teamai-step': 'review' });
    // The result file's directory and the run's scratch directory, and only they, are allowed without asking.
    expect(create).toMatchObject({ config: { providerOptions: { allowedTools: [`Edit(/${path.join(dir, 'out')}/**)`, `Edit(/${path.join(dir, 'run')}/**)`] } } });
    // Only the run directory's name crosses, so $TEAMAI_RUN_DIR works in the agent's shell: Paseo keeps a create's env in
    // plain text, so nothing of the step's env does.
    expect(create).toHaveProperty('env', { TEAMAI_RUN_DIR: path.join(dir, 'run') });
  });

  it('gives the agent of a step of a workflow folder the folder\'s path too, so its shell finds the files the folder carries', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start();
    await ready(runtime);
    const folder = path.join(dir, 'folders', 'a'.repeat(64));
    const request = promptRequest(await opened(runtime), 'op-0000000b');

    runtime.send({ ...request, env: { ...request.env, TEAMAI_WORKFLOW_DIR: folder } });

    await runtime.next(isEnd('op-0000000b'));
    expect(received()[0]).toHaveProperty('env', { TEAMAI_RUN_DIR: path.join(dir, 'run'), TEAMAI_WORKFLOW_DIR: folder });
  });

  it('labels a step\'s agent with the Paseo agent the run was started from, and opens its prompt with a link to that agent', async () => {
    behave({ output: { verdict: 'approve' } });
    // The agent the member started the run from: one the same daemon runs.
    const first = start();
    await ready(first);
    first.send(promptRequest(await opened(first), 'op-0000000b'));
    await first.next(isEnd('op-0000000b'));
    const parent = agentIdOf(OpIdSchema.parse('op-0000000b'));

    const runtime = start({ PASEO_AGENT_ID: parent });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' }), 'op-0000000d'));
    await runtime.next(isEnd('op-0000000d'));

    const create = received().find((request) => request.type === 'agent.create.request' && request.idempotencyKey === 'op-0000000d');
    // `paseo ls --label teamai-parent=<agent>` lists the agents a run started from that agent made.
    expect(create?.labels).toEqual({ 'teamai-attempt': `${RUN}/a0123abce`, 'teamai-run': RUN, 'teamai-step': 'review', 'teamai-parent': parent });
    expect(String(create?.initialPrompt).split('\n\n')).toEqual([
      `This agent runs step "review" of teamai workflow run ${RUN}, started from the Paseo agent paseo://h/srv_fake0001/agent/${parent}.`,
      'Review the change.',
      `Write the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}. Write {"output": …}.`,
    ]);
  });

  it('names a parent agent its daemon does not know by its id alone, with no link to a server that does not hold it', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start({ PASEO_AGENT_ID: 'agent-on-another-daemon' });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    const [create] = received();
    expect(create?.labels).toMatchObject({ 'teamai-parent': 'agent-on-another-daemon' });
    expect(String(create?.initialPrompt).split('\n\n')[0]).toBe(`This agent runs step "review" of teamai workflow run ${RUN}, started from the Paseo agent agent-on-another-daemon.`);
  });

  it('opens a step\'s prompt with teamai\'s prompt alone, and no parent label, when the run was not started from a Paseo agent', async () => {
    behave({ output: { verdict: 'approve' } });
    const runtime = start({ PASEO_AGENT_ID: undefined });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isEnd('op-0000000b'));

    const [create] = received();
    expect(create?.labels).not.toHaveProperty('teamai-parent');
    expect(String(create?.initialPrompt)).toMatch(/^Review the change\./);
  });

  it('names the Claude home the daemon keeps a step\'s session in, so teamai reads it there though it runs in another HOME', async () => {
    const elsewhere = path.join(dir, 'daemon-user', '.claude');
    behave({ output: { verdict: 'approve' }, claude_home: elsewhere });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'claude', home: elsewhere } });
  });

  it('names the Codex home that holds a step\'s session, found by its thread id, so teamai reads it there though it runs in another HOME, and none when no home it can see holds it', async () => {
    const elsewhere = path.join(dir, 'daemon-user', '.codex');
    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in', codex_home: elsewhere });
    const runtime = start({ CODEX_HOME: elsewhere });
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b', { tool: 'codex', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex', id: `fake-session-${agentIdOf(OpIdSchema.parse('op-0000000b'))}`, home: elsewhere } });

    behave({ output: { verdict: 'approve' }, codex_login: 'signed_in', codex_home: path.join(dir, 'unseen', '.codex') });
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));
    const unseen = await runtime.next(isEnd('op-0000000c'));

    expect(unseen).toMatchObject({ event: 'finished', session: { tool: 'codex' } });
    expect('session' in unseen && unseen.session).not.toHaveProperty('home');
  });

  it('names the data directory of the daemon\'s OpenCode as an OpenCode step\'s session home, so teamai reads it there though it runs in another HOME, and none on a daemon on another host', async () => {
    const elsewhere = path.join(dir, 'daemon-user', 'data');
    behave({ output: { verdict: 'approve' }, opencode_data_home: elsewhere });
    const runtime = start({ XDG_DATA_HOME: elsewhere });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode', home: elsewhere } });

    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const remote = start({ XDG_DATA_HOME: elsewhere });
    await ready(remote, { options: { url: daemon.url.replace('127.0.0.1', '0.0.0.0') } });
    remote.send(promptRequest(await opened(remote, { attempt: 'a0123abce' }), 'op-0000000c', { tool: 'opencode', model: undefined }));
    const unseen = await remote.next(isEnd('op-0000000c'));

    expect(unseen).toMatchObject({ event: 'finished', session: { tool: 'opencode' } });
    expect('session' in unseen && unseen.session).not.toHaveProperty('home');
  });

  // Each tool reports its tokens as its own end-of-run usage counts them: Claude's input leaves the cache out, Codex's
  // counts cached input inside it.
  it.each([
    { tool: 'claude', home: 'claude_home', env: {}, usage: { input: 1_200, output: 340, cachedInput: 18_000 } },
    { tool: 'codex', home: 'codex_home', env: { codex_login: 'signed_in' }, usage: { input: 19_200, output: 340, cachedInput: 18_000 } },
  ] as const)('reports the tokens the $tool session\'s transcript records for the step', async ({ tool, home, env, usage }) => {
    const elsewhere = path.join(dir, 'daemon-user', `.${tool}`);
    behave({ output: { verdict: 'approve' }, [home]: elsewhere, ...env, usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    const runtime = start({ CODEX_HOME: elsewhere });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool, model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool }, usage });
  });

  it('finishes a step whose session it cannot list, reporting no tokens and why rather than failing the step', async () => {
    const home = path.join(dir, 'daemon-user', '.claude');
    // Claude can write its transcript there, and teamai cannot list the folder.
    const folder = path.join(home, 'projects', encodeCwdClaude(worktree));
    fs.mkdirSync(folder, { recursive: true });
    fs.chmodSync(folder, 0o300);
    // A daemon that runs Claude alone, whose home it names, so the runtime offers tokens.
    behave({ output: { verdict: 'approve' }, claude_home: home, models: { claude: ['claude-opus-5-5'] }, usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    try {
      const end = await runtime.next(isEnd('op-0000000b'));
      expect(end).toMatchObject({
        event: 'finished', session: { tool: 'claude', home }, result: { output: { verdict: 'approve' } },
        unmeasured: { cause: `teamai cannot list ${folder}, where claude keeps its sessions, because it has no permission to read it.`, next: `Let the user teamai runs as read ${folder}, then retry the step.` },
      });
      expect(end).not.toHaveProperty('usage');
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  it('reports a Codex step\'s tokens past a folder of its store it cannot list', async () => {
    const home = path.join(dir, 'daemon-user', '.codex');
    // A folder another user left in Codex's store, which Codex never lists.
    const foreign = path.join(home, 'sessions', '0000');
    fs.mkdirSync(foreign, { recursive: true });
    fs.chmodSync(foreign, 0o300);
    behave({ output: { verdict: 'approve' }, codex_home: home, codex_login: 'signed_in', usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    const runtime = start({ CODEX_HOME: home });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'codex', model: undefined }));

    try {
      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex', home }, usage: { input: 19_200, output: 340, cachedInput: 18_000 } });
    } finally {
      fs.chmodSync(foreign, 0o700);
    }
  });

  it('reports no tokens from a daemon on another host, whose session home is not on this machine', async () => {
    behave({ output: { verdict: 'approve' }, claude_home: path.join(dir, 'daemon-user', '.claude'), usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    // 0.0.0.0 reaches the fake on this machine, but names no loopback address, as a daemon on another host is named.
    const remote = start();
    await ready(remote, { options: { url: daemon.url.replace('127.0.0.1', '0.0.0.0') } });
    remote.send(promptRequest(await opened(remote), 'op-0000000b'));
    const end = await remote.next(isEnd('op-0000000b'));

    expect(end).toMatchObject({ event: 'finished', session: { tool: 'claude' } });
    // It offers no tokens there, so it owes no reason for reporting none.
    expect(end).not.toHaveProperty('usage');
    expect(end).not.toHaveProperty('unmeasured');
  });

  it('names as an OpenCode step\'s session home the data directory whose store the step wrote, over one that only held a store from before', async () => {
    // teamai's own OpenCode left a store in its data directory before the step; the daemon's OpenCode writes in $HOME's.
    const stale = path.join(dir, 'teamai-data');
    fs.mkdirSync(path.join(stale, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'opencode', 'opencode.db'), '');
    fs.utimesSync(path.join(stale, 'opencode', 'opencode.db'), new Date('2026-01-01'), new Date('2026-01-01'));
    const written = path.join(dir, 'home', '.local', 'share');
    behave({ output: { verdict: 'approve' }, opencode_data_home: written });
    const runtime = start({ XDG_DATA_HOME: stale });
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode', home: written } });
  });

  it('starts a new agent for a step that asks to resume a session Paseo does not list in the worktree, and says why', async () => {
    behave({ output: { verdict: 'approve' }, provider_sessions: ['session-of-another-directory'] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b', { resume: 'session-of-an-earlier-pass' }));

    const end = await runtime.next(isEnd('op-0000000b'));
    const create = received().find((request) => request.type === 'agent.create.request');
    expect(end).toEqual({ op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` }, result: { output: { verdict: 'approve' } } });
    expect(JSON.stringify(create)).not.toContain('session-of-an-earlier-pass');
    expect(received().filter((request) => request.type === 'import_agent_request')).toEqual([]);
    // Paseo imports a session it does not hold all the same, and fails its first turn (recorded on 0.14.0).
    expect(runtime.lines.filter((line) => 'event' in line && line.event === 'notice' && 'op' in line && line.op === 'op-0000000b')).toEqual([{
      op: 'op-0000000b', event: 'notice',
      message: `teamai-runtime-paseo starts a new agent for step "review" rather than resume session session-of-an-earlier-pass: Paseo lists no claude session of that id in ${worktree}.`,
    }]);
  });

  it('imports the session a step resumes, which Paseo lists in the worktree, runs it as the step asks, and sends it the prompt as a new turn', async () => {
    behave({ output: { verdict: 'approve' }, provider_sessions: ['session-of-another-driver'] });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    const folder = path.join(dir, 'folders', 'b'.repeat(64));
    const resuming = promptRequest(handle, 'op-0000000b', { resume: 'session-of-another-driver', model: { name: 'claude-opus-5-5', effort: 'high' } });
    runtime.send({ ...resuming, env: { ...resuming.env, TEAMAI_WORKFLOW_DIR: folder } });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: 'session-of-another-driver' }, result: { output: { verdict: 'approve' } }, resumed: true,
    });
    const crossed = received();
    expect(crossed.filter((request) => request.type === 'agent.create.request')).toEqual([]);
    const imported = crossed.find((request) => request.type === 'import_agent_request');
    expect(imported).toMatchObject({
      providerId: 'claude', providerHandleId: 'session-of-another-driver', cwd: worktree, workspaceId: worktreeWorkspace(),
      labels: { 'teamai-attempt': `${RUN}/${ATTEMPT}`, 'teamai-run': RUN, 'teamai-step': 'review' },
    });
    const agent = String(crossed.find((request) => request.type === 'send_agent_message_request')?.agentId);
    // Paseo starts an imported agent on its own default model and mode (recorded on 0.14.0): the step's are set before the turn.
    expect(crossed.filter((request) => request.type.startsWith('set_agent_')).map(({ type, agentId, modelId, modeId, thinkingOptionId }) => ({ type, agentId, modelId, modeId, thinkingOptionId }))).toEqual([
      { type: 'set_agent_model_request', agentId: agent, modelId: 'claude-opus-5-5', modeId: undefined, thinkingOptionId: undefined },
      { type: 'set_agent_mode_request', agentId: agent, modelId: undefined, modeId: 'auto', thinkingOptionId: undefined },
      { type: 'set_agent_thinking_request', agentId: agent, modelId: undefined, modeId: undefined, thinkingOptionId: 'high' },
    ]);
    // An import carries no env, so the turn names the run's scratch directory.
    const text = String(crossed.find((request) => request.type === 'send_agent_message_request')?.text);
    expect(text.split('\n\n')[0]).toBe(`This agent resumes an earlier session, so its shell has no TEAMAI_RUN_DIR or TEAMAI_WORKFLOW_DIR: the run's scratch directory is ${path.join(dir, 'run')}, and the workflow's folder ${folder}.`);
    expect(text).toContain('Review the change.');
  });

  it('fails a step whose model the daemon lacks as model_unavailable, naming what it offers, and creates no agent', async () => {
    behave({ models: { claude: ['claude-sonnet-5-5'] } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { model: { name: 'claude-opus-5-5' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'model_unavailable', message: `The Paseo daemon at ${daemon.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` },
    });
    // Accepted before Paseo lists the models, which may take long; the failure follows, with no agent created.
    expect(runtime.lines.filter((line) => 'op' in line && line.op === 'op-0000000b').map((line) => ('event' in line ? line.event : ''))).toEqual(['accepted', 'failed']);
    expect(received()).toEqual([]);
  });

  it('runs the step\'s effort as the model\'s thinking option, and fails an effort the model lacks', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b', { model: { name: 'claude-opus-5-5', effort: 'high' } }));
    runtime.send(promptRequest(handle, 'op-0000000c', { model: { name: 'claude-opus-5-5', effort: 'ultra' } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'failed', failure: { code: 'model_unavailable', message: expect.stringContaining('no effort ultra for claude model claude-opus-5-5') } });
    expect(received()).toEqual([expect.objectContaining({ config: expect.objectContaining({ model: 'claude-opus-5-5', thinkingOptionId: 'high' }) })]);
  });

  it('starts an OpenCode agent with no mode, as Paseo starts one it sets no default mode for, on the daemon\'s default model when the step names none, writing the result file\'s directory and the run\'s scratch directory without asking', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { tool: 'opencode', model: undefined }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode' } });
    const [create] = received();
    expect(create).toMatchObject({ config: { provider: 'opencode', model: 'opencode/beam-free' } });
    expect(create).not.toHaveProperty('config.modeId');
    // OpenCode asks before it touches a directory outside its project (`external_directory: ask`): Paseo passes this rule
    // to the agent's session, so the two teamai writes outside the worktree are allowed, and only they.
    expect(create).toHaveProperty('config.providerOptions', { permission: { external_directory: { [`${path.join(dir, 'out')}/*`]: 'allow', [`${path.join(dir, 'run')}/*`]: 'allow' } } });
  });

  it('answers a cancel of a prompt that already ended with that end again, and stops nothing', async () => {
    behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out', output: { verdict: 'approve' } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const finished = await runtime.next(isEnd('op-0000000b'));
    // Refused before any agent existed: Codex is signed out.
    runtime.send(promptRequest(handle, 'op-0000000c', { tool: 'codex', model: undefined }));
    const refused = await runtime.next(isEnd('op-0000000c'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    runtime.send({ type: 'cancel', op: 'op-0000000c' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(finished);
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual(refused);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
  });

  it('answers a recover-mode cancel of a prompt whose end teamai lost with the end it recorded', async () => {
    behave({ output: { verdict: 'approve' } });
    const first = start();
    await ready(first);
    first.send(promptRequest(await opened(first), 'op-0000000b'));
    const finished = await first.next(isEnd('op-0000000b'));
    await first.kill();

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual(finished);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
  });

  it('cancels a running prompt: the agent is cancelled, and the prompt ends cancelled though Paseo reports the agent idle', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('fails a cancel Paseo refuses, saying its agent may still run, rather than ending cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    const end = await runtime.next(isEnd('op-0000000b'));
    const [create] = received();

    expect(end).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not cancel the claude agent ${String(create?.agentId)}: Agent is busy. It may still run in the worktree; stop it in the Paseo app.` },
    });
  });

  it('resumes on the same agent after it is killed with -9 once the agent was created, and creates no second one', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { verdict: 'approve' } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    second.send(promptRequest(handle, 'op-0000000b'));
    await second.next(isOp('op-0000000b', 'accepted'));
    fs.writeFileSync(release, '');

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { verdict: 'approve' } } });
    const agents = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, unknown> };
    expect(Object.keys(agents.agents)).toHaveLength(1);
  });

  it('cancels the agent of a prompt whose runtime was killed with -9, and ends it cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await second.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('ends a prompt cancelled only once Paseo cancels its agent, and fails it when Paseo refuses late', async () => {
    behave({ ask_permission: true, output: { ok: true }, refuse_cancel: 'Agent is busy', refuse_cancel_ms: 2500 });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
  });

  it('fails the attempt with its work kept when the daemon restarts mid-step, leaving the retry to teamai, and a retried prompt runs again', async () => {
    behave({ hold_ms: 60_000, touch: 'work.txt', output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => fs.existsSync(path.join(worktree, 'work.txt'))).toBe(true);

    const port = Number(new URL(daemon.url).port);
    await daemon.close();
    behave({ output: { ok: true } });
    await restartDaemon({ port });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree.` },
    });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('work in progress\n');
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('ends an unattended step whose agent asks for permission cancel_failed when Paseo will not stop that agent, since it may still run', async () => {
    behave({ ask_permission: true, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/asked for permission \(Run npm test\).* Paseo did not cancel the claude agent .*: Agent is busy\./) },
    });
  });

  it('reports a prompt whose cancel failed running while a retried cancel stops it, then cancelled, never the old failure', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });

    // The member stops what held the agent, and cancels the run again: Paseo stops it a moment after it answers.
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('answers a prompt resent while a retried cancel runs, in a runtime started again, as running, never with the old cancel_failed', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    first.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    await first.kill();

    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const second = start();
    await ready(second, { mode: 'recover' });
    second.send({ type: 'cancel', op: 'op-0000000b' });
    const restarted = start();
    await ready(restarted);
    restarted.send(promptRequest(handle, 'op-0000000b'));

    expect(await restarted.next(isOp('op-0000000b', 'accepted'))).toEqual({ op: 'op-0000000b', event: 'accepted' });
    restarted.send({ type: 'reattach', handle });
    expect(await restarted.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    expect(await second.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(await restarted.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  });

  it('answers a retried cancel with the end a runtime following the resent prompt recorded while Paseo answered the cancel', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy' });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    first.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await first.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    await first.kill();

    // Paseo takes the retried cancel but answers it late. The runtime the prompt is resent to cancels the agent too, is
    // answered at once, sees the agent stop and records the end before the runtime that retried the cancel hears back.
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_000, cancel_reply_ms: 4_000 });
    const second = start();
    await ready(second, { mode: 'recover' });
    second.send({ type: 'cancel', op: 'op-0000000b' });
    await expect.poll(() => received().filter((request) => request.type === 'cancel_agent_request')).toHaveLength(2);
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_000 });
    const restarted = start();
    await ready(restarted);
    restarted.send(promptRequest(handle, 'op-0000000b'));
    expect(await restarted.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });

    const answered = await Promise.race([second.next(isEnd('op-0000000b')), delay(6_000).then(() => 'no answer')]);

    expect(answered).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  });

  it('answers a cancel that comes while Paseo still creates the agent within 15 s of reading it, cancel_failed, since the agent may still start', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 30_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not finish creating the claude agent ${agentIdOf(OpIdSchema.parse('op-0000000b'))} within 10 s, so it may still start in the worktree; cancel the run again.` },
    });
    expect(Date.now() - asked).toBeLessThan(15_000);
  }, 40_000);

  it('keeps waiting for a create a timed-out cancel left, so a retried cancel and a close stop its agent once it exists', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 25_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    const stillCreating = { op: 'op-0000000b', event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo did not finish creating the claude agent /) } };
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(stillCreating);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(stillCreating);
    runtime.send({ type: 'close', handle });
    expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
    // The agent was created after both cancels, and the close stopped it.
    expect(Object.values(kept.agents)).toHaveLength(1);
    expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
  }, 60_000);

  it('follows the agent of a create whose answer was lost, rather than fail a prompt whose agent runs', async () => {
    behave({ output: { ok: true }, lose_create_reply: true });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('ends a prompt whose create Paseo refused cancel_failed, since a refused create may still start its agent', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 1_500, refuse_create_early: 'Connection reset before the create was answered' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    const agentId = agentIdOf(OpIdSchema.parse('op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo could not create the claude agent ${agentId} (Connection reset before the create was answered), and does not show it, though it may still start. It may still run in the worktree; stop it in the Paseo app.` },
    });
    // It did start.
    await expect.poll(agentsOf, { timeout: 5_000 }).toEqual([agentId]);
  });

  it('ends a prompt whose create never reached Paseo agent_create_failed, since no agent can have started', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    // The worktree is gone before the create: Paseo cannot open it as the agent's workspace, so the create is never sent.
    fs.rmSync(worktree, { recursive: true });
    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'agent_create_failed', message: expect.stringMatching(/^Paseo could not create the claude agent: /) } });
    expect(received()).toEqual([]);
  });

  it('keeps an earlier runtime\'s create uncertain when the resent prompt cannot open its workspace, ending it cancel_failed', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 6_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await expect.poll(() => received().map((request) => request.type)).toEqual(['agent.create.request']);
    await first.kill();
    // The worktree is away while the resent prompt opens it, so this runtime sends no create of its own.
    const away = `${worktree}.away`;
    fs.renameSync(worktree, away);
    const second = start();
    await ready(second);

    second.send(promptRequest(handle, 'op-0000000b'));

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    fs.renameSync(away, worktree);
    // The first runtime's create lands.
    await expect.poll(agentsOf, { timeout: 15_000 }).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
    expect(received().map((request) => request.type)).toEqual(['agent.create.request']);
  }, 30_000);

  it('ends a prompt that fails once its agent exists cancel_failed, naming the cause, since the agent may still run', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, create_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'places', `${encodeURIComponent(handle)}.json`), '{"kind":');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
      event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: .*\. The claude agent .* may still run in the worktree; stop it in the Paseo app\.$/s) },
    });
  });

  it('ends a cancel Paseo does not answer cancel_failed within 10 s, inside the 15 s teamai gives it', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, refuse_cancel: 'Agent is busy', refuse_cancel_ms: 40_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo did not answer the cancel of the claude agent ${String(received()[0]?.agentId)} within 10 s. It may still run in the worktree; stop it in the Paseo app.` },
    });
    expect(Date.now() - asked).toBeLessThan(15_000);
  }, 30_000);

  it('fails an unattended step whose agent asks for permission, naming the mode, and stops the agent', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: {
        code: 'tool_failed',
        message: 'The claude agent asked for permission (Run npm test) in Paseo mode auto, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.',
      },
    });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
  });

  it('waits in an attended run until the person answers the permission request in Paseo, then finishes', async () => {
    behave({ ask_permission: true, output: { ok: true } });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    const agentId = String(received()[0]?.agentId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([]);

    fs.writeFileSync(path.join(daemonState, 'answers', agentId), 'allow');

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
  });

  it('takes interactive steps in an attended run only, where a person can work in the agent in the Paseo app', async () => {
    expect(await ready(start(), { mode: 'attended' })).toMatchObject({ ok: true, can: { hitl: true } });
    expect(await ready(start(), { mode: 'unattended' })).toMatchObject({ ok: true, can: { hitl: false } });
  });

  it('runs an interactive step as an agent the person works with in Paseo, ending it only once the agent wrote the result, though it idles between their turns', async () => {
    // The agent's first turn ends with no result, as a turn that asks the person something does.
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { interactive: true }));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    expect(received()[0]).toMatchObject({ initialPrompt: expect.stringMatching(/^This step is interactive: work through it with the person in this Paseo agent\. Write the result file only once they say the step is done\.\n\nReview the change\./) });

    // Idle, with no result: the person may still be in it.
    await delay(3_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toEqual([]);

    // The person said it is done, and the agent's next turn wrote the result.
    fs.writeFileSync(path.join(dir, 'out', 'result.json'), JSON.stringify({ output: { agreed: true } }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { agreed: true } } });
  });

  it('fails an interactive step, as any step, once its agent idles on a result file that is not a workflow result', async () => {
    behave({ result: 'not a result' });
    const runtime = start();
    await ready(runtime, { mode: 'attended' });
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b', { interactive: true }));

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('shows the workspace when it opens, and the agent with a link to it in Paseo in a display event once the agent exists', async () => {
    behave({ output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const workspace = worktreeWorkspace();

    expect(runtime.lines.find(isOp('op-0000000a', 'ready'))).toEqual({ op: 'op-0000000a', event: 'ready', display: { label: 'Paseo workspace worktree', fields: { workspace, daemon: 'Paseo 0.14.0' } } });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const accepted = await runtime.next(isOp('op-0000000b', 'accepted'));
    const shown = await runtime.next(isOp('op-0000000b', 'display'));
    await runtime.next(isEnd('op-0000000b'));
    const agentId = String(received()[0]?.agentId);
    const agent = { label: `teamai review · ${RUN}`, url: `paseo://h/srv_fake0001/agent/${agentId}`, fields: { agent: agentId, workspace, model: 'claude/claude-opus-5-5' } };

    expect(accepted).toEqual({ op: 'op-0000000b', event: 'accepted' });
    expect(shown).toEqual({ op: 'op-0000000b', event: 'display', display: agent });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ display: agent });
  });

  it('accepts a prompt before Paseo has created its agent, and sends the agent\'s link once it exists', async () => {
    behave({ output: { ok: true }, create_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    await runtime.next(isOp('op-0000000b', 'accepted'));
    expect(agentsOf()).toEqual([]);
    expect(await runtime.next(isOp('op-0000000b', 'display'))).toMatchObject({ display: { url: `paseo://h/srv_fake0001/agent/${agentIdOf(OpIdSchema.parse('op-0000000b'))}` } });
    expect(agentsOf()).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
  });

  it('accepts a prompt before Paseo lists its models, and a cancel then ends it cancelled with no agent ever created', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const asked = Date.now();

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(Date.now() - asked).toBeLessThan(10_000);
    // Past the listing: the agent is never created.
    await delay(4_000);
    expect(received()).toEqual([]);
    expect(agentsOf()).toEqual([]);
  });

  it('ends cancelled, in recover mode, a prompt whose runtime was killed before it created the agent, and creates none', async () => {
    behave({ output: { ok: true }, models_ms: 3_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    recovering.send({ type: 'close', handle });
    expect(await recovering.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
    expect(agentsOf()).toEqual([]);
  });

  it('runs a prompt resent after its runtime was killed before it created the agent, creating it once', async () => {
    behave({ output: { ok: true }, models_ms: 2_000 });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await first.kill();

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'running' }] });
    second.send(promptRequest(handle, 'op-0000000b'));

    expect(await second.next(isOp('op-0000000b', 'accepted'))).toEqual({ op: 'op-0000000b', event: 'accepted' });
    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
    expect(agentsOf()).toEqual([agentIdOf(OpIdSchema.parse('op-0000000b'))]);
  });

  // Runtimes of two teamai versions may share a journal, and a later one may give an agent an env key this one never heard of.
  it('follows a prompt whose record a later runtime wrote with an env key this one does not know, and keeps that create as written', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const file = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.json');
    const record = z.looseObject({ create: z.looseObject({ env: z.record(z.string(), z.string()) }) }).parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, JSON.stringify({ ...record, create: { ...record.create, env: { ...record.create.env, TEAMAI_LATER_DIR: path.join(dir, 'later') } } }));

    const second = start();
    await ready(second);
    second.send({ type: 'reattach', handle });
    expect(await second.next((line) => 'event' in line && !('op' in line))).toMatchObject({ event: 'alive', ops: [{ op: 'op-0000000b', state: 'running' }] });
    fs.writeFileSync(release, '');
    second.send(promptRequest(handle, 'op-0000000b'));

    expect(await second.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ create: { env: { TEAMAI_RUN_DIR: path.join(dir, 'run'), TEAMAI_LATER_DIR: path.join(dir, 'later') } } });
  });

  it('ends a prompt once when its cancel cannot read the prompt\'s record, though its agent then ends', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    // Its follow read the record before it waits for the agent; a record broken before that read ends the prompt then.
    await until(() => waitedOn(agentIdOf(OpIdSchema.parse('op-0000000b'))));
    fs.writeFileSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.json'), '{not json');

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: .*\. Its agent may still run in the worktree; stop it in the Paseo app\.$/s) } });
    fs.writeFileSync(release, '');
    await delay(3_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
  });

  it('ends a prompt once when its cancel cannot record itself, and a later cancel, once it can, stops the agent', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    // The cancel marker cannot be written where a directory stands.
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(' may still run in the worktree; stop it in the Paseo app.') } });
    // The agent ends on its own; the prompt already ended, so it is not ended again.
    fs.writeFileSync(release, '');
    await delay(3_000);
    fs.rmdirSync(marker);
    await delay(1_000);
    expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
  });

  it('keeps the cancel_failed of a cancel that could not record itself, so a reattach before the retry reports it', async () => {
    const release = path.join(dir, 'release');
    behave({ release, output: { ok: true } });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));
    // The cancel marker cannot be written where a directory stands; the prompt's record still can.
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    // The agent ends on its own, and nothing follows it any more.
    fs.writeFileSync(release, '');
    const statusOf = (): string | undefined => (JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> }).agents[agentIdOf(OpIdSchema.parse('op-0000000b'))]?.status;
    await expect.poll(statusOf).toBe('idle');
    fs.rmdirSync(marker);
    const isAlive = (line: RuntimeMessage): boolean => 'event' in line && line.event === 'alive';

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'cancel_failed' } }] });
    runtime.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    runtime.send({ type: 'reattach', handle });
    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
  });

  it('keeps the failure a prompt\'s request ended with, so a reattach and a repeated prompt report it rather than run it again', async () => {
    behave({ output: { ok: true }, refuse_fetch: 'Agent store unavailable' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    const ended = await runtime.next(isEnd('op-0000000b'));
    expect(ended).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed', message: expect.stringMatching(/^Paseo failed: Agent store unavailable\. /) } });
    behave({ output: { ok: true } });
    const isAlive = (line: RuntimeMessage): boolean => 'event' in line && line.event === 'alive';

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next(isAlive)).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'cancel_failed' } }] });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(ended);
    expect(received()).toEqual([]);
  });

  it('ends a prompt whose request failed once, though it could not record the failure and its place closes afterwards', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    // While Paseo lists the models, the prompts' records become read-only: the agent record cannot be saved, nor the failure.
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    fs.chmodSync(ops, 0o755);
    const isCloseAnswer = (line: RuntimeMessage): boolean => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event);

    runtime.send({ type: 'close', handle });

    expect(await runtime.next(isCloseAnswer)).toEqual({ event: 'closed', handle });
    expect(runtime.lines.filter(isEnd('op-0000000b')).map((line) => ('event' in line ? line.event : undefined))).toEqual(['failed']);
  });

  it('reports the failure of a prompt it could not record to a reattach in the same process, not running', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    fs.chmodSync(ops, 0o755);

    runtime.send({ type: 'reattach', handle });

    expect(await runtime.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'failed', failure: { code: 'paseo_failed' } }] });
  });

  it('answers a cancel of a prompt whose failure it could not record with that failure again, never cancelled', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, models_ms: 2_000 });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    runtime.send(promptRequest(handle, 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'accepted'));
    const ops = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops');
    fs.chmodSync(ops, 0o555);
    const failed = await runtime.next(isEnd('op-0000000b'));
    fs.chmodSync(ops, 0o755);

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(failed).toMatchObject({ event: 'failed', failure: { code: 'paseo_failed' } });
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual(failed);
  });

  it('answers every cancel in recover mode, though the first could not record itself', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'display'));
    await first.kill();
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo', 'ops', 'op-0000000b.cancel');
    fs.mkdirSync(marker);

    const recovering = start();
    await ready(recovering, { mode: 'recover' });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
    fs.rmdirSync(marker);
    recovering.send({ type: 'cancel', op: 'op-0000000b' });
    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
  });

  it('ends a cancelled prompt only once its agent stopped running, though Paseo answers the cancel before', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 1_500 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    expect(stopped()).toEqual([{ agentId: String(received()[0]?.agentId), status: 'idle' }]);
  });

  it('fails a cancel whose agent still runs well after Paseo answered it, and says to stop it in the app', async () => {
    behave({ hold_ms: 60_000, output: { ok: true }, stop_lag_ms: 60_000 });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));
    await runtime.next(isOp('op-0000000b', 'display'));

    runtime.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'cancel_failed', message: `Paseo cancelled the claude agent ${String(received()[0]?.agentId)}, but it still ran 10 s later. It may still change the worktree; stop it in the Paseo app.` },
    });
  }, 30_000);

  it('stops a journaled prompt in recover mode though its tool is signed out since, reaching the daemon for the cancel and the close', async () => {
    behave({ hold_ms: 60_000, output: { ok: true } });
    const first = start();
    await ready(first);
    const handle = await opened(first);
    first.send(promptRequest(handle, 'op-0000000b'));
    await first.next(isOp('op-0000000b', 'accepted'));
    await expect.poll(() => received().length).toBe(1);
    await first.kill();
    behave({ sign_in: { claude: 'signed_out' } });

    const recovering = start();
    expect(await ready(recovering, { mode: 'recover' })).toEqual({ type: 'init', ok: true, can: {} });
    recovering.send({ type: 'cancel', op: 'op-0000000b' });

    expect(await recovering.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
    recovering.send({ type: 'reattach', handle });
    expect(await recovering.next((line) => 'event' in line && line.event === 'alive')).toMatchObject({ ops: [{ op: 'op-0000000b', state: 'cancelled' }] });
    recovering.send({ type: 'close', handle });

    expect(await recovering.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
    expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request', 'archive_workspace_request']);
  });

  it('fails a step whose agent errors, with Paseo\'s error, and one whose agent wrote no result', async () => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    behave({ error: 'Claude Code exited: not logged in' });
    runtime.send(promptRequest(handle, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'The claude agent failed in Paseo: Claude Code exited: not logged in' } });

    behave({});
    runtime.send(promptRequest(handle, 'op-0000000c'));
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  // A FIFO, which a plain read would wait on; a file the daemon's user wrote that the user teamai runs as cannot read.
  it.skipIf(process.platform === 'win32').each([
    {
      left: 'a FIFO',
      leave: (file: string) => execFileSync('mkfifo', [file]),
      message: (file: string) => `claude left a pipe at the result file ${file}, not a regular file, so teamai did not read it`,
    },
    {
      left: 'a file teamai cannot read',
      leave: (file: string) => {
        fs.writeFileSync(file, JSON.stringify({ output: { verdict: 'approve' } }));
        fs.chmodSync(file, 0o200);
      },
      message: (file: string) => `claude wrote the result file ${file}, which teamai cannot read because it has no permission to read it. Let the user teamai runs as read ${file}, then retry the step`,
    },
  ])('fails at once a step whose agent left $left at the result file, saying why teamai did not read it', async ({ leave, message }) => {
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    const result = path.join(dir, 'out', 'result.json');
    fs.mkdirSync(path.dirname(result), { recursive: true });
    leave(result);
    behave({});
    runtime.send(promptRequest(handle, 'op-0000fe11'));

    expect(await runtime.next(isEnd('op-0000fe11'))).toEqual({ op: 'op-0000fe11', event: 'failed', failure: { code: 'tool_failed', message: message(result) } });
  });

  it.each([
    ['Claude', 'claude', "You've hit your limit · resets 3pm (Europe/Madrid)"],
    ['Codex', 'codex', "You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM."],
    ['Claude, on its 5-hour limit,', 'claude', '5-hour limit reached ∙ resets 2pm'],
    ['Claude, on the API\'s rate limit,', 'claude', 'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.'],
  ])('fails a step whose %s agent stops on its usage limit usage_limited, with the reset time the tool gave, whether Paseo reports it as an error or as its last message', async (_, tool, said) => {
    behave({ codex_login: 'signed_in' });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);
    behave({ codex_login: 'signed_in', error: said });
    runtime.send(promptRequest(handle, 'op-0000000b', { tool, model: undefined }));
    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${said}` } });

    behave({ codex_login: 'signed_in', reply: said });
    runtime.send(promptRequest(handle, 'op-0000000c', { tool, model: undefined }));
    expect(await runtime.next(isEnd('op-0000000c'))).toEqual({ op: 'op-0000000c', event: 'failed', failure: { code: 'usage_limited', message: `The ${tool} agent hit its usage limit in Paseo: ${said}` } });
  });

  it('fails tool_failed, not usage_limited, a step whose agent writes no result after a last message that only mentions a limit', async () => {
    behave({ reply: 'The handler now returns 429 when clients hit your rate limit.' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('fails tool_failed, not usage_limited, a step whose agent writes no result after a last message of its own that starts with a limit it hit elsewhere', async () => {
    behave({ reply: 'Rate limit reached on the GitHub API while listing the pull requests.\n\nI could not finish the review; run it again once the limit resets.' });
    const runtime = start();
    await ready(runtime);
    runtime.send(promptRequest(await opened(runtime), 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'claude did not write a valid workflow result' } });
  });

  it('fails a step whose agent wrote its result but has no session in Paseo, saying so rather than blaming the result', async () => {
    behave({ output: { verdict: 'approve' }, no_session: true });
    const runtime = start();
    await ready(runtime);
    const handle = await opened(runtime);

    runtime.send(promptRequest(handle, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
      op: 'op-0000000b', event: 'failed',
      failure: { code: 'tool_failed', message: 'Paseo reported no session for the claude agent, so teamai cannot record or score its pass. Run `teamai workflow retry` to run it again.' },
    });
  });
});

describe('a prompt that continues an earlier prompt\'s conversation', () => {
  useRuntimeSuite();

  /** The fix step's prompt on attempt a0123abce, whose result file sits in its own directory, continuing prompt `earlier` of place `from`. */
  const fixing = (handle: string, op: string, from: string, earlier: string, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}) => {
    const result = path.join(dir, 'out-fix', 'result.json');
    fs.mkdirSync(path.dirname(result), { recursive: true });

    return promptRequest(handle, op, {
      step: 'fix', result, prompt: `Fix what the review found.\n\nWrite the workflow result as JSON to ${result}. Write {"output": …}.`, continue: { handle: from, op: earlier }, ...lease,
    });
  };

  /** The review step ran in its place and finished: its place, and the agent it ran on. */
  async function reviewed(runtime: ReturnType<typeof start>): Promise<{ review: string; agent: string }> {
    const review = await opened(runtime);
    runtime.send(promptRequest(review, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });

    return { review, agent: createdAgent('op-0000000b') };
  }

  /** The runtime's client reconnects to a restarted daemon within its 2 s backoff, as before the next step comes. */
  const reconnected = (): Promise<void> => delay(3_000);

  const creates = (): unknown[] => received().filter((request) => request.type === 'agent.create.request');
  const noticesOf = (runtime: ReturnType<typeof start>, op: string): unknown[] => runtime.lines.filter((line) => 'event' in line && line.event === 'notice' && 'op' in line && line.op === op);

  it('sends the prompt to the earlier prompt\'s agent as a new turn, and ends finished with that agent\'s session and resumed', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true } });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toEqual({
      op: 'op-0000000d', event: 'finished', session: { tool: 'claude', id: `fake-session-${agent}` }, result: { output: { fixed: true } }, resumed: true,
    });
    expect(creates()).toHaveLength(1);
    expect(received().filter((request) => request.type === 'send_agent_message_request')).toEqual([expect.objectContaining({ agentId: agent, text: expect.stringContaining('Fix what the review found.') })]);
    expect(noticesOf(runtime, 'op-0000000d')).toEqual([]);
  });

  it('reports only the tokens of its own turn, not those of the earlier step in the same session', async () => {
    behave({ output: { verdict: 'request-changes' }, claude_home: path.join(dir, 'daemon-user', '.claude'), usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    const runtime = start();
    await ready(runtime);
    const review = await opened(runtime);
    runtime.send(promptRequest(review, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', usage: { input: 1_200, output: 340, cachedInput: 18_000 } });
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true }, claude_home: path.join(dir, 'daemon-user', '.claude'), usage: { input: 1_200, output: 340, cache_read: 18_000 } });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', resumed: true, usage: { input: 1_200, output: 340, cachedInput: 18_000 } });
  });

  // A step of a named child workflow may go on from the step beside its enclosing one, and each has its own workflow folder.
  it('names this step\'s workflow folder in the turn when the earlier agent\'s shell has another one', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const review = await opened(runtime);
    const [parentFolder, childFolder] = [path.join(dir, 'folders', 'a'.repeat(64)), path.join(dir, 'folders', 'b'.repeat(64))];
    const first = promptRequest(review, 'op-0000000b');
    runtime.send({ ...first, env: { ...first.env, TEAMAI_WORKFLOW_DIR: parentFolder } });
    expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished' });
    const agent = createdAgent('op-0000000b');
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true } });
    const later = fixing(fix, 'op-0000000d', review, 'op-0000000b');
    runtime.send({ ...later, env: { ...later.env, TEAMAI_WORKFLOW_DIR: childFolder } });

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', result: { output: { fixed: true } }, resumed: true });
    expect(received().filter((request) => request.type === 'send_agent_message_request')).toEqual([expect.objectContaining({
      agentId: agent,
      text: `This agent goes on from an earlier step, so its shell's TEAMAI_WORKFLOW_DIR is that step's: this step's workflow folder is ${childFolder}.\n\n${String(later.lease.prompt)}`,
    })]);
  });

  it('allows the continued agent to write the later step\'s result file, which its create did not allow, as a new agent would be allowed, and nothing else', async () => {
    // The agent asks before it writes outside what its create allowed, as Claude does in Always Ask (recorded on Paseo 0.14.0).
    behave({ output: { verdict: 'request-changes' }, asks_outside_grant: true });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true }, asks_outside_grant: true });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', result: { output: { fixed: true } }, resumed: true });
    expect(received().filter((request) => request.type === 'agent_permission_response')).toEqual([
      expect.objectContaining({ agentId: agent, requestId: `perm-write-${agent}`, response: { behavior: 'allow' } }),
    ]);
  });

  it('allows no write that a link in the result directory leads outside it, and the step fails on the request instead', async () => {
    behave({ output: { verdict: 'request-changes' }, asks_outside_grant: true });
    const runtime = start();
    await ready(runtime, { mode: 'unattended' });
    const { review } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });
    // An earlier step left the result file's name as a link to a file outside every grant, which does not exist yet.
    const outside = path.join(dir, 'elsewhere', 'planted');
    fs.mkdirSync(path.dirname(outside));
    fs.mkdirSync(path.join(dir, 'out-fix'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'out-fix', 'result.json'));

    behave({ output: { fixed: true }, asks_outside_grant: true });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('asked for permission (Write)') } });
    expect(received().filter((request) => request.type === 'agent_permission_response')).toEqual([]);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('starts a new agent, and says why, when Paseo no longer shows the earlier agent, as when the person deleted it', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    // The person deletes the agent in the Paseo app.
    behave({ output: { fixed: true }, forget_creates: ['op-0000000b'] });

    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    const end = await runtime.next(isEnd('op-0000000d'));

    expect(end).toEqual({ op: 'op-0000000d', event: 'finished', session: { tool: 'claude', id: `fake-session-${createdAgent('op-0000000d')}` }, result: { output: { fixed: true } } });
    expect(noticesOf(runtime, 'op-0000000d')).toEqual([{
      op: 'op-0000000d', event: 'notice',
      message: `teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-0000000b: Paseo no longer shows agent ${agent}.`,
    }]);
  });

  it('continues the earlier agent after the daemon restarted between the two prompts', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    const port = Number(new URL(daemon.url).port);
    await daemon.close();
    behave({ output: { fixed: true } });
    await restartDaemon({ port });
    await reconnected();

    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', session: { id: `fake-session-${agent}` }, resumed: true });
    expect(creates()).toHaveLength(1);
  });

  it('starts a new agent, and says why, for a prompt whose place works in another workspace', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const elsewhere = path.join(dir, 'worktree-fix');
    fs.mkdirSync(elsewhere);
    const opening = openRequest('op-0000000c', 'a0123abce');
    runtime.send({ ...opening, view: { ...opening.view, worktree: elsewhere } });
    const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
    await runtime.next(isOp('op-0000000c', 'ready'));
    const fix = 'handle' in accepted ? String(accepted.handle) : '';

    behave({ output: { fixed: true } });
    runtime.send({ ...fixing(fix, 'op-0000000d', review, 'op-0000000b'), cwd: elsewhere });

    expect(await runtime.next(isEnd('op-0000000d'))).not.toHaveProperty('resumed');
    expect(creates()).toHaveLength(2);
    expect(noticesOf(runtime, 'op-0000000d')).toEqual([expect.objectContaining({ message: expect.stringMatching(new RegExp(`^teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-0000000b: agent ${agent} works in Paseo workspace .+, and this step works in .+\\.$`)) })]);
  });

  it('starts a new agent, and says why, for a prompt on another model than the earlier agent\'s', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true } });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b', { model: { name: 'claude-sonnet-5-5' } }));

    expect(await runtime.next(isEnd('op-0000000d'))).not.toHaveProperty('resumed');
    expect(creates()).toHaveLength(2);
    expect(noticesOf(runtime, 'op-0000000d')).toEqual([{
      op: 'op-0000000d', event: 'notice',
      message: `teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-0000000b: agent ${agent} runs claude/claude-opus-5-5, and this step runs claude/claude-sonnet-5-5.`,
    }]);
  });

  it('imports the session the lease resumes when it cannot continue the earlier agent, saying why it did not continue', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ output: { fixed: true }, provider_sessions: ['session-of-another-driver'] });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b', { model: { name: 'claude-sonnet-5-5' }, resume: 'session-of-another-driver' }));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', session: { tool: 'claude', id: 'session-of-another-driver' }, resumed: true });
    expect(creates()).toHaveLength(1);
    expect(received().filter((request) => request.type === 'import_agent_request')).toHaveLength(1);
    expect(noticesOf(runtime, 'op-0000000d')).toEqual([{
      op: 'op-0000000d', event: 'notice',
      message: `teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-0000000b: agent ${agent} runs claude/claude-opus-5-5, and this step runs claude/claude-sonnet-5-5.`,
    }]);
  });

  it('sends one turn at a time to a conversation: a second prompt that continues it meanwhile starts a new agent, and says why', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });
    const other = await opened(runtime, { attempt: 'a0123abcf', op: 'op-0000000e' });

    behave({ output: { fixed: true }, hold_ms: 1500 });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    runtime.send(fixing(other, 'op-0000000f', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', resumed: true });
    expect(await runtime.next(isEnd('op-0000000f'))).toMatchObject({ event: 'finished' });
    expect(runtime.lines.find(isEnd('op-0000000f'))).not.toHaveProperty('resumed');
    expect(received().filter((request) => request.type === 'send_agent_message_request' && request.agentId === agent)).toHaveLength(1);
    expect(noticesOf(runtime, 'op-0000000f')).toEqual([{
      op: 'op-0000000f', event: 'notice',
      message: `teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-0000000b: agent ${agent} runs the turn of op-0000000d.`,
    }]);
  });

  it('stops only the running turn when the later place closes, and leaves the conversation to a step that continues it after', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ hold_ms: 60_000, output: { fixed: true } });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    await runtime.next(isOp('op-0000000d', 'display'));
    runtime.send({ type: 'close', handle: fix });

    expect(await runtime.next(isEnd('op-0000000d'))).toEqual({ op: 'op-0000000d', event: 'cancelled' });
    await runtime.next((line) => 'handle' in line && line.handle === fix && 'event' in line && line.event === 'closed');
    expect(received().filter((request) => ['cancel_agent_request', 'archive_workspace_request', 'delete_agent_request'].includes(request.type))).toEqual([expect.objectContaining({ type: 'cancel_agent_request', agentId: agent })]);

    // A later step goes on with the same conversation.
    const again = await opened(runtime, { attempt: 'a0123abcf', op: 'op-0000000e' });
    behave({ output: { fixed: true } });
    runtime.send(fixing(again, 'op-0000000f', review, 'op-0000000b'));
    expect(await runtime.next(isEnd('op-0000000f'))).toMatchObject({ event: 'finished', session: { id: `fake-session-${agent}` }, resumed: true });
  });

  it('reattaches a continuing prompt resent to a runtime started again while its turn runs, and sends the turn once', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const first = start();
    await ready(first);
    const { review, agent } = await reviewed(first);
    const fix = await opened(first, { attempt: 'a0123abce', op: 'op-0000000c' });
    const release = path.join(dir, 'release');
    behave({ release, output: { fixed: true } });
    first.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    // Killed once Paseo runs the turn.
    await expect.poll(() => received().some((request) => request.type === 'send_agent_message_request')).toBe(true);
    await first.kill();

    const second = start();
    await ready(second);
    second.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    await second.next(isOp('op-0000000d', 'accepted'));
    fs.writeFileSync(release, '');

    expect(await second.next(isEnd('op-0000000d'))).toMatchObject({ event: 'finished', session: { id: `fake-session-${agent}` }, result: { output: { fixed: true } }, resumed: true });
    expect(received().filter((request) => request.type === 'send_agent_message_request')).toHaveLength(1);
  });

  it('continues the first prompt\'s conversation in a chain, as the lease of a third step names it', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    await runtime.next(isEnd('op-0000000d'));
    const check = await opened(runtime, { attempt: 'a0123abcf', op: 'op-0000000e' });

    runtime.send(fixing(check, 'op-0000000f', review, 'op-0000000b'));

    expect(await runtime.next(isEnd('op-0000000f'))).toMatchObject({ event: 'finished', session: { id: `fake-session-${agent}` }, resumed: true });
    expect(received().filter((request) => request.type === 'send_agent_message_request').map((request) => request.agentId)).toEqual([agent, agent]);
  });

  it('cancels only the continued turn, and leaves the agent to the earlier place, whose close ends it', async () => {
    behave({ output: { verdict: 'request-changes' } });
    const runtime = start();
    await ready(runtime);
    const { review, agent } = await reviewed(runtime);
    const fix = await opened(runtime, { attempt: 'a0123abce', op: 'op-0000000c' });

    behave({ hold_ms: 60_000, output: { fixed: true } });
    runtime.send(fixing(fix, 'op-0000000d', review, 'op-0000000b'));
    await runtime.next(isOp('op-0000000d', 'display'));
    runtime.send({ type: 'cancel', op: 'op-0000000d' });

    expect(await runtime.next(isEnd('op-0000000d'))).toEqual({ op: 'op-0000000d', event: 'cancelled' });
    expect(received().filter((request) => request.type === 'cancel_agent_request')).toEqual([expect.objectContaining({ agentId: agent })]);

    // The later place closes first: the agent stays, in the workspace the earlier place still holds.
    runtime.send({ type: 'close', handle: fix });
    expect(await runtime.next((line) => 'handle' in line && line.handle === fix && 'event' in line && line.event === 'closed')).toEqual({ event: 'closed', handle: fix });
    expect(received().filter((request) => request.type === 'archive_workspace_request' || request.type === 'delete_agent_request')).toEqual([]);
    expect(agentsOf()).toContain(agent);

    runtime.send({ type: 'close', handle: review });
    await runtime.next((line) => 'handle' in line && line.handle === review && 'event' in line && line.event === 'closed');
    expect(received().filter((request) => request.type === 'archive_workspace_request')).toHaveLength(1);
  });
});
