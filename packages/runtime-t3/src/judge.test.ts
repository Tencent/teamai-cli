import fs from 'node:fs';
import path from 'node:path';
import { RuntimeMessageSchema } from '@teamai/runtime-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { signIn, type Connection, type Line } from './testing/harness.js';
import { dir, isNotice, linkTo, start, t3, useT3Runtime, SHIPPED_HOME_ENV } from './testing/suite.js';

describe('teamai-runtime-t3', () => {
  useT3Runtime();

  describe('a confined prompt (a judge)', () => {
    const RUN = 'r5c0de123';
    const OPEN = 'op-000000a0';
    const REPLY = { label: 'pass', reasoning: 'The diff adds the test the rubric asks for.' };
    let evidence: string;

    /** A runtime past init and an open with no view, as teamai opens a confined prompt's place, and its handle. */
    const opened = async (options: Line = {}, mode: 'attended' | 'unattended' = 'attended'): Promise<{ runtime: Connection; handle: string }> => {
      const runtime = start();
      runtime.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode, options: { environment: 'local', ...options } });
      expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true, confinedPrompt: true });
      runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a9e8d7c6', credentials: {} });
      const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
      expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted' && !isNotice(line))).toMatchObject({ event: 'ready' });

      return { runtime, handle: z.string().parse(accepted['handle']) };
    };

    // As teamai-score's judge step renders it: it names the evidence directory and the schema in it by their paths.
    const judge = (handle: string, op: string) => ({
      type: 'prompt', op, handle, env: {}, unset: [], credentials: {}, cwd: evidence,
      lease: {
        step: 'judge', tool: 'claude', model: { name: 'claude-sonnet-5-5' }, permissions: 'approval-required', interactive: false, result: path.join(dir, 'attempt', 'result.json'),
        prompt: `Judge one piece of work against a scorer's rubric. Read only the files under ${evidence}:\nthe transcript, the diff, and evidence.json.\n\nReply with JSON that matches the schema in ${path.join(evidence, 'schema.json')}, and nothing else.`,
      },
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema: { type: 'object', required: ['label'] } },
    });

    /** How the op ended: its first line that neither accepts it nor shows its thread. */
    const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && line['event'] !== 'display' && !isNotice(line), 20_000);

    beforeEach(() => {
      signIn(t3);
      evidence = path.join(dir, 'run', 'score', 'evidence');
      fs.mkdirSync(path.join(evidence, 'session'), { recursive: true });
      fs.writeFileSync(path.join(evidence, 'evidence.json'), JSON.stringify({ skills: ['review'] }));
      fs.writeFileSync(path.join(evidence, 'diff.patch'), '+it("adds the cart test", () => {});\n');
      fs.writeFileSync(path.join(evidence, 'schema.json'), JSON.stringify({ type: 'object' }));
      fs.writeFileSync(path.join(evidence, 'session', 'transcript.jsonl'), '{"type":"user"}\n');
      t3.config({ agent: { reply: `\`\`\`json\n${JSON.stringify(REPLY)}\n\`\`\`` } });
    });

    it('judges in a fresh thread of its own on a read-only copy of the directory, and reports best-effort read access', async () => {
      const { runtime, handle } = await opened();
      const op = 'op-000000a1';

      runtime.send(judge(handle, op));

      const end = await ended(runtime, op);
      expect(RuntimeMessageSchema.safeParse(end).success).toBe(true);
      expect(end).toEqual({
        op, event: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f-]{36}$/) }, result: { output: REPLY },
        confined: { level: 'best-effort', access: 'read' }, unmeasured: { cause: expect.stringContaining('records no request since the step started'), next: 'Retry the step.' },
      });

      const [thread] = t3.threads();
      const launch = t3.calls().find((call) => call.tool === 't3_thread_launch')?.args;
      expect(launch).toMatchObject({ scratch: true, title: `judge · teamai ${RUN}`, runtimeMode: 'auto', clientRequestId: op, modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' } });
      expect(launch).not.toHaveProperty('projectId');
      expect(launch).not.toHaveProperty('message');
      const copy = z.string().parse(thread?.worktreePath);
      expect(copy).not.toBe(evidence);
      expect(thread).toMatchObject({ sees: ['diff.patch', 'evidence.json', 'schema.json', 'session/transcript.jsonl'], couldWrite: false, status: 'completed', settled: false });
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')}`);
      expect(thread?.message).not.toContain(evidence);
      // The prompt may describe a reply of another shape, as teamai-score's names the label's own schema file.
      expect(thread?.message).toContain(`Reply with one JSON value and no other text. teamai checks it against this JSON Schema, so it decides the reply's shape: ${JSON.stringify({ type: 'object', required: ['label'] })}. Where the prompt below asks for a reply of another shape, give that value where this schema places it.`);
    });

    // teamai names the directory in the prompt exactly as it sends confined.dir, a repository path with a space included.
    it('points each mention of the directory at the copy, and leaves a sibling that shares its name', async () => {
      const spaced = path.join(dir, 'my repo', 'score', 'evidence');
      fs.cpSync(evidence, spaced, { recursive: true });
      const { runtime, handle } = await opened();
      const request = judge(handle, 'op-000000a6');

      runtime.send({
        ...request, cwd: spaced, confined: { ...request.confined, dir: spaced },
        lease: { ...request.lease, prompt: `Read only the files under ${spaced}:\nReply with JSON that matches the schema in ${path.join(spaced, 'schema.json')}, and nothing else. Ignore ${spaced}-old and ${spaced}.bak.` },
      });

      expect(await ended(runtime, 'op-000000a6')).toMatchObject({ event: 'finished' });
      const [thread] = t3.threads();
      const copy = z.string().parse(thread?.worktreePath);
      expect(thread?.message).toContain(`Read only the files under ${copy}:`);
      expect(thread?.message).toContain(`the schema in ${path.join(copy, 'schema.json')},`);
      expect(thread?.message).toContain(`Ignore ${spaced}-old and ${spaced}.bak.`);
      expect(thread?.message).not.toContain(`under ${spaced}`);
    });

    it('runs the judge\'s thread in Auto, never in full access, when `runtime_mode` is full-access', async () => {
      const { runtime, handle } = await opened({ runtime_mode: 'full-access' });

      runtime.send(judge(handle, 'op-000000a3'));

      expect(await ended(runtime, 'op-000000a3')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('auto');
    });

    it('runs the judge\'s thread in the tighter `runtime_mode`', async () => {
      const { runtime, handle } = await opened({ runtime_mode: 'approval-required' });

      runtime.send(judge(handle, 'op-000000a2'));

      expect(await ended(runtime, 'op-000000a2')).toMatchObject({ event: 'finished' });
      expect(t3.threads()[0]?.runtimeMode).toBe('approval-required');
    });

    // teamai collects no judge's place, so its thread is settled when the place closes.
    it('removes the copy and settles the thread when teamai closes the judge\'s place', async () => {
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000a3'));
      expect(await ended(runtime, 'op-000000a3')).toMatchObject({ event: 'finished' });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);
      expect(fs.existsSync(copy)).toBe(true);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['event'] === 'closed')).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]?.settled).toBe(true);
      expect(fs.readdirSync(evidence).sort()).toEqual(['diff.patch', 'evidence.json', 'schema.json', 'session']);
    });

    it('keeps the judge\'s copy, its thread\'s folder, while T3 still runs a judge that failed, and removes it once close stopped the thread', async () => {
      t3.config({ agent: { waits: true }, interruptFails: true });
      const { runtime, handle } = await opened({}, 'unattended');
      runtime.send(judge(handle, 'op-000000a8'));
      expect(await ended(runtime, 'op-000000a8')).toMatchObject({ event: 'failed', failure: { code: 'cancel_failed' } });
      const copy = z.string().parse(t3.threads()[0]?.worktreePath);

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toMatchObject({ event: 'close_failed', failure: { code: 'thread_still_runs' } });
      expect(fs.existsSync(copy)).toBe(true);

      t3.config({ interruptFails: false });
      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'closed', handle });
      expect(fs.existsSync(copy)).toBe(false);
      expect(t3.threads()[0]).toMatchObject({ status: 'interrupted', settled: true });
    });

    // A close that comes while T3 launches the judge's thread waits for the launch, then stops what it started.
    it('stops a judge whose launch was still under way when teamai closed its place, and leaves no thread running', async () => {
      t3.config({ agent: { hold: true, reply: JSON.stringify(REPLY) }, launchMs: 3_000 });
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000a9'));
      await runtime.next((line) => line['op'] === 'op-000000a9' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle });

      expect(await runtime.next((line) => line['handle'] === handle, 15_000)).toEqual({ event: 'closed', handle });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(t3.threads()).toHaveLength(1);
      expect(t3.threads()[0]?.status).not.toBe('running');
      runtime.send({ type: 'reattach', handle });
      expect(await runtime.next((line) => line['handle'] === handle)).toEqual({ event: 'gone', handle });
    }, 30_000);

    it('fails a judge whose reply is not JSON, naming its thread by its link', async () => {
      t3.config({ agent: { reply: 'I think it passes.' } });
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a4'));

      expect(await ended(runtime, 'op-000000a4')).toEqual({
        op: 'op-000000a4', event: 'failed',
        failure: { code: 'tool_failed', message: `The T3 thread ${linkTo(t3.threads()[0]?.threadId)} ("judge · teamai r5c0de123") replied with no JSON value.` },
      });
    });

    it('fails judge_copy_failed, naming the directory, when the directory cannot be copied, and briefs no thread', async () => {
      fs.chmodSync(path.join(evidence, 'diff.patch'), 0o000);
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000a7'));

      expect(await ended(runtime, 'op-000000a7')).toEqual({
        op: 'op-000000a7', event: 'failed',
        failure: { code: 'judge_copy_failed', message: expect.stringMatching(new RegExp(`^teamai could not copy ${evidence} into the judge thread's folder \\S+, so the judge did not start: .*EACCES`)) },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
    });

    it("touches nothing in a folder T3 gives a new judge thread that is not empty, and briefs no thread", async () => {
      const member = path.join(dir, 'member-project');
      fs.mkdirSync(member);
      fs.writeFileSync(path.join(member, 'notes.md'), 'the member\'s own file\n');
      t3.config({ scratchFolder: member });
      const { runtime, handle } = await opened();

      runtime.send(judge(handle, 'op-000000b3'));

      expect(await ended(runtime, 'op-000000b3')).toEqual({
        op: 'op-000000b3', event: 'failed',
        failure: { code: 'judge_copy_failed', message: expect.stringContaining(`gave the judge thread a folder that is not empty, ${member}, so teamai copied nothing into it, and the judge did not start.`) },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
      runtime.send({ type: 'close', handle });
      expect(await runtime.next((line) => line['event'] === 'closed' || line['event'] === 'close_failed')).toEqual({ event: 'closed', handle });
      expect(fs.readFileSync(path.join(member, 'notes.md'), 'utf8')).toBe('the member\'s own file\n');
    });

    it("touches nothing in the folder a judge thread was moved to before its restart, and removes only the copy teamai made", async () => {
      t3.config({ sendHangs: true });
      const first = await opened();
      first.runtime.send(judge(first.handle, 'op-000000b4'));
      // The copy is made and the brief is on its way when the runtime stops.
      await expect.poll(() => t3.calls().some((call) => call.tool === 't3_thread_send')).toBe(true);
      await first.runtime.close();
      const [thread] = t3.threads();
      const copy = z.string().parse(thread?.worktreePath);
      const member = path.join(dir, 'member-project');
      fs.mkdirSync(member);
      fs.writeFileSync(path.join(member, 'notes.md'), 'the member\'s own file\n');
      t3.moveThread(z.string().parse(thread?.threadId), member);
      t3.config({ sendHangs: false });

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send(judge(first.handle, 'op-000000b4'));

      expect(await ended(second, 'op-000000b4')).toEqual({
        op: 'op-000000b4', event: 'failed',
        failure: { code: 'judge_copy_failed', message: expect.stringContaining(`now gives the judge thread the folder ${member}, not ${copy}, where teamai made its copy, so teamai copied nothing into it, and the judge did not start.`) },
      });
      second.send({ type: 'close', handle: first.handle });
      expect(await second.next((line) => line['event'] === 'closed' || line['event'] === 'close_failed')).toEqual({ event: 'closed', handle: first.handle });
      expect(fs.readFileSync(path.join(member, 'notes.md'), 'utf8')).toBe('the member\'s own file\n');
      expect(fs.existsSync(copy)).toBe(false);
    });

    it('neither copies nor briefs a judge whose place the person released while T3 launched its thread', async () => {
      t3.config({ launchMs: 12_000 });
      const { runtime, handle } = await opened();
      runtime.send(judge(handle, 'op-000000b2'));
      await runtime.next((line) => line['op'] === 'op-000000b2' && line['event'] === 'accepted');

      runtime.send({ type: 'close', handle, release: true });

      expect(await runtime.next((line) => line['handle'] === handle && line['event'] !== 'accepted' && !isNotice(line), 15_000)).toMatchObject({ event: 'close_failed', handle, failure: { code: 't3_unavailable' } });
      expect(await ended(runtime, 'op-000000b2')).toEqual({
        op: 'op-000000b2', event: 'failed',
        failure: { code: 'released', message: 'teamai released the place while T3 Code launched the judge thread, so it did not brief that thread, and the judge did not start.' },
      });
      expect(t3.threads()[0]?.message).toBeUndefined();
      expect(fs.readdirSync(z.string().parse(t3.threads()[0]?.worktreePath))).toEqual([]);
    }, 40_000);

    it('reconnects to the same judge after its own restart, and copies and briefs it only once', async () => {
      const release = path.join(dir, 'release');
      t3.config({ agent: { release, reply: JSON.stringify(REPLY) } });
      const first = await opened();
      first.runtime.send(judge(first.handle, 'op-000000a5'));
      await first.runtime.next((line) => line['op'] === 'op-000000a5' && line['event'] === 'accepted');
      await expect.poll(() => t3.threads()[0]?.status).toBe('running');
      await first.runtime.close();

      const second = start();
      second.send({ type: 'init', protocol: 1, homeEnv: SHIPPED_HOME_ENV, mode: 'attended', options: { environment: 'local' } });
      await second.next((line) => line['type'] === 'init');
      second.send(judge(first.handle, 'op-000000a5'));
      fs.writeFileSync(release, '');

      expect(await ended(second, 'op-000000a5')).toMatchObject({ event: 'finished', result: { output: REPLY }, confined: { level: 'best-effort', access: 'read' } });
      expect(t3.threads()).toHaveLength(1);
      const briefs = t3.calls().filter((call) => call.tool === 't3_thread_send').map((call) => call.args['message']);
      expect(briefs).toEqual([t3.threads()[0]?.message]);
    });
  });
});
