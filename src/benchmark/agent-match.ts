/**
 * Whether a trial ran as its arm: the tool, the team revision, and the model when the arm names a concrete model id, as
 * teamai observed the prompt. The record picks a workflow arm's observation by it, and the table counts deviations by it.
 */
import type { AgentObservation } from '../agent-observation.js';
import { isNativeModelAlias } from '../models/aliases.js';
import type { BenchmarkRecord } from './result.js';

export type Comparison = 'match' | 'deviation' | 'not_verified';

/**
 * How a trial's prompt ran against its arm, on the values that can be compared: the tool, the team revision, and the
 * model when the arm names a concrete model id. A value the record lacks is not verified; a deviation outweighs it. A
 * tool's own model selector such as `opus`, or the tool's default model, is not compared with the model id it reports.
 */
export function compareAgent(arm: Pick<BenchmarkRecord['arms'][number], 'tool' | 'model' | 'team'>, observed: AgentObservation): Comparison {
  const compare = (intended: string, recorded: string | undefined, same = (left: string, right: string): boolean => left === right): Comparison => {
    if (recorded === undefined) return 'not_verified';
    return same(intended, recorded) ? 'match' : 'deviation';
  };
  const comparisons = new Set([
    compare(arm.tool, observed.tool.name),
    compareTeam(arm.team, observed.team),
    ...(arm.model !== undefined && !isNativeModelAlias(arm.model) ? [compare(arm.model, observed.model?.reported, sameModel)] : []),
  ]);
  if (comparisons.has('deviation')) return 'deviation';
  return comparisons.has('not_verified') ? 'not_verified' : 'match';
}

/**
 * Whether the prompt ran on its arm's team assets: the arm's revision, or no team assets at all. A clone without some
 * paths pulls the commit teamai made of the arm's revision without them, and records the arm's revision. A trial of a
 * team arm whose record names no team is not verified; one of an arm without team assets that names one ran on them.
 */
function compareTeam(intended: BenchmarkRecord['arms'][number]['team'], recorded: AgentObservation['team']): Comparison {
  if (intended.kind === 'none') return recorded === undefined ? 'match' : 'deviation';
  if (recorded === undefined) return 'not_verified';
  return recorded.revision === intended.revision ? 'match' : 'deviation';
}

/**
 * A reported model id is the requested one, also with a provider in front of either or a release date after: `a/m`,
 * `m-20250805`, `m@2025-08-05`. Two ids that both name a provider name the same one.
 */
function sameModel(requested: string, reported: string): boolean {
  if (requested === reported) return true;
  const split = (model: string): { provider?: string; id: string } => {
    const slash = model.lastIndexOf('/');
    return slash < 0 ? { id: model } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  };
  const asked = split(requested);
  const ran = split(reported);
  if (asked.provider !== undefined && ran.provider !== undefined && asked.provider !== ran.provider) return false;
  return ran.id === asked.id || (ran.id.startsWith(asked.id) && /^[-@]\d{4}-?\d{2}-?\d{2}$/.test(ran.id.slice(asked.id.length)));
}
