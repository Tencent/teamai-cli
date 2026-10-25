/** The model the child of a prompt step must run, as `chooseStepModel` resolves it for the session's tool. */
import type { ToolName } from '../../../resources/agent-format.js';
import type { LocalConfig } from '../../../types.js';
import { chooseStepModel } from '../../step-model.js';
import type { WorkflowFailure } from '../../types.js';
import type { ModelPick } from './skill-state.js';

/**
 * The step's `model`, else `defaults.model`, aliases resolved for `tool`. A step that names a team agent skips
 * `defaults.model`: the host runs that agent with the model its file sets.
 */
export async function pickChildModel(input: {
  config: LocalConfig;
  step: string;
  /** The session's tool, undefined when its host names none. */
  tool: ToolName | undefined;
  model?: string;
  defaultModel?: string;
  agent?: string;
}): Promise<{ ok: true; model: ModelPick } | { ok: false; failure: WorkflowFailure }> {
  const { config, step, tool, model } = input;
  const defaultModel = input.agent === undefined ? input.defaultModel : undefined;
  const asked = model ?? defaultModel;
  if (asked === undefined) return { ok: true, model: { by: 'definition' } };
  if (tool === undefined) {
    return { ok: false, failure: { code: 'model_unavailable', message: `Step "${step}" needs model ${asked}, and this coding session names no tool to resolve it for.` } };
  }
  const chosen = await chooseStepModel({ step, tool, config, ...(model !== undefined ? { model } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}) });
  if (!chosen.ok) return chosen;
  if (chosen.model === undefined || chosen.by === 'definition') return { ok: true, model: { by: 'definition' } };
  const { name, effort } = chosen.model;
  return { ok: true, model: { by: chosen.by, name, ...(effort !== undefined ? { effort } : {}), ...(chosen.alias !== undefined ? { alias: chosen.alias } : {}) } };
}
