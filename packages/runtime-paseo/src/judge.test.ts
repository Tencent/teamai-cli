import fs from 'node:fs';
import path from 'node:path';
import type { PromptLeaseSchema, PromptRequestSchema } from '@teamai/runtime-protocol';
import type { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Runtime } from './testing/harness.js';
import { restartDaemon, dir, worktree, daemonState, daemon, RUN, ATTEMPT, behave, received, start, isOp, isEnd, ready, journalFiles, agentsOf, delay, promptRequest, useRuntimeSuite } from './testing/suite.js';

describe('teamai-runtime-paseo', () => {
  useRuntimeSuite();

  describe('a confined prompt, as a judge', () => {
    const SCHEMA = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
    let evidence: string;

    /** Opens a confined prompt's place, with no view of the host. */
    async function openedConfined(runtime: Runtime): Promise<string> {
      runtime.send({ type: 'open', op: 'op-0000000a', run: RUN, attempt: ATTEMPT, credentials: {} });
      const accepted = await runtime.next(isOp('op-0000000a', 'accepted'));

      if (!('handle' in accepted) || !accepted.handle) throw new Error(`no handle in ${JSON.stringify(accepted)}`);

      return accepted.handle;
    }

    const confinedRequest = (handle: string, op: string, confined: Partial<{ level: 'best-effort' | 'verified'; access: 'answer' | 'read' | 'full' }> = {}, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}): z.input<typeof PromptRequestSchema> => ({
      ...promptRequest(handle, op, { step: 'score.judge', prompt: 'Label the pass from the evidence: pass or fail.', ...lease }),
      env: {}, cwd: evidence,
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema: SCHEMA, ...confined },
    });

    beforeEach(() => {
      evidence = path.join(dir, 'run', 'evidence');
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'diff.patch'), '+fix\n');
    });

    it('fails a judge whose daemon restarts before it replies daemon_restarted, leaving the retry to teamai', async () => {
      // An agent cut short by the restart has said nothing yet that parses as a reply.
      behave({ hold_ms: 60_000, reply: 'Reading the diff…' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      const handle = await openedConfined(runtime);
      await runtime.next(isOp('op-0000000a', 'ready'));
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      await expect.poll(() => received().length).toBe(1);

      const port = Number(new URL(daemon.url).port);
      await daemon.close();
      await restartDaemon({ port });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed',
        failure: { code: 'daemon_restarted', message: `The Paseo daemon at ${daemon.url} stopped while the claude agent answered the confined prompt, before it replied.` },
      });
    });

    it('answers with a fresh agent whose cwd is the directory, briefed to read only it, and reports the reply at best-effort, read', async () => {
      behave({ reply: '```json\n{"label": "pass", "reasoning": "tests added"}\n```' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      const handle = await openedConfined(runtime);
      await runtime.next(isOp('op-0000000a', 'ready'));

      runtime.send(confinedRequest(handle, 'op-0000000b'));

      const end = await runtime.next(isEnd('op-0000000b'));
      const [create] = received();
      expect(end).toEqual({
        op: 'op-0000000b', event: 'finished', session: { tool: 'claude', id: `fake-session-${String(create?.agentId)}` },
        result: { output: { label: 'pass', reasoning: 'tests added' } }, confined: { level: 'best-effort', access: 'read' },
      });
      expect(create).toMatchObject({ type: 'agent.create.request', idempotencyKey: 'op-0000000b', config: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'default', cwd: evidence } });
      // Nothing is allowed without asking, and asking ends it.
      expect(create).not.toHaveProperty('config.providerOptions');
      expect(create).not.toHaveProperty('env');
      const prompt = String(create?.initialPrompt);
      expect(prompt).toContain(`Answer from the files in ${evidence} alone. List and read them with your file tools, such as Glob, Grep and Read.`);
      expect(prompt).toContain('Change no file and run no shell command');
      expect(prompt).toContain('Label the pass from the evidence: pass or fail.');
      expect(prompt).toContain(JSON.stringify(SCHEMA));
      // The step's prompt may name another schema file; the one the request carries decides the reply's shape.
      expect(prompt).toContain('Where the prompt above names another schema, this one decides the shape of your reply.');
      expect(fs.readdirSync(evidence)).toEqual(['diff.patch']);
    });

    it('runs an OpenCode judge in its plan mode, which asks before it edits or runs anything', async () => {
      behave({ reply: '{"label": "fail"}' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'opencode', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'opencode' }, result: { output: { label: 'fail' } }, confined: { level: 'best-effort', access: 'read' } });
      expect(received()).toMatchObject([{ config: { provider: 'opencode', modeId: 'plan', cwd: evidence } }]);
    });

    it('refuses a judge on a tool it did not offer, saying why, and creates no agent', async () => {
      behave({ models: { claude: ['claude-opus-5-5'], codex: ['gpt-6.1-sol'] }, codex_login: 'signed_out' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'codex', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({
        event: 'failed', failure: { code: 'tool_unavailable', message: 'teamai-runtime-paseo did not offer codex: signed out; run `codex login` on the daemon\'s host.' },
      });
      expect(received()).toEqual([]);
    });

    it('runs a Codex judge in its auto mode with a read-only sandbox, since each mode Paseo lists for Codex writes without asking', async () => {
      behave({ reply: '{"label": "pass"}', codex_login: 'signed_in' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', {}, { tool: 'codex', model: undefined }));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', session: { tool: 'codex' }, result: { output: { label: 'pass' } }, confined: { level: 'best-effort', access: 'read' } });
      // `auto` asks before anything its sandbox does not allow, which ends the prompt; the sandbox reads and writes nothing.
      expect(received()).toMatchObject([{ config: { provider: 'codex', modeId: 'auto', cwd: evidence, providerOptions: { sandbox_mode: 'read-only' } } }]);
      // Codex has no file tools of its own: it reads with shell commands, which its sandbox runs without asking.
      const prompt = String(received()[0]?.initialPrompt);
      expect(prompt).toContain(`Answer from the files in ${evidence} alone. List and read them with read-only shell commands, such as ls, cat and rg, which your sandbox runs without asking.`);
      expect(prompt).toContain('Change no file and use no other tool: asking for a permission ends this run.');
      expect(prompt).not.toContain('Glob');
    });

    it.each([
      ['a verified level, which it does not reach', { level: 'verified' as const }, {}, 'confined_level', 'teamai-runtime-paseo keeps a confined prompt best-effort'],
      ['a tool Paseo does not run', {}, { tool: 'codebuddy', model: undefined }, 'tool_unavailable', 'teamai-runtime-paseo runs a confined prompt on claude, codex, opencode or the team\'s instances of them, not codebuddy'],
    ])('refuses %s, and creates no agent', async (_, confined, lease, code, message) => {
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b', confined, lease));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code, message: expect.stringContaining(message) } });
      expect(received()).toEqual([]);
    });

    it('ends a judge that asks for permission, even in an attended run, and stops its agent', async () => {
      behave({ ask_permission: true, reply: '{"label": "pass"}' });
      const runtime = start();
      await ready(runtime, { mode: 'attended' });
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed',
        failure: { code: 'tool_failed', message: 'The claude agent asked for permission (Run npm test) in Paseo mode default. A confined prompt only reads its directory, so it ends rather than ask.' },
      });
      expect(received().map((request) => request.type)).toEqual(['agent.create.request', 'cancel_agent_request']);
    });

    it('reads the JSON answer of a judge that explains itself around it', async () => {
      behave({ reply: 'I read the diff.\n\n```json\n{"label": "pass"}\n```\n\nThe tests cover the change.' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'finished', result: { output: { label: 'pass' } } });
    });

    it('fails a judge whose reply is no JSON value', async () => {
      behave({ reply: 'The pass looks good to me.' });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'failed', failure: { code: 'tool_failed', message: 'The claude agent replied with no JSON value.' } });
    });

    it('fails a judge whose agent replied that it hit its usage limit usage_limited, rather than blame its reply', async () => {
      behave({ reply: "You've hit your limit · resets 3pm (Europe/Madrid)" });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({
        op: 'op-0000000b', event: 'failed', failure: { code: 'usage_limited', message: "The claude agent hit its usage limit in Paseo: You've hit your limit · resets 3pm (Europe/Madrid)" },
      });
    });

    it('labels a judge\'s agent with the Paseo agent the run was started from, and briefs it as any judge', async () => {
      behave({ reply: '{"label": "pass"}' });
      const runtime = start({ PASEO_AGENT_ID: 'agent-the-run-started-from' });
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));
      await runtime.next(isEnd('op-0000000b'));

      const create = received().find((request) => request.type === 'agent.create.request');
      expect(create?.labels).toMatchObject({ 'teamai-parent': 'agent-the-run-started-from' });
      expect(String(create?.initialPrompt)).not.toContain('started from the Paseo agent');
    });

    it('archives the judge\'s Paseo workspace on close, and leaves the directory in place', async () => {
      behave({ reply: '{"label": "pass"}' });
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isEnd('op-0000000b'));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      expect(received().filter((request) => request.type === 'archive_workspace_request')).toHaveLength(1);
      expect(fs.readdirSync(evidence)).toEqual(['diff.patch']);
    });

    it('accepts a judge before Paseo opens its directory, and a cancel then ends it cancelled with no agent ever created', async () => {
      behave({ reply: '{"label": "pass"}', open_ms: 3_000 });
      const runtime = start();
      await ready(runtime);
      runtime.send(confinedRequest(await openedConfined(runtime), 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      const asked = Date.now();

      runtime.send({ type: 'cancel', op: 'op-0000000b' });

      expect(await runtime.next(isEnd('op-0000000b'))).toEqual({ op: 'op-0000000b', event: 'cancelled' });
      expect(Date.now() - asked).toBeLessThan(10_000);
      await delay(4_000);
      expect(received()).toEqual([]);
      expect(agentsOf()).toEqual([]);
    });

    it('closes a judge\'s place while Paseo opens its directory only once the judge ended cancelled, archives that workspace, and keeps nothing', async () => {
      behave({ reply: '{"label": "pass"}', open_ms: 3_000 });
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      const events = runtime.lines.map((line) => ('event' in line ? `${'op' in line ? line.op : 'handle'} ${line.event}` : ''));
      expect(events.indexOf('op-0000000b cancelled')).toBeGreaterThan(-1);
      expect(events.indexOf('op-0000000b cancelled')).toBeLessThan(events.indexOf('handle closed'));
      await delay(1_000);
      expect(received().map((request) => request.type)).toEqual(['archive_workspace_request']);
      expect(agentsOf()).toEqual([]);
      expect(journalFiles()).toEqual([]);
    });

    it.each([
      ['lists its models', { models_ms: 3_000 }, ['archive_workspace_request']],
      ['creates its agent', { create_ms: 3_000 }, ['agent.create.request', 'archive_workspace_request']],
    ] as const)('closes a judge\'s place while Paseo %s only once that ended, and leaves no agent running', async (_, slow, requests) => {
      const runtime = start();
      await ready(runtime);
      const handle = await openedConfined(runtime);
      // The judge's directory is already its place's workspace, so the launch goes straight on.
      runtime.send(confinedRequest(handle, 'op-0000000c'));
      await runtime.next(isEnd('op-0000000c'));
      behave({ reply: '{"label": "pass"}', hold_ms: 60_000, ...slow });
      runtime.send(confinedRequest(handle, 'op-0000000b'));
      await runtime.next(isOp('op-0000000b', 'accepted'));
      const sent = received().length;
      // The close comes once the launch reached the slow call: the create crossed the wire, or the listing is still held.
      await expect.poll(() => received().length).toBe(sent + requests.length - 1);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => 'event' in line && !('op' in line) && ['closed', 'close_failed'].includes(line.event))).toEqual({ event: 'closed', handle });
      await delay(4_000);
      // The judge ended once, before its place closed.
      expect(runtime.lines.filter(isEnd('op-0000000b'))).toHaveLength(1);
      expect(runtime.lines.findIndex(isEnd('op-0000000b'))).toBeLessThan(runtime.lines.findIndex((line) => 'event' in line && line.event === 'closed'));
      expect(received().slice(sent).map((request) => request.type)).toEqual(requests);
      const kept = JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8')) as { agents: Record<string, { status: string }> };
      expect(Object.values(kept.agents).filter((agent) => agent.status === 'running')).toEqual([]);
      expect(journalFiles()).toEqual([]);
    });

    it('refuses a plain prompt in a confined place, and a confined prompt in a worktree place', async () => {
      const runtime = start();
      await ready(runtime);
      const confinedPlace = await openedConfined(runtime);
      runtime.send(promptRequest(confinedPlace, 'op-0000000b'));
      expect(await runtime.next(isEnd('op-0000000b'))).toMatchObject({ event: 'failed', failure: { code: 'unknown_handle' } });

      runtime.send({ type: 'open', op: 'op-0000000c', run: RUN, attempt: 'a4567cdef', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} } });
      const accepted = await runtime.next(isOp('op-0000000c', 'accepted'));
      runtime.send(confinedRequest('handle' in accepted ? String(accepted.handle) : '', 'op-0000000d'));
      expect(await runtime.next(isEnd('op-0000000d'))).toMatchObject({ event: 'failed', failure: { code: 'unknown_handle' } });
      expect(received()).toEqual([]);
    });
  });
});
