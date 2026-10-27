/** Every command line the skill driver prints, and the permission patterns that pre-approve them. */
import { z } from 'zod';
import type { AttemptId, RunId } from '../../store.js';
import type { DriverIdentity } from '../../types.js';
import type { HostChoice } from './host-profiles.js';
import type { HitlMode } from './preflight.js';

const LiteralSchema = z.string().brand<'Literal'>();
/** A command line the agent runs, or shows the person, exactly as printed. Only this module builds one. */
export type Literal = z.infer<typeof LiteralSchema>;

/** How the member runs teamai: the first words of every literal. */
export const INVOCATIONS = ['teamai', 'npx teamai-cli'] as const;
export type Invocation = typeof INVOCATIONS[number];

/** The invocation of a teamai process whose entry script is `entry`: npx runs the package from its own cache. */
export function invocationOf(entry: string | undefined): Invocation {
  return entry !== undefined && /[\\/]_npx[\\/]/.test(entry) ? 'npx teamai-cli' : 'teamai';
}

/**
 * The patterns a generated `invoke: allow` skill adds, so the agent starts its workflow, by name or alias, without a
 * prompt. The trailing `--driver` keeps `ship` from matching `ship-issue`.
 */
export function generatedStartPatterns(name: string, alias?: string): string[] {
  return INVOCATIONS.flatMap((invocation) => [name, ...(alias ? [alias] : [])].map((start) => `Bash(${invocation} workflow start ${start} --driver skill:*)`));
}

/** Describes `name` for the skill driver. `tool` names the tool of a session whose host names none. */
export function describeLiteral(invocation: Invocation, name: string, options: { tool?: string } = {}): Literal {
  return LiteralSchema.parse([`${invocation} workflow start --describe ${name} --driver skill`, ...toolsWords(options.tool)].join(' '));
}

/** `word` as one shell word: as is when it holds only safe characters, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The words of the options a skill run is started or continued with: `--parallel`, the HITL mode and `--no-judge`. */
function runOptionWords(options: { parallel?: number; hitl?: HitlMode; noJudge?: boolean }): string[] {
  return [
    ...(options.parallel !== undefined ? [`--parallel ${options.parallel}`] : []),
    ...(options.hitl === 'auto-approve' ? ['--auto-approve'] : options.hitl !== undefined ? [`--hitl ${options.hitl}`] : []),
    ...(options.noJudge ? ['--no-judge'] : []),
  ];
}

/**
 * Starts `name` for the skill driver. `inputs` leaves the `{inputs}` slot the agent fills with the person's answers;
 * `hitl` is how optional gates are answered; `noJudge` leaves the scored steps unjudged here; `tool` names the tool of a
 * session whose host names none.
 */
export function startLiteral(invocation: Invocation, name: string, options: { parallel?: number; confirmed?: boolean; hitl?: HitlMode; inputs?: boolean; noJudge?: boolean; tool?: string } = {}): Literal {
  return LiteralSchema.parse([
    `${invocation} workflow start ${name} --driver skill`,
    ...toolsWords(options.tool),
    ...runOptionWords({ parallel: options.parallel }),
    ...(options.confirmed ? ['--confirmed'] : []),
    ...runOptionWords({ hitl: options.hitl, noJudge: options.noJudge }),
    ...(options.inputs ? ["--inputs '{inputs}'"] : []),
  ].join(' '));
}

/** `--tools default=<tool>`: the prompt tool a local run must be told (`localPromptTool`), or the tool a skill session names. */
function toolsWords(tool: string | undefined): string[] {
  return tool !== undefined ? [`--tools default=${shellWord(tool)}`] : [];
}

/** Starts `name` with the local driver: shown to the person, never run by the agent. `tool`: its prompt tool. */
export function localStartLiteral(invocation: Invocation, name: string, options: { tool?: string } = {}): Literal {
  return LiteralSchema.parse([`${invocation} workflow start ${name} --driver local`, ...toolsWords(options.tool)].join(' '));
}

/** Continues `run` with the local driver: shown to the person for their own terminal, never run by the agent. `tool`: its prompt tool. */
export function resumeLiteral(invocation: Invocation, run: RunId, options: { tool?: string } = {}): Literal {
  return LiteralSchema.parse([`${invocation} workflow resume ${run}`, ...toolsWords(options.tool)].join(' '));
}

/**
 * Continues `run` from this coding session with the skill driver, taking it over from the machine that published it.
 * `claim` takes it from another install that owns it: printed only for the person to agree to. `confirmed` carries the
 * person's yes to continue a run of an `invoke: ask` workflow. The other options are a start's (`startLiteral`).
 */
export function skillResumeLiteral(invocation: Invocation, run: RunId, options: { claim?: boolean; parallel?: number; hitl?: HitlMode; noJudge?: boolean; confirmed?: boolean; tool?: string } = {}): Literal {
  return LiteralSchema.parse([
    `${invocation} workflow resume ${run} --driver skill`,
    ...toolsWords(options.tool),
    ...(options.claim ? ['--claim'] : []),
    ...runOptionWords(options),
    ...(options.confirmed ? ['--confirmed'] : []),
  ].join(' '));
}

export function nextLiteral(invocation: Invocation, run: RunId): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill`);
}

/**
 * Takes the run over from the session that drives it: printed only for the person to agree to. `confirmed` carries the
 * person's yes to continue a run of an `invoke: ask` workflow.
 */
export function takeoverLiteral(invocation: Invocation, run: RunId, options: { confirmed?: boolean } = {}): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --takeover${options.confirmed ? ' --confirmed' : ''}`);
}

export function pollLiteral(invocation: Invocation, run: RunId): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --wait`);
}

/** Answers the host question with profile `choice`. */
export function chooseHostLiteral(invocation: Invocation, run: RunId, choice: HostChoice): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --choice ${choice}`);
}

/** Acks the dispatch of `attempt` once its child started. */
export function ackLiteral(invocation: Invocation, run: RunId, attempt: AttemptId): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --ack dispatch.${attempt}`);
}

/** The agent's answer `choice` to the optional gate at `step`, pass `pass`, sent through the skill driver. */
export function respondLiteral(invocation: Invocation, run: RunId, gate: { step: string; pass: number; choice: string }): Literal {
  return LiteralSchema.parse(`${invocation} workflow respond ${run} ${shellWord(gate.step)} ${shellWord(gate.choice)} --pass ${gate.pass} --driver skill`);
}

/** The person's answer `choice` to the gate at `step`, pass `pass`: shown to the person for their own terminal, never run by the agent. */
export function personRespondLiteral(invocation: Invocation, run: RunId, gate: { step: string; pass: number; choice: string }): Literal {
  return LiteralSchema.parse(`${invocation} workflow respond ${run} ${shellWord(gate.step)} ${shellWord(gate.choice)} --pass ${gate.pass}`);
}

export function reportLiteral(invocation: Invocation, run: RunId, attempt: AttemptId): Literal {
  return LiteralSchema.parse([invocation, ...runnerArgs(run, attempt)].join(' '));
}

/**
 * Adopts `dir`, the place the host made for `attempt`, as its turn printed it. Without `dir`, the agent fills the
 * `{dir}` slot with that directory.
 */
export function adoptLiteral(invocation: Invocation, run: RunId, attempt: AttemptId, dir?: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --attempt ${attempt} --adopt ${dir === undefined ? "'{dir}'" : shellWord(dir)}`);
}

/** Leases the next judge work of `run` to the session's own judge: `tool`, at best-effort, reading only the evidence. */
export function sessionJudgeLiteral(invocation: Invocation, run: RunId, driver: DriverIdentity, tool: string): Literal {
  const request = { run, driver: { ...driver, can: { judge: { isolation: 'best-effort', access: 'read', tools: [tool] } } }, running: [] };
  return LiteralSchema.parse(`${invocation} score --next --json ${shellWord(JSON.stringify(request))}`);
}

/** Reports that the host cannot run the model the dispatch of `attempt` names. */
export function unavailableLiteral(invocation: Invocation, run: RunId, attempt: AttemptId): Literal {
  return LiteralSchema.parse([invocation, ...runnerArgs(run, attempt), '--model-unavailable'].join(' '));
}

/** The arguments, after the teamai entry script, that start the runner of `attempt`. */
export function runnerArgs(run: RunId, attempt: AttemptId): string[] {
  return ['workflow', 'report', run, '--driver', 'skill', '--attempt', attempt];
}
