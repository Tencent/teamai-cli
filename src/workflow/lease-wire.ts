/** The lease `next` answers with, as `leaseData` in `engine.ts` writes it, parsed by every driver with one schema. */
import { z } from 'zod';
import { EnvScopeSchema, LeaseSetupSchema, RequirementsSchema } from './requirements.js';
import { AttemptIdSchema } from './store.js';
import { WorkspaceContractSchema, type LeaseSession } from './workspace.js';

const SessionRefSchema = z.object({ tool: z.string(), id: z.string() });
const LeaseSessionSchema = SessionRefSchema.extend({ earlier: z.array(SessionRefSchema).optional() }) satisfies z.ZodType<LeaseSession>;

/** What names a lease, which a driver reports a lease it cannot otherwise read with. */
export const LeaseIdSchema = z.object({ attempt: AttemptIdSchema, revision: z.number().int() });

/** A leased step: a command or a prompt, never both. */
export const LeaseWireSchema = LeaseIdSchema.extend({
  /** The step path, such as `check.classify` inside a sub-workflow. */
  step: z.string(),
  command: z.string().optional(),
  env: z.record(z.string()).optional(),
  prompt: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  /** The `defaults.model` in effect for a prompt step, as written. */
  defaultModel: z.string().optional(),
  output: z.unknown().optional(),
  workspace: WorkspaceContractSchema.optional(),
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
  /** What to run in a worktree prepare creates, before the step. */
  setup: LeaseSetupSchema.optional(),
  /** When the engine cancels the lease. */
  expiresAt: z.string().optional(),
}).refine((lease) => (lease.command === undefined) !== (lease.prompt === undefined), { message: 'a lease runs a command or a prompt' });

export type LeaseWire = z.infer<typeof LeaseWireSchema>;
