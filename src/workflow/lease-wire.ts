/** The lease `next` answers with, as `leaseData` in `engine.ts` writes it, parsed by every driver with one schema. */
import { z } from 'zod';
import { OutputSchemaSchema } from './output.js';
import { ConfinedLevelSchema, EnvScopeSchema, LeaseSetupSchema, RequirementsSchema, TurnLimitsSchema } from './requirements.js';
import { StepModelSchema } from './step-model.js';
import { AttemptIdSchema } from './store.js';
import { WorkspaceContractSchema, type LeaseSession } from './workspace.js';

const SessionRefSchema = z.object({ tool: z.string(), id: z.string() });
const LeaseSessionSchema = SessionRefSchema.extend({ earlier: z.array(SessionRefSchema).optional() }) satisfies z.ZodType<LeaseSession>;

/**
 * A prompt step confined to `dir`, its only readable root, at `level`: the real paths of the directory and of the JSON
 * Schema its reply follows, and the tools to run it on, in order, the first that resolves its model.
 */
export const ConfinedLeaseSchema = z.object({ dir: z.string().min(1), level: ConfinedLevelSchema, schema: z.string().min(1).optional(), tools: z.array(z.string().min(1)).min(1) });

export type ConfinedLease = z.infer<typeof ConfinedLeaseSchema>;

/** What names a lease, which a driver reports a lease it cannot otherwise read with. */
export const LeaseIdSchema = z.object({ attempt: AttemptIdSchema, revision: z.number().int() });

/** A leased step: a command or a prompt, never both. An answer step's lease is a prompt. */
export const LeaseWireSchema = LeaseIdSchema.extend({
  /** The step path, such as `check.classify` inside a sub-workflow. */
  step: z.string(),
  command: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  prompt: z.string().optional(),
  /** The prompt is an answer step's: the member's AI tool answers it on its one-shot call launch, in the checkout read-only. */
  answer: z.literal(true).optional(),
  /** A command step's paths, relative to the checkout, under which a change it makes is kept rather than failing it `read_only_dirty`. */
  writes: z.array(z.string()).optional(),
  agent: z.string().optional(),
  /** The tool the prompt step names, which this driver listed in `can.tools`. */
  tool: z.string().optional(),
  /** `unattended`: launch the prompt's tool in its mode for editing and running commands without asking (`can.unattended`). */
  permissions: z.literal('unattended').optional(),
  /** The step's `model`: as written, which the driver resolves, or the exact model, which it passes to the tool as is. */
  model: z.union([z.string(), StepModelSchema]).optional(),
  /** The `defaults.model` in effect for a prompt step, as written. */
  defaultModel: z.string().optional(),
  /** The step's declared output, which the driver's result instruction asks the agent to match. */
  output: OutputSchemaSchema.optional(),
  workspace: WorkspaceContractSchema.optional(),
  confined: ConfinedLeaseSchema.optional(),
  /** The team role the step's copy runs with, its clone's or its own: teamai delivers that role's knowledge there, for `can.role`. */
  role: z.string().optional(),
  session: LeaseSessionSchema.optional(),
  /** The person works in the step. */
  interactive: z.literal(true).optional(),
  /** The step set `workspace: read-only`. An interactive prompt is checked only then. */
  readOnly: z.literal(true).optional(),
  /** What the step requires: its isolation, network and env keys, by name. */
  requires: RequirementsSchema.optional(),
  /** The env keys the step gets and the ones kept from it, by name. */
  envScope: EnvScopeSchema.optional(),
  /** The most agent turns the prompt's tool may take. */
  maxTurns: z.number().optional(),
  /** The limits that end the prompt's turn, from its tool's launch, for a driver with `can.end_turn`. */
  limits: TurnLimitsSchema.optional(),
  /** What to run in a worktree prepare creates, before the step. */
  setup: LeaseSetupSchema.optional(),
  /** When the engine cancels the lease. */
  expiresAt: z.string().optional(),
}).refine((lease) => (lease.command === undefined) !== (lease.prompt === undefined), { message: 'a lease runs a command or a prompt' });

export type LeaseWire = z.infer<typeof LeaseWireSchema>;
