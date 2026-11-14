import { CANCEL_FAILED, PromptResultSchema, type ConfinedPrompt, type OpId, type PromptRequestSchema, type RuntimeFailure } from '@teamai/runtime-protocol';
import type { OpLedger } from '@teamai/runtime-kit/ledger';
import { redact, redactJson } from '@teamai/shared/redact';
import type { z } from 'zod';
import { placeOf } from './attempt-socket.js';
import { boundedEnds, boundedTail, TAIL_CHARS } from './bounded-tail.js';
import { givenCredentials, type ExecOperations } from './exec.js';
import type { Journal, Outcome } from './journal.js';
import { EVIDENCE_DIR, inEvidenceDir, judgeOf } from './judge.js';
import { inSandbox, maskedAsGiven, rewrittenMasks } from './loopback.js';
import type { Ready } from './runtime.js';
import { runStep, stepToolOf } from './step.js';

// ─── A prompt in a sandbox ───────────────────────────────
//
//  A prompt step runs its tool in the attempt's sandbox, on the attempt's tool home, under teamai's id as an exec does:
//  journaled before it starts, so a repeated id or a reattach answers its end (step.ts launches it).
//
//  A confined prompt is a judge: its place opens with no view, and the prompt runs its tool in a container of its own
//  that sees only the prompt's directory, read-only (judge.ts).
//

/** How much of the end of a judge's stdout is kept: its reply, a JSON verdict, is far shorter. */
const JUDGE_REPLY_CHARS = 1024 * 1024;

type PromptRequest = z.infer<typeof PromptRequestSchema>;

/** Runs prompts over `execs`: a step's in its attempt's sandbox, a judge's in a container `creation` lets a close of its place wait for. */
export function prompts({ journal, ledger, env, execs, creation }: {
  journal: Journal;
  ledger: OpLedger;
  env: NodeJS.ProcessEnv;
  execs: ExecOperations;
  creation: <T>(handle: string, work: Promise<T>) => Promise<T>;
}) {
  const { write } = ledger;
  const { accept, claim, finish, replay } = execs;

  /** Ends `op` failed with `failure`, before this process ran anything of it. */
  const fail = (op: OpId, failure: RuntimeFailure): void => ledger.end({ op, state: 'failed', failure });

  /** Runs a prompt step's tool in the attempt's sandbox, on the attempt's tool home. */
  const step = async (request: PromptRequest, { provider, can, host, instances }: Ready): Promise<void> => {
    const { op, lease } = request;
    const handle = placeOf(request.handle);
    const replayed = replay(op);

    if (replayed) return replayed;

    // Claimed before the first await, as an exec is.
    claim(op);
    const place = journal.place(handle);

    if (place === undefined || place.confined) {
      finish(op, { state: 'failed', failure: place ? { code: 'bad_request', message: `Handle ${handle} is a judge's place, which runs only its confined prompt.` } : { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}.` } });

      return;
    }

    if (lease.interactive) {
      finish(op, { state: 'failed', failure: { code: 'tool_unsupported', message: `Step "${lease.step}" is interactive, and the sandbox runs only headless prompts, where no person can reach the tool. Run it on a runtime that offers hitl, such as tools.` } });

      return;
    }

    const instance = instances.get(lease.tool);
    const extended = instance?.tool ?? lease.tool;
    const profile = stepToolOf(extended);

    if (profile === undefined || !can.tools?.includes(lease.tool)) {
      const stepped = (can.tools ?? []).filter((tool) => stepToolOf(instances.get(tool)?.tool ?? tool) !== undefined);

      finish(op, { state: 'failed', failure: { code: 'tool_unavailable', message: `The sandbox starts no ${lease.tool} prompt step: it starts them only on ${stepped.join(', ') || 'no tool'}. Run the step on a runtime listed after the sandbox in the driver definition.` } });

      return;
    }

    const id = await accept(op, { handle, place, provider });

    if (id === undefined) return;

    // The lease's names win over a credential, and the attempt's tool home over both, as teamai sets an exec runtime's
    // tool on it.
    const given = givenCredentials(request, host);

    const ended = await runStep({
      request, tool: { name: lease.tool, profile }, command: instance?.command ?? extended, provider, id,
      env: { ...given, ...request.env, ...place.toolHome }, masks: maskedAsGiven(request.credentials, given),
    });

    // The end is masked of every value the tool got, a value the sandbox got rewritten included, which teamai cannot
    // know: on the wire and in the journal alike.
    finish(op, journal.isCancelled(op) ? { state: 'cancelled' } : ended);
  };

  /** Runs a judge: its tool in a sandbox of its own that sees only the prompt's directory, read-only. */
  const judgePrompt = async (request: PromptRequest, confined: ConfinedPrompt, { provider, can, host }: Ready): Promise<void> => {
    const { op, lease } = request;
    const handle = placeOf(request.handle);
    const replayed = replay(op);

    if (replayed) return replayed;
    const place = journal.place(handle);

    if (!place?.confined) {
      fail(op, { code: 'bad_request', message: `Prompt ${op} is confined, and handle ${handle} is not a judge's place. Open one with no view first.` });

      return;
    }

    const { judges } = provider;

    if (!judges || !can.confined?.some((offer) => offer.tools.includes(lease.tool))) {
      fail(op, { code: 'tool_unavailable', message: `The sandbox offers no ${lease.tool} judge: it judges on ${can.confined?.flatMap((offer) => offer.tools).join(', ') || 'no tool'}.` });

      return;
    }

    const given = inSandbox(request.credentials, host);
    const chosen = judgeOf(lease.tool, given, env);

    if (!chosen.ok) {
      fail(op, chosen.failure);

      return;
    }

    // Claimed before the first await, as an exec is.
    claim(op);
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const { judge } = chosen;

    // The journal never holds a credential the tool echoed into its reply. Only its strings are masked: a setting such
    // as `1` leaves a reply's numbers as they are.
    // teamai masks the reply with the values it gave; a value the sandbox got rewritten is masked here first.
    const masks = maskedAsGiven(request.credentials, given);
    const rewritten = rewrittenMasks(request.credentials, given);
    const replyMasked = (outcome: Outcome, envSecrets: Record<string, string>): Outcome => (outcome.state === 'finished' ? { ...outcome, result: PromptResultSchema.parse(redactJson(outcome.result, envSecrets)) } : outcome);
    const settle = (outcome: Outcome): void => finish(op, replyMasked(outcome, rewritten), replyMasked(outcome, masks));

    /** The judge's container, or undefined once the prompt settled: its creation failed, or a cancel came meanwhile. */
    const create = async (): Promise<string | undefined> => {
      const created = await judges.create(place, { dir: confined.dir, hosts: judge.hosts });

      if (!created.ok) {
        settle(journal.isCancelled(op) ? { state: 'cancelled' } : { state: 'failed', failure: created.failure });

        return undefined;
      }

      // A place a released close forgot meanwhile stays forgotten, as an open's does.
      if (journal.place(handle) !== undefined) journal.savePlace(handle, { ...place, id: created.id });

      if (!journal.isCancelled(op)) return created.id;
      // A creation a cancel or a close overtook removes the container it made before it settles; the filter and the
      // network stay for close.
      const removed = await provider.destroy(created.id);
      settle(removed.ok ? { state: 'cancelled' } : { state: 'failed', failure: { code: CANCEL_FAILED, message: removed.failure.message } });

      return undefined;
    };

    // A close waits for this to settle, however it does, so the removal after it finds whatever the creation made.
    const id = await creation(handle, create());

    if (id === undefined) return;

    const launch = judge.tool.launch({ ...lease, prompt: inEvidenceDir(lease.prompt, confined.dir) }, confined);
    // Only the credentials the judge's own tool reads, less any the prompt withholds.
    const scoped = Object.fromEntries(Object.entries(judge.credentials).filter(([name]) => !request.unset.includes(name)));
    // A judge's tool may print without end: only the start and the end of its stdout are kept, where its session and
    // its reply are.
    const stdout = boundedEnds({ head: TAIL_CHARS, tail: JUDGE_REPLY_CHARS });
    const stderr = boundedTail(4000);

    const ran = await provider.exec(id, { argv: launch.argv, env: { ...scoped, ...launch.env, ...request.env }, unset: request.unset, cwd: EVIDENCE_DIR }, (stream, data) => {
      if (stream === 'stdout') stdout.push(data);
      else stderr.push(data);
    });

    if (journal.isCancelled(op)) {
      settle({ state: 'cancelled' });

      return;
    }

    if (ran.kind === 'failed') {
      settle({ state: 'failed', failure: ran.failure });

      return;
    }

    const reading = judge.tool.read(stdout.text());
    const masked = (text: string): string => redact(text, { envSecrets: masks, patterns: false });

    if (ran.code !== 0) {
      const lastStderr = stderr.text().trim().split('\n').at(-1) || 'it printed nothing on stderr';
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} exited with code ${ran.code} in the judge's container: ${reading.ok ? lastStderr : reading.message}`) } });

      return;
    }

    if (!reading.ok) {
      settle({ state: 'failed', failure: { code: 'tool_failed', message: masked(`${lease.tool} ended in the judge's container without a reply: ${reading.message}`) } });

      return;
    }

    settle({ state: 'finished', session: { tool: lease.tool, id: reading.session }, result: reading.result, ...(reading.usage && { usage: reading.usage }), confined: { level: 'verified', access: judge.tool.access } });
  };

  return (request: PromptRequest, current: Ready): Promise<void> => execs.guarded(request, () => (request.confined === undefined ? step(request, current) : judgePrompt(request, request.confined, current)));
}
