/** The conformance scenario language, the driver profiles it speaks as, and the interpreter that runs a scenario. */
import { z } from 'zod';
import type { DriverIdentity, RunState, WorkflowEnvelope } from './types.js';

export interface WorkflowClient {
  start(name: string): Promise<WorkflowEnvelope>;
  next(runId: string, body: unknown): Promise<WorkflowEnvelope>;
  report(runId: string, body: unknown): Promise<WorkflowEnvelope>;
  /** Records an answer through the client's channel. */
  respond(runId: string, step: string, choice: string, options?: { note?: string; pass?: number; json?: unknown }): Promise<WorkflowEnvelope>;
  /** Reopens the target step's dependency cone. */
  retry(runId: string, step: string): Promise<WorkflowEnvelope>;
  /** Stops the run or the named step. */
  cancel(runId: string, step?: string): Promise<WorkflowEnvelope>;
}

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
}

/**
 * The kinds of driver a scenario speaks as. Each is its own driver identity, so a lease one holds is another driver's
 * to the rest, and each declares what it can do in `driver.can`. `hitl` comes from the operation, since a local driver
 * has a person only when it runs in a terminal.
 */
export const DRIVER_PROFILES = {
  /** The in-process driver `teamai workflow run` uses. */
  local: { can: { workspace: ['read-only', 'new', 'continue'], env: true, tokens: true, max_turns: true, setup: true } },
  /** An agent session that runs the protocol itself, with a person in the chat. */
  session: { can: { hitl: true, workspace: ['read-only', 'new', 'continue'] } },
  /** A program that speaks only the CLI JSON protocol, such as an IDE or an orchestrator. */
  external: { can: { workspace: ['read-only', 'new', 'continue'] } },
} as const satisfies Record<string, { can: Record<string, unknown> }>;
export type DriverProfile = keyof typeof DRIVER_PROFILES;

/** The identity a scenario's `as` profile sends. */
export function profileDriver(profile: DriverProfile): DriverIdentity {
  return { kind: profile, machine: 'conformance', workspace: '/work' };
}

/**
 * `running` and `cancelled` name leases that earlier operations saved; `cancelled` must match exactly.
 * `absent` lists fields the lease must not carry. `as` picks the driver profile, `local` when omitted.
 * `state` is matched against the persisted run after the operation. `advance` moves the clock the engine reads.
 */
export type ConformanceOperation =
  | {
    kind: 'next'; saveAs: string; as?: DriverProfile; running?: string[]; canTakeLease?: boolean; hitl?: boolean; claim?: boolean;
    base?: { ref?: string; commit: string };
    cancelled?: string[]; absent?: string[]; expect: Record<string, unknown>; state?: Record<string, unknown>;
  }
  | { kind: 'respond'; step: string; choice: string; as?: DriverProfile; note?: string; pass?: number; json?: unknown; expect: Record<string, unknown> }
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
  attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }) }).optional(),
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

/** What a runner provides: its client, how it reads the run file and the queued end record, and how it moves the clock. */
export interface ConformanceRunner {
  client: WorkflowClient;
  readRun(runId: string): Promise<RunState>;
  /** The run's queued end record, undefined while it has none. */
  readEndRecord(runId: string): Promise<unknown>;
  advance(ms: number): Promise<void>;
  expect: ConformanceExpect;
}

/**
 * Runs one scenario as a driver that speaks only the protocol: it keeps each lease's attempt and revision, and lists
 * the attempts an operation names in `running`.
 */
export async function runConformanceScenario(scenario: ConformanceScenario, runner: ConformanceRunner): Promise<void> {
  const { client, expect } = runner;
  const started = await client.start(scenario.workflowName);
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const leases = new Map<string, SavedLease>();
  const attemptOf = (name: string): string | undefined => leases.get(name)?.attempt;
  for (const operation of scenario.operations) {
    switch (operation.kind) {
      case 'next': {
        const profile = operation.as ?? 'local';
        const { can } = DRIVER_PROFILES[profile];
        const envelope = await client.next(runId, {
          driver: { ...profileDriver(profile), can: { ...can, ...(operation.hitl !== undefined ? { hitl: operation.hitl } : {}) } },
          ...(operation.running ? { running: operation.running.map(attemptOf) } : {}),
          ...(operation.canTakeLease !== undefined ? { canTakeLease: operation.canTakeLease } : {}),
          ...(operation.claim !== undefined ? { claim: operation.claim } : {}),
          ...(operation.base ? { base: operation.base } : {}),
        });
        expect(envelope).toMatchObject(operation.expect);
        if (operation.state) expect(await runner.readRun(runId)).toMatchObject(operation.state);
        if ('data' in envelope && envelope.data.hitl) {
          const hitl = envelope.data.hitl as { step: string; pass: number; respond: string };
          expect(hitl.respond).toEqual(`teamai workflow respond ${runId} ${hitl.step} <option> --pass ${hitl.pass}`);
        }
        if (operation.cancelled) expect('data' in envelope && envelope.data.cancelled).toEqual(operation.cancelled.map(attemptOf));
        for (const field of operation.absent ?? []) expect('data' in envelope ? envelope.data.lease : undefined).not.toHaveProperty(field);
        if ('data' in envelope && envelope.data.lease) {
          leases.set(operation.saveAs, SavedLeaseSchema.parse(envelope.data.lease));
        }
        break;
      }
      case 'respond': {
        const json = 'json' in operation || !operation.as ? operation.json : { driver: profileDriver(operation.as) };
        expect(await client.respond(runId, operation.step, operation.choice, { note: operation.note, pass: operation.pass, json })).toMatchObject(operation.expect);
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
          driver: profileDriver(operation.as ?? 'local'),
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
  }
  if (scenario.expectState) expect(await runner.readRun(runId)).toMatchObject(scenario.expectState);
  if (scenario.expectRecord) expect(await runner.readEndRecord(runId)).toMatchObject(scenario.expectRecord);
  const secrets = Object.entries(scenario.env ?? {});
  if (secrets.length === 0) return;
  const stored = JSON.stringify(await runner.readRun(runId));
  const record = JSON.stringify(await runner.readEndRecord(runId)) ?? '';
  for (const [name, value] of secrets) {
    expect(stored.includes(value), `the run file holds the value of ${name}`).toEqual(false);
    expect(record.includes(value), `the end record holds the value of ${name}`).toEqual(false);
  }
}
