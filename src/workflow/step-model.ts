/**
 * Which model a prompt step runs on, first match wins: the step's `model`, the model its definition sets for the
 * tool, the `defaults.model` in effect, the tool's default. The lease carries the first and third as written; they
 * resolve here, with the member's aliases for the step's tool. Claude reads a definition's model from its file. Codex
 * gets it on argv, and so does OpenCode with the variant: OpenCode 2 reads neither from the agent file, and OpenCode 1
 * does not start a subagent, which is how pull deploys OpenCode agents.
 */
import path from 'node:path';
import { installOf, locate, ownOf } from '../locate.js';
import { isModelAlias, loadModelAliases, noModelCause, noModelReason, resolveModelValue, type NoModel } from '../models/aliases.js';
import {
  agentFileExtensionForTool, reverseByTool, toolExtrasFor, type AgentSpec, type ToolName,
} from '../resources/agent-format.js';
import { isAgentToolId } from '../tools.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { isLaunchTool, launchAdapterIdOf } from '../tool-launch/tools.js';
import { readFileSafe } from '../utils/fs.js';
import type { WorkflowFailure } from './types.js';

/** The model a prompt step's tool runs on, with the reasoning effort it takes. */
export type StepModel = { name: string; effort?: string };

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
  /** The tool the step runs on: a launch tool, or the coding session's own for a child it starts. */
  tool: ToolName;
  /** The lease's `model`, as written. */
  model?: string;
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

export async function chooseStepModel(request: StepModelRequest): Promise<StepModelChoice> {
  const { step, tool, agent } = request;
  const chosen: { origin: ModelOrigin; value: string } | undefined = request.model !== undefined
    ? { origin: 'step', value: request.model }
    : agent?.model === undefined && request.defaultModel !== undefined ? { origin: 'defaults', value: request.defaultModel } : undefined;
  if (!chosen) {
    // A tool teamai does not launch starts the agent itself, from the file it reads the model from.
    const family = isLaunchTool(tool) ? launchAdapterIdOf(tool) : undefined;
    // Claude and CodeBuddy read it from the agent file `--agent` names.
    if (!agent?.model || family === undefined || family === 'claude' || family === 'codebuddy') return { ok: true };
    const variant = family === 'opencode' ? toolExtrasFor(agent, 'opencode')?.['variant'] : undefined;
    return { ok: true, by: 'definition', model: { name: agent.model, ...(variant !== undefined ? { effort: String(variant) } : {}) } };
  }
  const aliases = await loadModelAliases(request.config);
  const resolution = resolveModelValue(aliases, chosen.value, tool);
  if (!resolution.ok || resolution.model === undefined) {
    const value = isModelAlias(aliases, chosen.value) ? `model alias "${chosen.value}"` : `model "${chosen.value}"`;
    return unavailable(stepModelUnavailableText(step, chosen.origin, value, noModelCause(resolution, tool), noModelReason(resolution)));
  }
  return {
    ok: true,
    by: chosen.origin,
    model: { name: resolution.model, ...(resolution.effort !== undefined ? { effort: resolution.effort } : {}) },
    ...(isModelAlias(aliases, chosen.value) ? { alias: chosen.value } : {}),
  };
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
  if (toolPaths === undefined || !isLaunchTool(tool) || !isAgentToolId(tool)) return null;
  // The same directory `teamai pull` writes, not the step's cwd.
  const agents = ownOf(await locate(tool, 'agents', installOf({ toolPaths }, config)))?.path;
  if (agents === undefined) return null;
  const file = path.join(agents, `${name}${agentFileExtensionForTool(tool)}`);
  const content = await readFileSafe(file);
  if (content === null) return null;
  const reversed = reverseByTool(tool, file, content);
  return reversed.ok ? { spec: reversed.spec, file } : null;
}
