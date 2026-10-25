/** The conformance scenario language, the driver profiles it speaks as, and the interpreter that runs a scenario. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveRunMode } from '../launch-context.js';
import { agentEvidence } from './attempt-marker.js';
import { commandOutputs, type NextPrepare, type WorkflowClient } from './protocol.js';
import type { DriverCan } from './requirements.js';
import { callerProvenance } from './run-controls.js';
import { AttemptIdSchema } from './store.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from './types.js';
import { git } from './worktree.js';

export const PARALLEL_ROOTS = `schemaVersion: v1alpha1
name: build
description: Two roots a driver runs in parallel, then a join.
steps:
  - id: a
    command: echo a
  - id: b
    needs: []
    command: echo b
  - id: join
    needs: [a, b]
    command: echo join
`;

export function controlsYaml(steps: string): string {
  return `schemaVersion: v1alpha1\nname: build\ndescription: Exercise manual controls.\nsteps:\n${steps}\n`;
}

export interface ConformanceScenario {
  name: string;
  workflowName: string;
  yaml: string;
  /** Other workflow files the scenario runs, by name. */
  workflows?: Record<string, string>;
  /** Variables in the environment of every teamai process the scenario runs. */
  env?: Record<string, string>;
  operations: ConformanceOperation[];
  /** Expected fields in the persisted run after all operations. */
  expectState?: Record<string, unknown>;
  /** Expected fields in the run's queued end record after all operations. */
  expectRecord?: Record<string, unknown>;
  /**
   * By saved lease: the step it leased reported `changes` on the lease's branch, `changes.to` is that branch's tip on
   * origin, and the tip holds these files. Needs a runner with a `place`.
   */
  expectPushed?: Record<string, Record<string, string>>;
  /**
   * The profiles designed to refuse what the scenario needs of the driver under test, such as env for a prompt step
   * under `skill`. Under one of them the first `next` saved as `at` answers `expect`, and the scenario ends there: its
   * end expectations are for the profiles that hold it.
   */
  refusedBy?: Partial<Record<DriverProfile, ConformanceRefusal>>;
}

/** Where a profile refuses a scenario, and the answer it gets there instead. */
export interface ConformanceRefusal {
  at: string;
  expect: Record<string, unknown>;
}

/** The same refusal from both skill profiles: each declares a person, and neither declares tokens or turns. */
export function bothSkillProfiles<T>(refusal: T): { skill: T; 'skill-bare': T } {
  return { skill: refusal, 'skill-bare': refusal };
}

/**
 * The kinds of driver a scenario speaks as. Each sends the driver identity of its `kind`, so a lease one holds is
 * another kind's to the rest, and each declares what it can do in `driver.can`. A local driver's `hitl` comes from the
 * operation, since it has a person only when it runs in a terminal.
 */
export const DRIVER_PROFILES = {
  /** The in-process driver `workflow start --driver local` and `workflow resume` run. */
  local: { kind: 'local', can: { workspace: ['read-only', 'new', 'continue'], env: true, tokens: true, max_turns: true, setup: true } },
  /** An agent session that runs the protocol itself, with a person in the chat. */
  session: { kind: 'session', can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } },
  /** A program that speaks only the CLI JSON protocol, such as an IDE or an orchestrator. */
  external: { kind: 'external', can: { workspace: ['read-only', 'new', 'continue'] } },
  /** The skill driver, `workflow ... --driver skill`, as it declares itself on every `next`. */
  skill: {
    kind: 'skill',
    can: { hitl: true, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: 'commands', tokens: false, max_turns: false, setup: true },
  },
  /** The skill driver's identity declaring only a person and workspaces, so a run owes it no env, setup or tokens. */
  'skill-bare': { kind: 'skill', can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } },
} as const satisfies Record<string, { kind: string; can: DriverCan }>;
export type DriverProfile = keyof typeof DRIVER_PROFILES;

/** The drivers under test every protocol, place, git and limits scenario runs as. */
export const DRIVERS_UNDER_TEST = ['local', 'skill', 'skill-bare'] as const satisfies readonly DriverProfile[];

/** The identity a scenario's `as` profile sends. */
export function profileDriver(profile: DriverProfile): DriverIdentity {
  return { kind: DRIVER_PROFILES[profile].kind, machine: 'conformance', workspace: '/work' };
}

/**
 * `running` and `cancelled` name leases that earlier operations saved; `cancelled` must match exactly.
 * `absent` lists fields the lease must not carry. `as` picks the driver profile, `local` when omitted, which stands for
 * the driver under test: the profile a runner runs the scenario under replaces it. `can` replaces the keys of the
 * profile's `can` it names, and `hitl` sets it for a profile that does not decide it.
 * `state` is matched against the persisted run after the operation. `advance` moves the clock the engine reads.
 * `prepare` asks `next` to prepare the lease's place; `promptHas` lists text its prompt contains. With `prepare`,
 * `attempt` names the saved lease whose attempt `next` prepares, which it must answer with, and `adopt` the `host`
 * place it prepares it in, where the lease must run. `host` makes a place as a host would, at `name` beside the
 * checkout: a worktree on the workspace branch of `lease` (`on: 'branch'`), detached at its start (`'start'`), or on
 * another branch made there (`'other'`), or a repository of its own (`'foreign'`), with `files` written in it. `edit`
 * writes files in a prepared lease's place, and `files` checks them there, or in the checkout without a lease: `null`
 * is a path that does not exist.
 */
export type ConformanceOperation =
  | {
    kind: 'next'; saveAs: string; as?: DriverProfile; can?: DriverCan; running?: string[]; canTakeLease?: boolean; hitl?: boolean; claim?: boolean; autoApprove?: boolean;
    base?: { ref?: string; commit: string }; prepare?: true; attempt?: string; adopt?: string; promptHas?: string[];
    cancelled?: string[]; absent?: string[]; expect: Record<string, unknown>; state?: Record<string, unknown>;
  }
  | { kind: 'host'; name: string; lease: string; on: 'branch' | 'start' | 'other' | 'foreign'; files?: Record<string, string> }
  | { kind: 'edit'; lease: string; files: Record<string, string> }
  | { kind: 'files'; lease?: string; expect: Record<string, string | null> }
  /**
   * Starts another run of `workflow`, the scenario's own when omitted, as `workflow start` with `driver` and `--confirmed`
   * does, from a process whose environment adds `env` to the scenario's.
   */
  | { kind: 'start'; workflow?: string; driver?: StartDriver; confirmed?: boolean; env?: Record<string, string>; expect: Record<string, unknown> }
  /** `env`: variables the answering process has beside the scenario's, such as an agent session's. */
  | { kind: 'respond'; step: string; choice: string; as?: DriverProfile; note?: string; pass?: number; json?: unknown; env?: Record<string, string>; expect: Record<string, unknown> }
  | { kind: 'retry'; step: string; expect: Record<string, unknown> }
  | { kind: 'cancel'; step?: string; expect: Record<string, unknown> }
  | { kind: 'advance'; ms: number }
  | {
    kind: 'report';
    lease?: string;
    as?: DriverProfile;
    attempt?: string;
    revision?: number;
    /** Fields added to the `changes` the harness reports from the workspace of this operation's saved lease. */
    changes?: Record<string, unknown>;
    body: Record<string, unknown>;
    expect: Record<string, unknown>;
  };

const SavedLeaseSchema = z.object({
  attempt: z.string(), revision: z.number(), step: z.string(), cwd: z.string().optional(), prompt: z.string().optional(),
  workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }), start: z.object({ commit: z.string() }) }).optional(),
});
type SavedLease = z.infer<typeof SavedLeaseSchema>;

/** The `changes` a report of `lease` carries: the branch and base of its workspace, and the scenario's own fields. */
function leasedChanges(lease: SavedLease | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  if (!lease?.workspace) throw new Error('A report with changes needs a saved lease that ran in a workspace');
  return { branch: lease.workspace.branch, base: lease.workspace.base.commit, from: 'a'.repeat(40), to: 'b'.repeat(40), commits: [], ...fields };
}

/** The assertions a runner lends the interpreter, so the scenarios do not depend on a test framework. */
export type ConformanceExpect = (actual: unknown, message?: string) => {
  toMatchObject(expected: Record<string, unknown>): void;
  toEqual(expected: unknown): void;
  not: { toHaveProperty(property: string): void };
};

/** The driver a `workflow start` names: none, the local driver, or the skill driver. */
export type StartDriver = 'local' | 'skill';

/**
 * The protocol calls a scenario makes, which the in-process client and the built CLI both answer. `start` and
 * `respond` run in a process of their own, whose environment adds `env` to the scenario's; `respond`'s has no terminal.
 */
export type ConformanceClient = Pick<WorkflowClient, 'next' | 'report' | 'retry' | 'cancel'> & {
  // Properties, not methods, so a WorkflowClient's start and respond are not taken for these.
  // `checkout` is the in-process start's: the CLI always starts from its cwd.
  start: (name: string, options?: { driver?: StartDriver; confirmed?: boolean; env?: Record<string, string>; checkout?: string }) => Promise<WorkflowEnvelope>;
  respond: (runId: string, step: string, choice: string, options: { note?: string; pass?: number; json?: unknown; env?: Record<string, string> }) => Promise<WorkflowEnvelope>;
};

/**
 * The in-process client as a scenario's. `start` is the protocol's start whichever driver it names, since every driver
 * starts through it; `respond` answers as a process without a terminal would; both with `env` added to this one's.
 */
export function inProcessConformanceClient(client: WorkflowClient): ConformanceClient {
  return {
    start: (name, { env, confirmed, checkout } = {}) => client.start(name, {
      ...(checkout !== undefined ? { checkout } : {}), caller: { evidence: agentEvidence({ ...process.env, ...env }), confirmed: confirmed === true, mode: resolveRunMode({ ...process.env, ...env }) },
    }),
    next: (runId, body, options) => client.next(runId, body, options),
    report: (runId, body, options) => client.report(runId, body, options),
    retry: (runId, step) => client.retry(runId, step),
    cancel: (runId, step) => client.cancel(runId, step),
    respond: (runId, step, choice, { env, json, ...answer }) => client.respond(runId, step, choice, {
      ...answer, via: { kind: 'process', caller: callerProvenance({ ...process.env, ...env }, { isTTY: false }), json },
    }),
  };
}

/** What a runner provides: its client, how it reads the run file and the queued end record, and how it moves the clock. */
export interface ConformanceRunner {
  client: ConformanceClient;
  readRun(runId: string): Promise<RunState>;
  /** The run's queued end record, undefined while it has none. */
  readEndRecord(runId: string): Promise<unknown>;
  advance(ms: number): Promise<void>;
  expect: ConformanceExpect;
  /** The git checkout the run starts in and the bare origin it pushes to, for scenarios that check places. */
  place?: { checkout: string; origin: string };
}

async function readOrNull(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) return null;
  return stat.isDirectory() ? '' : fs.readFile(file, 'utf8');
}

/** Whether an operation's `as` stands for the driver under test. */
const standsForDriverUnderTest = (as: DriverProfile | undefined): as is 'local' | undefined => as === undefined || as === 'local';

/**
 * Whether the answers `scenario` gets can differ by the profile it runs under: a profile refuses it, or one of its
 * operations speaks as the driver under test. A scenario that does neither makes the same calls under every profile.
 */
export function speaksAsDriverUnderTest(scenario: ConformanceScenario): boolean {
  if (scenario.refusedBy !== undefined) return true;
  return scenario.operations.some((operation) => {
    switch (operation.kind) {
      case 'next':
      case 'report':
        return standsForDriverUnderTest(operation.as);
      case 'respond':
        return operation.as !== undefined && standsForDriverUnderTest(operation.as) && !('json' in operation);
      case 'host':
      case 'edit':
      case 'files':
      case 'start':
      case 'retry':
      case 'cancel':
      case 'advance':
        return false;
      default: {
        const unhandled: never = operation;
        throw new Error(`unknown conformance operation ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

/**
 * Runs one scenario as a driver that speaks only the protocol: it keeps each lease's attempt and revision, and lists
 * the attempts an operation names in `running`. `profile` is the driver under test, which every operation that speaks
 * as `local` speaks as.
 */
export async function runConformanceScenario(scenario: ConformanceScenario, runner: ConformanceRunner, profile: DriverProfile): Promise<void> {
  const { client, expect } = runner;
  const speaker = (as: DriverProfile | undefined): DriverProfile => (standsForDriverUnderTest(as) ? profile : as);
  const started = await client.start(scenario.workflowName);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const leases = new Map<string, SavedLease>();
  const attemptOf = (name: string): string | undefined => leases.get(name)?.attempt;
  const placeOf = (name: string | undefined): string => {
    const place = runner.place;
    if (!place) throw new Error('A scenario that checks places needs a runner with a place');
    if (name === undefined) return place.checkout;
    const cwd = leases.get(name)?.cwd;
    if (cwd === undefined) throw new Error(`Lease ${name} was not prepared`);
    return cwd;
  };
  const refusal = scenario.refusedBy?.[profile];
  let refused = false;
  const hosts = new Map<string, string>();
  const hostOf = (name: string): string => {
    const dir = hosts.get(name);
    if (dir === undefined) throw new Error(`No host operation made place ${name}`);
    return dir;
  };
  for (const operation of scenario.operations) {
    switch (operation.kind) {
      case 'next': {
        const as = speaker(operation.as);
        const { can } = DRIVER_PROFILES[as];
        const prepare: NextPrepare | undefined = operation.prepare && operation.attempt !== undefined
          ? { attempt: AttemptIdSchema.parse(attemptOf(operation.attempt)), ...(operation.adopt !== undefined ? { adopt: hostOf(operation.adopt) } : {}) }
          : operation.prepare;
        const envelope = await client.next(runId, {
          driver: { ...profileDriver(as), can: { ...(operation.hitl !== undefined ? { hitl: operation.hitl } : {}), ...can, ...operation.can } },
          ...(operation.running ? { running: operation.running.map(attemptOf) } : {}),
          ...(operation.canTakeLease !== undefined ? { canTakeLease: operation.canTakeLease } : {}),
          ...(operation.claim !== undefined ? { claim: operation.claim } : {}),
          ...(operation.autoApprove !== undefined ? { autoApprove: operation.autoApprove } : {}),
          ...(operation.base ? { base: operation.base } : {}),
        }, prepare ? { prepare } : undefined);
        if (refusal?.at === operation.saveAs) {
          expect(envelope, `${profile} refuses the scenario at ${operation.saveAs}`).toMatchObject(refusal.expect);
          refused = true;
          break;
        }
        expect(envelope).toMatchObject(operation.expect);
        if (operation.state) expect(await runner.readRun(runId)).toMatchObject(operation.state);
        if ('data' in envelope && envelope.data.hitl) {
          const hitl = envelope.data.hitl as { step: string; pass: number; respond: string };
          expect(hitl.respond).toEqual(`teamai workflow respond ${runId} ${hitl.step} <option> --pass ${hitl.pass}`);
        }
        if (operation.cancelled) expect('data' in envelope && envelope.data.cancelled).toEqual(operation.cancelled.map(attemptOf));
        for (const field of operation.absent ?? []) expect('data' in envelope ? envelope.data.lease : undefined).not.toHaveProperty(field);
        if ('data' in envelope && envelope.data.lease) {
          const lease = SavedLeaseSchema.parse(envelope.data.lease);
          for (const text of operation.promptHas ?? []) expect(lease.prompt?.includes(text), `the prompt of ${operation.saveAs} has ${text}`).toEqual(true);
          if (operation.attempt !== undefined) expect(lease.attempt, `next prepared the attempt of ${operation.attempt}`).toEqual(attemptOf(operation.attempt));
          if (operation.adopt !== undefined) expect(lease.cwd, `the lease runs in host place ${operation.adopt}`).toEqual(hostOf(operation.adopt));
          leases.set(operation.saveAs, lease);
        }
        break;
      }
      case 'host': {
        const checkout = placeOf(undefined);
        const workspace = leases.get(operation.lease)?.workspace;
        if (!workspace) throw new Error(`Host place ${operation.name} needs lease ${operation.lease} with a workspace`);
        const dir = path.join(path.dirname(checkout), 'hosts', operation.name);
        await fs.mkdir(path.dirname(dir), { recursive: true });
        const { branch, start: { commit } } = workspace;
        const steps: Array<[string, string[]]> = operation.on === 'foreign'
          ? [[path.dirname(dir), ['init', '-q', dir]], [dir, ['-c', 'user.name=Host', '-c', 'user.email=host@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'host']]]
          : [[checkout, ['worktree', 'add', '-q', ...{ branch: ['-b', branch], start: ['--detach'], other: ['-b', `host/${operation.name}`] }[operation.on], dir, commit]]];
        for (const [cwd, args] of steps) {
          const made = await git(cwd, args);
          if (made.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${made.stderr}`);
        }
        for (const [file, text] of Object.entries(operation.files ?? {})) await fs.writeFile(path.join(dir, file), text);
        hosts.set(operation.name, dir);
        break;
      }
      case 'edit':
        for (const [file, text] of Object.entries(operation.files)) await fs.writeFile(path.join(placeOf(operation.lease), file), text);
        break;
      case 'files':
        for (const [file, text] of Object.entries(operation.expect)) {
          expect(await readOrNull(path.join(placeOf(operation.lease), file)), file).toEqual(text);
        }
        break;
      case 'start': {
        const { workflow, driver, confirmed, env } = operation;
        expect(await client.start(workflow ?? scenario.workflowName, { driver, confirmed, env })).toMatchObject(operation.expect);
        break;
      }
      case 'respond': {
        const json = 'json' in operation || !operation.as ? operation.json : { driver: profileDriver(speaker(operation.as)) };
        expect(await client.respond(runId, operation.step, operation.choice, { note: operation.note, pass: operation.pass, json, env: operation.env })).toMatchObject(operation.expect);
        break;
      }
      case 'retry':
        expect(await client.retry(runId, operation.step)).toMatchObject(operation.expect);
        break;
      case 'cancel':
        expect(await client.cancel(runId, operation.step)).toMatchObject(operation.expect);
        break;
      case 'advance':
        await runner.advance(operation.ms);
        break;
      case 'report': {
        const lease = operation.lease ? leases.get(operation.lease) : undefined;
        expect(await client.report(runId, {
          attempt: operation.attempt ?? lease?.attempt,
          revision: operation.revision ?? lease?.revision,
          driver: profileDriver(speaker(operation.as)),
          ...operation.body,
          ...(operation.changes ? { changes: leasedChanges(lease, operation.changes) } : {}),
        })).toMatchObject(operation.expect);
        break;
      }
      default: {
        const unhandled: never = operation;
        throw new Error(`unknown conformance operation ${JSON.stringify(unhandled)}`);
      }
    }
    if (refused) break;
  }
  if (refusal && !refused) throw new Error(`The scenario says ${profile} refuses it at ${refusal.at}, but no next saved as ${refusal.at} ran`);
  if (!refused) await expectEnd(scenario, runner, runId, leases);
  const secrets = Object.entries(scenario.env ?? {});
  if (secrets.length === 0) return;
  const stored = JSON.stringify(await runner.readRun(runId));
  const record = JSON.stringify(await runner.readEndRecord(runId)) ?? '';
  for (const [name, value] of secrets) {
    expect(stored.includes(value), `the run file holds the value of ${name}`).toEqual(false);
    expect(record.includes(value), `the end record holds the value of ${name}`).toEqual(false);
  }
}

/** The end expectations of a scenario that held: the persisted run, its end record, and what origin got. */
async function expectEnd(scenario: ConformanceScenario, runner: ConformanceRunner, runId: string, leases: Map<string, SavedLease>): Promise<void> {
  const { expect } = runner;
  if (scenario.expectState) expect(await runner.readRun(runId)).toMatchObject(scenario.expectState);
  if (scenario.expectRecord) expect(await runner.readEndRecord(runId)).toMatchObject(scenario.expectRecord);
  for (const [name, files] of Object.entries(scenario.expectPushed ?? {})) {
    const origin = runner.place?.origin;
    const lease = leases.get(name);
    if (!origin || !lease?.workspace) throw new Error(`expectPushed needs a runner with a place and lease ${name} with a workspace`);
    const step = (await runner.readRun(runId)).steps.find((item) => item.id === lease.step);
    const changes = step && 'changes' in step ? step.changes : undefined;
    expect(changes?.branch, `${lease.step} reported changes on its branch`).toEqual(lease.workspace.branch);
    const tip = (await git(origin, ['rev-parse', `refs/heads/${lease.workspace.branch}`])).stdout.trim();
    expect(tip, `${lease.workspace.branch} on origin is the commit ${lease.step} reported`).toEqual(changes?.to);
    for (const [file, text] of Object.entries(files)) expect((await git(origin, ['show', `${tip}:${file}`])).stdout).toEqual(text);
  }
}

const PreparedCommandSchema = z.object({
  attempt: z.string(), revision: z.number(), step: z.string(), command: z.string(), cwd: z.string(), env: z.record(z.string()).optional(),
});

/** The codes a `next --prepare` answers once it settled the attempt it could not prepare `failed`. */
const PREPARE_FAILURES = new Set(['setup_failed', 'workspace_base', 'merge_conflict']);

function runCommand(lease: z.infer<typeof PreparedCommandSchema>): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(lease.command, { shell: true, cwd: lease.cwd, env: { ...process.env, ...lease.env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => resolve({ exitCode: 127, stdout }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}

/**
 * Drives run `runId` to its end as `driver` declaring `can`, through the protocol as the skill driver's runners do:
 * each lease is prepared in its place, its command run there, and its exit reported, one step at a time. With `claim`,
 * the first call claims the run. Answers the call that ended the run.
 */
export async function driveByProtocol(input: {
  client: Pick<ConformanceClient, 'next' | 'report'>; runId: string; driver: DriverIdentity; can: DriverCan; claim?: true;
}): Promise<WorkflowEnvelope> {
  const { client, runId, driver, can } = input;
  for (let calls = 0; calls < 20; calls += 1) {
    const answer = await client.next(runId, { driver: { ...driver, can }, ...(input.claim && calls === 0 ? { claim: true } : {}) }, { prepare: true });
    if ('error' in answer) {
      if (PREPARE_FAILURES.has(answer.error.code)) continue;
      return answer;
    }
    if (answer.data.done !== undefined) return answer;
    const lease = PreparedCommandSchema.safeParse(answer.data.lease);
    if (!lease.success) throw new Error(`Run ${runId} answered neither a prepared command nor its end: ${JSON.stringify(answer)}`);
    const { attempt, revision, step } = lease.data;
    const { exitCode, stdout } = await runCommand(lease.data);
    const outputs = commandOutputs(stdout);
    const reported = await client.report(runId, {
      attempt, revision, driver, outcome: exitCode === 0 ? 'success' : 'failed', exitCode,
      ...(outputs !== undefined ? { outputs } : {}), ...(exitCode !== 0 ? { message: `command exited with status ${exitCode}` } : {}),
    });
    if ('error' in reported) throw new Error(`The report of ${step} was refused: ${reported.error.message}`);
  }
  throw new Error(`Run ${runId} did not end within 20 calls`);
}

/**
 * One step of a judge lease scenario. `take` and `renew` are `score --next`: `take` lists nothing in running, or the
 * lease it took last with `running`; `renew` lists that lease, and `canTakeLease: false` asks it to take nothing.
 * `next` is a workflow next that lists that lease in its running, which leaves the run as it was. `at` sets the clock.
 */
export type JudgeConformanceOperation =
  | { kind: 'take'; at: string; running?: true; expect: Record<string, unknown> }
  | { kind: 'renew'; at: string; canTakeLease?: false; expect: Record<string, unknown> }
  | { kind: 'next'; expect: Record<string, unknown> }
  | { kind: 'report'; expect: Record<string, unknown> }
  | { kind: 'submit'; expect: Record<string, unknown> }
  | { kind: 'idle'; at: string; expect: Record<string, unknown> };

/** A run of workflow `judged` whose scored pass a driver runs to its end, then the judge work of that pass. */
export interface JudgeConformanceScenario {
  name: string;
  yaml: string;
  /** The scorer files by name. */
  scorers: Record<string, string>;
  operations: JudgeConformanceOperation[];
  /** The profiles designed to refuse judge work, each with what its first `score --next` answers, where the scenario ends. */
  refusedBy?: Partial<Record<JudgeProfile, Record<string, unknown>>>;
}

/** The drivers every judge scenario runs as. */
export const JUDGES_UNDER_TEST = ['external', 'skill', 'skill-no-judge'] as const;
export type JudgeProfile = typeof JUDGES_UNDER_TEST[number];

const CLAUDE_JUDGE: { isolation: 'verified'; tools: string[] } = { isolation: 'verified', tools: ['claude'] };

/**
 * The drivers a judge scenario speaks as: the workflow driver profile `as` runs the scored pass, then asks
 * `score --next` for judge work with the judge it declares, if any. `ownRun` names the run, so it takes that run's
 * judge work only.
 */
export const JUDGE_PROFILES: Record<JudgeProfile, { as: DriverProfile; judge?: { isolation: 'verified'; access?: 'read'; tools: string[] }; ownRun: boolean }> = {
  /** A program that judges any pass of the install with a verified Claude Code. */
  external: { as: 'external', judge: CLAUDE_JUDGE, ownRun: false },
  /** The skill driver, which judges its own run with the confined judge of its session's tool, found verified here, which only reads. */
  skill: { as: 'skill', judge: { ...CLAUDE_JUDGE, access: 'read' }, ownRun: true },
  /** The skill driver of a run that does not judge here: it declares no judge. */
  'skill-no-judge': { as: 'skill', ownRun: true },
};

/** What a runner of judge scenarios provides: its clients, the revision its run file holds, and the clock its calls read. */
export interface JudgeConformanceRunner {
  client: Pick<ConformanceClient, 'start' | 'next' | 'report'> & {
    scoreNext: (body: unknown) => Promise<WorkflowEnvelope>;
    /** Settles judge lease `ref` with `body`, as `teamai score --lease <ref> --submit` does. */
    submit: (ref: string, body: unknown) => Promise<WorkflowEnvelope>;
  };
  readRevision(runId: string): Promise<number>;
  /** Sets the time every later call reads. */
  setClock(at: string): Promise<void>;
  expect: ConformanceExpect;
}

function dataOf(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(envelope.error.message);
  return envelope.data;
}

const LeasedSchema = z.object({ attempt: z.string(), revision: z.number() });
const JudgeLeaseSchema = z.object({ ref: z.string() });

/** Runs one judge scenario as `profile`: its driver runs the scored pass to the run's end, then takes the judge work. */
export async function runJudgeConformanceScenario(scenario: JudgeConformanceScenario, runner: JudgeConformanceRunner, profile: JudgeProfile): Promise<void> {
  const { client, expect } = runner;
  const judging = JUDGE_PROFILES[profile];
  const driver = profileDriver(judging.as);
  await runner.setClock('2026-10-22T11:00:00.000Z');
  const runId = String(dataOf(await client.start('judged')).run);
  const work = LeasedSchema.parse(dataOf(await client.next(runId, { driver: { ...driver, can: DRIVER_PROFILES[judging.as].can } })).lease);
  dataOf(await client.report(runId, { ...work, driver, outcome: 'success', outputs: { reviewed: true } }));
  expect(await client.next(runId, { driver })).toMatchObject({ data: { done: {} } });
  const request = (fields: { running: string[]; canTakeLease?: false }): unknown => ({
    driver: { ...driver, can: judging.judge ? { judge: judging.judge } : {} }, ...(judging.ownRun ? { run: runId } : {}), ...fields,
  });
  const refusal = scenario.refusedBy?.[profile];
  /** The answer of `score --next`, or undefined once `profile` refused it as the scenario says. */
  const scoreNext = async (body: unknown): Promise<WorkflowEnvelope | undefined> => {
    const answer = await client.scoreNext(body);
    if (!refusal) return answer;
    expect(answer, `${profile} is refused judge work`).toMatchObject(refusal);
    return undefined;
  };
  let ref = '';
  for (const operation of scenario.operations) {
    let answer: WorkflowEnvelope | undefined;
    switch (operation.kind) {
      case 'take':
        await runner.setClock(operation.at);
        answer = await scoreNext(request({ running: operation.running ? [ref] : [] }));
        break;
      case 'renew':
        await runner.setClock(operation.at);
        answer = await scoreNext(request({ running: [ref], ...(operation.canTakeLease === false ? { canTakeLease: false } : {}) }));
        break;
      case 'idle':
        await runner.setClock(operation.at);
        answer = await scoreNext(request({ running: [] }));
        break;
      case 'next': {
        const before = await runner.readRevision(runId);
        answer = await client.next(runId, { driver, running: [ref] });
        expect(await runner.readRevision(runId), 'the run as it was').toEqual(before);
        break;
      }
      case 'report':
        answer = await client.report(runId, { attempt: ref, revision: 1, driver, outcome: 'success' });
        break;
      case 'submit':
        answer = await client.submit(ref, { driver, outcome: 'success', answer: { label: 'good', reasoning: 'done' } });
        break;
      default: {
        const unhandled: never = operation;
        throw new Error(`unknown judge conformance operation ${JSON.stringify(unhandled)}`);
      }
    }
    if (!answer) return;
    expect(answer).toMatchObject(operation.expect);
    if (operation.kind === 'take') ref = JudgeLeaseSchema.parse(dataOf(answer).lease).ref;
  }
  if (refusal) throw new Error(`The scenario says ${profile} is refused judge work, but it made no score --next`);
}
