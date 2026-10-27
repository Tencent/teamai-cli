/** The model the child of a prompt step must run, as `chooseStepModel` resolves it for the session's tool. */
import { isAgentToolId } from '../../../tools.js';
import type { LocalConfig, TeamaiConfig, ToolId } from '../../../types.js';
import { chooseStepModel, loadDeployedAgent } from '../../step-model.js';
import type { WorkflowFailure } from '../../types.js';
import type { ModelPick } from './skill-state.js';

/**
 * The step's `model`, else the model the team agent's definition deployed for `tool` sets, else `defaults.model`,
 * aliases resolved for `tool`. A step whose agent definition cannot be read skips `defaults.model`: the host runs
 * that agent with whatever model its file sets.
 */
export async function pickChildModel(input: {
  config: LocalConfig;
  /** The team's `toolPaths`, which say where `teamai pull` deployed the agent for `tool`. */
  toolPaths: TeamaiConfig['toolPaths'] | undefined;
  step: string;
  /** The session's tool, undefined when its host names none. */
  tool: ToolId | undefined;
  model?: string;
  defaultModel?: string;
  agent?: string;
}): Promise<{ ok: true; model: ModelPick } | { ok: false; failure: WorkflowFailure }> {
  const { config, toolPaths, step, tool, model, agent } = input;
  // Agent files and model aliases exist only for a tool teamai renders agents for.
  const agentTool = tool !== undefined && isAgentToolId(tool) ? tool : undefined;
  const definition = agent !== undefined && agentTool !== undefined ? await loadDeployedAgent({ tool: agentTool, name: agent, config, toolPaths }) : null;
  const defaultModel = agent === undefined || definition !== null ? input.defaultModel : undefined;
  const asked = model ?? (definition?.spec.model === undefined ? defaultModel : undefined);
  if (asked === undefined) return { ok: true, model: { by: 'definition' } };
  if (tool === undefined) {
    return { ok: false, failure: { code: 'model_unavailable', message: `Step "${step}" needs model ${asked}, and this coding session names no tool to resolve it for: start or resume the workflow with --tools default=<tool>, the tool it works in.` } };
  }
  if (agentTool === undefined) {
    return { ok: false, failure: { code: 'model_unavailable', message: `Step "${step}" needs model ${asked}, and teamai resolves no model for ${tool}, the coding session's tool.` } };
  }
  const chosen = await chooseStepModel({
    step, tool: agentTool, config, ...(model !== undefined ? { model } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}), ...(definition !== null ? { agent: definition.spec } : {}),
  });
  if (!chosen.ok) return chosen;
  if (chosen.model === undefined || chosen.by === 'definition') return { ok: true, model: { by: 'definition' } };
  const { name, effort } = chosen.model;
  return { ok: true, model: { by: chosen.by, name, ...(effort !== undefined ? { effort } : {}), ...(chosen.alias !== undefined ? { alias: chosen.alias } : {}) } };
}
