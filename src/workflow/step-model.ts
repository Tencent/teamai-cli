/**
 * Which model a prompt step runs on, first match wins: the step's `model`, the model its definition sets for the
 * tool, the `defaults.model` in effect, the tool's default. The lease carries the first and third as written; they
 * resolve here, with the member's aliases for the step's tool, except a step's exact model, `{ name, effort? }`, which
 * the tool gets as is. Claude reads a definition's model from its file. Codex
 * gets it on argv, and so does OpenCode with the variant: OpenCode 2 reads neither from the agent file, and OpenCode 1
 * does not start a subagent, which is how pull deploys OpenCode agents.
 */
import path from 'node:path';
import { z } from 'zod';
import { installOf, locate, ownOf } from '../locate.js';
import { isModelAlias, loadModelAliases, noModelCause, noModelReason, resolveModelValue, type NoModel } from '../models/aliases.js';
import {
  agentFileExtensionForTool, reverseByTool, toolExtrasFor, type AgentSpec, type ToolName,
} from '../resources/agent-format.js';
import { agentFormatOf, baseToolOf } from '../tool-registry.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { isLaunchTool, launchAdapterIdOf } from '../tool-launch/tools.js';
import { readFileSafe } from '../utils/fs.js';
import type { WorkflowFailure } from './types.js';

/**
 * The model a prompt step's tool runs on, with the reasoning effort it takes. A step's `model` in this form is exact:
 * every driver passes it to the tool as is.
 */
export const StepModelSchema = z.object({ name: z.string().min(1), effort: z.string().min(1).optional() }).strict();

export type StepModel = z.infer<typeof StepModelSchema>;

/**
 * The model and effort the launch passes, none when it passes none, or why the step cannot run. `by` says whether the
 * step, its `defaults.model` or the definition chose it; `alias` is the alias the step or `defaults.model` named.
 */
export type StepModelChoice =
  | { ok: true; model?: undefined }
  | { ok: true; model: StepModel; by: 'definition' }
  | { ok: true; model: StepModel; by: ModelOrigin; alias?: string }
  | { ok: false; failure: WorkflowFailure };

export interface StepModelRequest {
  /** The step path the lease names, such as `check.classify`. */
  step: string;
  /** The tool the step runs on: a launch tool or an instance of one, or the coding session's own for a child it starts. */
  tool: string;
  /** The lease's `model`: as written, or the exact model, which no alias resolves. */
  model?: string | StepModel;
  /** The lease's `defaultModel`, as written. */
  defaultModel?: string;
  /** The definition deployed for the tool, when the step names an agent. */
  agent?: AgentSpec;
  /** The scope whose aliases resolve the step's `model` or `defaults.model`. */
  config: LocalConfig;
}

export type ModelOrigin = 'step' | 'defaults';

/** What the member can do about a step model that gives the tool no model. */
const NO_MODEL_FIX: Record<NoModel, Record<ModelOrigin, string>> = {
  unmapped: { step: 'Add one or remove model from the step.', defaults: 'Add one, or set model on the step.' },
  local: { step: 'Remove that entry or remove model from the step.', defaults: 'Remove that entry, or set model on the step.' },
  switched: { step: 'Run teamai models restore, or remove model from the step.', defaults: 'Run teamai models restore, or set model on the step.' },
  unresolved: { step: 'Fix that, or remove model from the step.', defaults: 'Fix that, or set model on the step.' },
};

/**
 * Why a step cannot run the model it asks for, or gets from `defaults`: `value` is `model alias "fast"` or `model "x"`,
 * `cause` the `noModelCause` of its resolution.
 */
export function stepModelUnavailableText(step: string, origin: ModelOrigin, value: string, cause: string, reason: NoModel): string {
  const asks = origin === 'step' ? `asks for ${value}` : `gets ${value} from defaults`;

  return `Step "${step}" ${asks}, which ${cause}. ${NO_MODEL_FIX[reason][origin]}`;
}

function unavailable(message: string): StepModelChoice {
  return { ok: false, failure: { code: 'model_unavailable', message } };
}

/** The model the definition sets for a tool of `format`. agy's own model reads back into `tool_extras.agy`, never the team's `model`. */
function definitionModel(agent: AgentSpec | undefined, format: ToolName | undefined): string | undefined {
  if (agent === undefined) return undefined;
  const own = format === 'agy' ? toolExtrasFor(agent, 'agy')?.['model'] : undefined;

  const named = z.string().safeParse(own);

  return named.success ? named.data : agent.model;
}

export async function chooseStepModel(request: StepModelRequest): Promise<StepModelChoice> {
  const { step, tool, agent } = request;

  if (request.model instanceof Object) return { ok: true, by: 'step', model: request.model };
  const defined = definitionModel(agent, agentFormatOf(tool));

  const chosen: { origin: ModelOrigin; value: string } | undefined = request.model !== undefined
    ? { origin: 'step', value: request.model }
    : defined === undefined && request.defaultModel !== undefined ? { origin: 'defaults', value: request.defaultModel } : undefined;

  if (!chosen) {
    // A tool teamai does not launch starts the agent itself, from the file it reads the model from.
    const launched = baseToolOf(tool);
    const family = isLaunchTool(launched) ? launchAdapterIdOf(launched) : undefined;

    // Claude and CodeBuddy read it from the agent file `--agent` names.
    if (!agent || !defined || family === undefined || family === 'claude' || family === 'codebuddy') return { ok: true };
    const variant = family === 'opencode' ? toolExtrasFor(agent, 'opencode')?.['variant'] : undefined;

    const model: StepModel = { name: defined };

    if (variant !== undefined) model.effort = String(variant);

    return { ok: true, by: 'definition', model };
  }

  const aliases = await loadModelAliases(request.config);
  const resolution = resolveModelValue(aliases, chosen.value, tool);

  if (!resolution.ok || resolution.model === undefined) {
    const value = isModelAlias(aliases, chosen.value) ? `model alias "${chosen.value}"` : `model "${chosen.value}"`;

    return unavailable(stepModelUnavailableText(step, chosen.origin, value, noModelCause(resolution, tool), noModelReason(resolution)));
  }

  const model: StepModel = { name: resolution.model };

  if (resolution.effort !== undefined) model.effort = resolution.effort;

  return isModelAlias(aliases, chosen.value) ? { ok: true, by: chosen.origin, model, alias: chosen.value } : { ok: true, by: chosen.origin, model };
}

/**
 * The agent `name` as `teamai pull` deployed it for `tool` in `config`'s scope, and the file it was read from, which is
 * the key its pull recorded it under. Null when it is not deployed, cannot be read, or `tool` is one teamai does not
 * launch, whose agent files it does not read back.
 */
export async function loadDeployedAgent(input: {
  tool: string;
  name: string;
  config: LocalConfig;
  toolPaths: TeamaiConfig['toolPaths'] | undefined;
}): Promise<{ spec: AgentSpec; file: string } | null> {
  const { tool, name, config, toolPaths } = input;
  const format = agentFormatOf(tool);

  if (toolPaths === undefined || !isLaunchTool(baseToolOf(tool)) || format === undefined) return null;
  // The same directory `teamai pull` writes, not the step's cwd.
  const agents = ownOf(await locate(tool, 'agents', installOf({ toolPaths }, config)))?.path;

  if (agents === undefined) return null;
  const file = path.join(agents, `${name}${agentFileExtensionForTool(format)}`);
  const content = await readFileSafe(file);

  if (content === null) return null;
  const reversed = reverseByTool(format, file, content);

  return reversed.ok ? { spec: reversed.spec, file } : null;
}
