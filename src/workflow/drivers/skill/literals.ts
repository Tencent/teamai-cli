/** Every command line the skill driver prints, and the permission patterns that pre-approve them. */
import { z } from 'zod';
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

/** The subcommands the teamai skill pre-approves. None of them can start a run: `--describe` comes before the name. */
export const PREAPPROVED_WORKFLOW_SUBCOMMANDS = ['workflow start --describe', 'workflow next', 'workflow report', 'workflow respond'] as const;

/** The `allowed-tools` patterns of `PREAPPROVED_WORKFLOW_SUBCOMMANDS`, in each invocation. */
export function preapprovedPatterns(): string[] {
  return INVOCATIONS.flatMap((invocation) => PREAPPROVED_WORKFLOW_SUBCOMMANDS.map((subcommand) => `Bash(${invocation} ${subcommand}:*)`));
}

/**
 * The patterns a generated `invoke: allow` skill adds, so the agent starts its workflow, by name or alias, without a
 * prompt. The trailing `--driver` keeps `ship` from matching `ship-issue`.
 */
export function generatedStartPatterns(name: string, alias?: string): string[] {
  return INVOCATIONS.flatMap((invocation) => [name, ...(alias ? [alias] : [])].map((start) => `Bash(${invocation} workflow start ${start} --driver skill:*)`));
}

export function describeLiteral(invocation: Invocation, name: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow start --describe ${name} --driver skill`);
}

/** `word` as one shell word: as is when it holds only safe characters, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Starts `name` for the skill driver. `inputs` leaves the `{inputs}` slot the agent fills with the person's answers;
 * `hitl` is how optional gates are answered; `noJudge` leaves the scored steps unjudged here.
 */
export function startLiteral(invocation: Invocation, name: string, options: { parallel?: number; confirmed?: boolean; hitl?: HitlMode; inputs?: boolean; noJudge?: boolean } = {}): Literal {
  return LiteralSchema.parse([
    `${invocation} workflow start ${name} --driver skill`,
    ...(options.parallel !== undefined ? [`--parallel ${options.parallel}`] : []),
    ...(options.confirmed ? ['--confirmed'] : []),
    ...(options.hitl === 'auto-approve' ? ['--auto-approve'] : options.hitl !== undefined ? [`--hitl ${options.hitl}`] : []),
    ...(options.noJudge ? ['--no-judge'] : []),
    ...(options.inputs ? ["--inputs '{inputs}'"] : []),
  ].join(' '));
}

/** `--tools default=<tool>`, when `tool` is the prompt tool a local run must be told (`localPromptTool`). */
function toolsWords(tool: string | undefined): string[] {
  return tool !== undefined ? [`--tools default=${shellWord(tool)}`] : [];
}

/** Starts `name` with the local driver: shown to the person, never run by the agent. `tool`: its prompt tool. */
export function localStartLiteral(invocation: Invocation, name: string, options: { tool?: string } = {}): Literal {
  return LiteralSchema.parse([`${invocation} workflow start ${name} --driver local`, ...toolsWords(options.tool)].join(' '));
}

/** Continues `run` with the local driver: shown to the person for their own terminal, never run by the agent. `tool`: its prompt tool. */
export function resumeLiteral(invocation: Invocation, run: string, options: { tool?: string } = {}): Literal {
  return LiteralSchema.parse([`${invocation} workflow resume ${run}`, ...toolsWords(options.tool)].join(' '));
}

export function nextLiteral(invocation: Invocation, run: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill`);
}

/** Takes the run over from the session that drives it: printed only with `orchestrator_active`, for the person to agree to. */
export function takeoverLiteral(invocation: Invocation, run: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --takeover`);
}

export function pollLiteral(invocation: Invocation, run: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --wait`);
}

/** Answers the host question with profile `choice`. */
export function chooseHostLiteral(invocation: Invocation, run: string, choice: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --choice ${choice}`);
}

/** Acks the dispatch of `attempt` once its child started. */
export function ackLiteral(invocation: Invocation, run: string, attempt: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --ack dispatch.${attempt}`);
}

/** The agent's answer `choice` to the optional gate at `step`, pass `pass`, sent through the skill driver. */
export function respondLiteral(invocation: Invocation, run: string, gate: { step: string; pass: number; choice: string }): Literal {
  return LiteralSchema.parse(`${invocation} workflow respond ${run} ${shellWord(gate.step)} ${shellWord(gate.choice)} --pass ${gate.pass} --driver skill`);
}

/** The person's answer `choice` to the gate at `step`, pass `pass`: shown to the person for their own terminal, never run by the agent. */
export function personRespondLiteral(invocation: Invocation, run: string, gate: { step: string; pass: number; choice: string }): Literal {
  return LiteralSchema.parse(`${invocation} workflow respond ${run} ${shellWord(gate.step)} ${shellWord(gate.choice)} --pass ${gate.pass}`);
}

export function reportLiteral(invocation: Invocation, run: string, attempt: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow report ${run} --driver skill --attempt ${attempt}`);
}

/**
 * Adopts `dir`, the place the host made for `attempt`, as its turn printed it. Without `dir`, the agent fills the
 * `{dir}` slot with that directory.
 */
export function adoptLiteral(invocation: Invocation, run: string, attempt: string, dir?: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow next ${run} --driver skill --attempt ${attempt} --adopt ${dir === undefined ? "'{dir}'" : shellWord(dir)}`);
}

/** Reports that the host cannot run the model the dispatch of `attempt` names. */
export function unavailableLiteral(invocation: Invocation, run: string, attempt: string): Literal {
  return LiteralSchema.parse(`${invocation} workflow report ${run} --driver skill --attempt ${attempt} --model-unavailable`);
}

/** The arguments, after the teamai entry script, that start the runner of `attempt`. */
export function runnerArgs(run: string, attempt: string): string[] {
  return ['workflow', 'report', run, '--driver', 'skill', '--attempt', attempt];
}
