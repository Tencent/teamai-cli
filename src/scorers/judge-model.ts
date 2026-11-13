import { isModelAlias, noModelCause, noModelReason, resolveModelValue, type ModelAliases, type ModelResolution, type NoModel } from '../models/aliases.js';
import { agentFormatOf } from '../tool-registry.js';
import type { ScorerDefinition } from './definition.js';

/** The model a judge launches with, and how it was chosen: the scorer's, or the tool's own default in its place. */
interface ChosenModel {
  model?: { name: string; effort?: string };
  by: 'scorer' | 'tool_default';
  noModel?: 'local' | 'switched';
  /** The scorer's `model` when it is an alias, also when the tool default judges in its place. */
  alias?: string;
}

const ON_NO_MODEL = {
  local: { by: 'tool_default', noModel: 'local' },
  switched: { by: 'tool_default', noModel: 'switched' },
  unmapped: undefined, unresolved: undefined,
} as const satisfies Record<NoModel, Pick<ChosenModel, 'by' | 'noModel'> | undefined>;

const NO_MODEL_FIX = { unmapped: 'Add one, or remove model from the scorer.', unresolved: 'Fix that, or remove model from the scorer.' } as const;

/** Why no judge can run a scorer's model: `asked` is `model alias "fast"` or `model "x"`, `cause` the `noModelCause` of its resolution. */
export function scorerModelUnavailableText(scorer: string, asked: string, cause: string, reason: keyof typeof NO_MODEL_FIX): string {
  return `Scorer "${scorer}" asks for ${asked}, which ${cause}. ${NO_MODEL_FIX[reason]}`;
}

/** CodeBuddy's judge launch passes no effort, so its judges run without an alias's. */
const NO_EFFORT: ReadonlySet<string> = new Set(['codebuddy']);

export type JudgeModelChoice<Tool extends string = string> =
  /** `note` says why the tool default judges in place of the scorer's alias. */
  | { ok: true; choice: ChosenModel & { tool: Tool }; note?: string }
  | { ok: false; code: 'judge_model_unavailable'; reason: keyof typeof NO_MODEL_FIX; message: string };

/**
 * The first of `tools` that gives the scorer's `model` a model, or that the member's `~` entry or a model switch sends
 * to its own default. An alias no tool maps, or that cannot be resolved, is unavailable.
 */
export function chooseJudgeModel<Tool extends string>(aliases: ModelAliases, scorer: Pick<ScorerDefinition, 'name' | 'model'>, tools: readonly Tool[]): JudgeModelChoice<Tool> {
  const { model } = scorer;
  const isAlias = model !== undefined && isModelAlias(aliases, model);
  const asked = isAlias ? `model alias "${model}"` : `model "${model}"`;
  const alias = isAlias ? { alias: model } : {};
  const unmapped: string[] = [];
  let unmappedBy: ModelResolution = { ok: true, step: 'default' };

  for (const tool of tools) {
    if (model === undefined) return { ok: true, choice: { tool, by: 'tool_default' } };

    const format = agentFormatOf(tool);

    if (format === undefined) {
      unmapped.push(tool);
      continue;
    }

    const resolved = resolveModelValue(aliases, model, tool);

    if (resolved.ok && resolved.model !== undefined) {
      const effort = resolved.effort !== undefined && !NO_EFFORT.has(format) ? { effort: resolved.effort } : {};

      return { ok: true, choice: { tool, by: 'scorer', model: { name: resolved.model, ...effort }, ...alias } };
    }

    const reason = noModelReason(resolved);
    const policy = ON_NO_MODEL[reason];

    if (policy) {
      return { ok: true, choice: { tool, ...policy, ...alias }, note: `Scorer "${scorer.name}" asks for ${asked}, which ${noModelCause(resolved, tool)}, so ${tool} judges with its default model.` };
    }

    if (reason === 'unresolved') {
      return { ok: false, code: 'judge_model_unavailable', reason, message: scorerModelUnavailableText(scorer.name, asked, noModelCause(resolved, tool), reason) };
    }

    unmapped.push(tool);
    unmappedBy = resolved;
  }

  return {
    ok: false, code: 'judge_model_unavailable', reason: 'unmapped',
    message: scorerModelUnavailableText(scorer.name, asked, noModelCause(unmappedBy, unmapped.join(', ') || 'any judge tool'), 'unmapped'),
  };
}
