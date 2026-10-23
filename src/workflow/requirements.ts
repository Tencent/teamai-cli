import { z } from 'zod';
import { resolveTeamEnv } from '../env-resolution.js';
import { declaredSecretKeys } from '../resources/secrets.js';
import { sameEnvName } from '../resources/env-key.js';
import { workflowCommandEnvironment } from '../env-exec.js';
import { isReservedTeamEnvKey } from '../env-reserved.js';
import type { LocalConfig } from '../types.js';
import type { RunState, WorkflowFailure } from './types.js';
import type { StepPass, StepState } from './step-state.js';

export const IsolationSchema = z.enum(['none', 'worktree', 'sandbox']);
const EnvNames = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const RequirementsSchema = z.object({
  network: z.boolean().optional(), env: EnvNames.optional(), isolation: IsolationSchema.optional(),
  human: z.boolean().optional(), resume: z.boolean().optional(),
}).strict();
export type WorkflowRequirements = z.infer<typeof RequirementsSchema>;
export interface WorkflowCapabilities extends Omit<WorkflowRequirements, 'env' | 'network'> {
  /** A fixed network mode, or both modes when the driver can enforce each per launch. */
  network?: boolean | boolean[];
  env?: boolean;
  tokens?: boolean;
  max_turns?: boolean;
  setup?: boolean;
}
export const CapabilitiesSchema = RequirementsSchema.omit({ env: true, network: true }).extend({
  network: z.union([z.boolean(), z.array(z.boolean()).min(1)]).optional(),
  env: z.boolean().optional(), tokens: z.boolean().optional(), max_turns: z.boolean().optional(), setup: z.boolean().optional(),
});

export function duration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
  const ms = match && Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
  return ms && Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}
export const DurationSchema = z.unknown().transform((value, ctx) => {
  const ms = duration(value);
  if (ms === undefined) { ctx.addIssue({ code: 'custom', message: 'must be a positive duration, such as 30s, 10m, or 2h' }); return z.NEVER; }
  return ms;
});
const TokensSchema = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?[kKmM]?$/)]).transform((value, ctx) => {
  const count = typeof value === 'number' ? value : Number.parseFloat(value) * (/[mM]$/.test(value) ? 1_000_000 : /[kK]$/.test(value) ? 1000 : 1);
  if (!Number.isSafeInteger(count) || count < 1) { ctx.addIssue({ code: 'custom', message: 'must be a positive token count' }); return z.NEVER; }
  return count;
});
export const SetupSchema = z.object({ command: z.string().trim().min(1), requires: RequirementsSchema.optional(), timeout: DurationSchema.optional() }).strict();
export type WorkflowSetup = z.infer<typeof SetupSchema>;
export const WorkflowExecutionSchema = z.object({ requires: RequirementsSchema.optional(), setup: SetupSchema.optional(),
  timeout: DurationSchema.optional(), budget: z.object({ tokens: TokensSchema }).strict().optional() });
export const StepExecutionSchema = z.object({ requires: RequirementsSchema.optional(), timeout: DurationSchema.optional(), max_turns: z.number().int().positive().optional() });

/** Scalar requirements replace defaults; env is always the union, in declaration order. */
export function mergeRequirements(...sources: Array<WorkflowRequirements | undefined>): WorkflowRequirements {
  const result: WorkflowRequirements = {};
  const env = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    Object.assign(result, source);
    for (const key of source.env ?? []) env.add(key);
  }
  if (env.size) result.env = [...env];
  return result;
}

const isolationRank = { none: 0, worktree: 1, sandbox: 2 };
export function requirementsMismatch(requires: WorkflowRequirements, allow: WorkflowRequirements, can: WorkflowCapabilities): string | undefined {
  for (const key of ['network', 'human', 'resume'] as const) {
    if (requires[key] === true && allow[key] === false) return `Member workflow policy disallows ${key}`;
    const supported = key === 'network' && Array.isArray(can.network) ? can.network.includes(requires.network!) : can[key] === requires[key];
    if ((key === 'network' ? requires[key] !== undefined : requires[key] === true) && !supported) return `Driver cannot enforce requires.${key}=${requires[key]}`;
  }
  if (requires.isolation) {
    if (isolationRank[requires.isolation] > isolationRank[allow.isolation ?? 'sandbox']) return 'Member workflow policy disallows this isolation level';
    if (isolationRank[requires.isolation] > isolationRank[can.isolation ?? 'none']) return `Driver cannot enforce isolation ${requires.isolation}`;
  }
  if (requires.env?.length) {
    if (allow.env && requires.env.some((key) => sameEnvName(allow.env!, key) === undefined)) return 'Member workflow policy disallows a required env key';
    if (!can.env) return 'Driver cannot scope required env keys';
  }
  return undefined;
}

/** Keys remain diagnostic names; every string value, including future fields, is masked. */
export function maskSecrets<T>(value: T, secrets: readonly string[]): T {
  const sorted = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') { for (const secret of sorted) item = (item as string).replaceAll(secret, '[REDACTED]'); return item; }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return visit(value) as T;
}

export interface WorkflowEnvironment {
  declared: Set<string>;
  values: Map<string, string>;
  secrets: string[];
  failure?: WorkflowFailure;
}

/** Resolve locally only. No caller may persist this object or put its values in a lease. */
export async function workflowEnvironment(config: LocalConfig): Promise<WorkflowEnvironment> {
  const team = await resolveTeamEnv(config);
  const declared = new Set([...declaredSecretKeys(team.declarations) ?? [],
    ...(team.variables.kind === 'resolved' ? team.variables.entries.map(({ name }) => name) : []),
    ...team.inheritedVariables.map(({ name }) => name)].filter((key) => !isReservedTeamEnvKey(key)));
  const values = new Map<string, string>();
  for (const part of [team.inheritedValues, team.variableValues, team.secrets]) {
    if (part.kind === 'resolved') for (const [key, { value }] of part.values) if (declared.has(key)) values.set(key, value);
  }
  const secrets = team.secrets.kind === 'resolved' ? [...team.secrets.values].filter(([key]) => declared.has(key)).map(([, { value }]) => value).filter(Boolean) : [];
  const failure = team.declarations.kind === 'failed' || team.variables.kind === 'failed' || team.secrets.kind === 'store-unreadable'
    ? { code: 'env_unavailable', message: 'Workflow environment declarations or value stores cannot be read; run teamai env list.' } : undefined;
  return { declared, values, secrets, ...(failure ? { failure } : {}) };
}

export function missingEnvironment(env: WorkflowEnvironment, keys: readonly string[]): WorkflowFailure | undefined {
  if (env.failure) return env.failure;
  for (const key of keys) {
    const declared = sameEnvName(env.declared, key);
    if (!declared || !env.values.has(declared)) return { code: 'missing_env', message: `Required env key ${key} is missing. Declare it in env.yaml or env/secrets.yaml, then run teamai env set ${key}, or set it in the CI environment.` };
  }
  return undefined;
}

/** Inherited team keys are withheld unless this step names them. PATH/HOME and unrelated host variables stay. */
export async function scopedEnvironment(env: WorkflowEnvironment, keys: readonly string[], commandEnv: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const values = Object.fromEntries(keys.flatMap((key) => { const declared = sameEnvName(env.declared, key); const value = declared ? env.values.get(declared) : undefined; return value === undefined || !declared ? [] : [[declared, value]]; }));
  return workflowCommandEnvironment({ ...values, ...commandEnv }, [...env.declared]);
}

export function environmentCollision(env: WorkflowEnvironment, commandEnv: Record<string, string> | undefined): boolean {
  return Object.keys(commandEnv ?? {}).some((key) => sameEnvName(env.declared, key) !== undefined);
}

export function reportedTokens(passes: readonly (StepState | StepPass)[]): number {
  return passes.reduce((sum, pass) => sum + ('tokens' in pass ? (pass.tokens?.input ?? 0) + (pass.tokens?.output ?? 0) + (pass.tokens?.cachedInput ?? 0) : 0)
    + ('passes' in pass ? reportedTokens(pass.passes ?? []) : 0), 0);
}
export function runTokens(run: RunState, prefix = ''): number {
  return reportedTokens(run.steps.filter((step) => step.id.startsWith(prefix)))
    + reportedTokens((run.archive ?? []).filter((pass) => pass.step.startsWith(prefix)));
}
