/**
 * What teamai does with a member's captured sessions in each run mode (#1385): `off` does nothing, `ask` offers it to
 * the person (#1388), `auto` does it unasked. Scoring reads its policies from `scorers/scoring.yaml` `sessions`,
 * publishing from `teamai.yaml` `sessions.publish`; a member's `config.yaml` overrides either, one mode at a time.
 */
import { z } from 'zod';
import { RunModeSchema, type RunMode } from '../launch-context.js';

/** Most restrictive first: where two files of one level disagree, the earlier policy wins. */
const POLICIES = ['off', 'ask', 'auto'] as const;
export type SessionPolicy = typeof POLICIES[number];
const SessionPolicySchema = z.enum(POLICIES);
const MappingSchema = z.record(z.string(), z.unknown());

/** The policy of each run mode, with the setting it came from. */
export type SessionPolicies = Record<RunMode, { policy: SessionPolicy; source: string }>;

const DEFAULT_SOURCE = 'the default';

/**
 * The policies `value`, the setting `key` names (such as `teamai.yaml sessions.publish`), sets: a mapping of run modes
 * to policies, or with `booleans`, `true` for `auto` and `false` for `off` in both modes. Each value it cannot use is a
 * problem that names the key and what it allows, and sets nothing, so that mode falls to the next level.
 */
function read(key: string, value: unknown, { booleans = false }: { booleans?: boolean } = {}): { set: Partial<SessionPolicies>; problems: string[] } {
  if (booleans && typeof value === 'boolean') {
    const policy = value ? 'auto' : 'off';
    return { set: { attended: { policy, source: key }, unattended: { policy, source: key } }, problems: [] };
  }
  const mapping = MappingSchema.safeParse(value);
  if (!mapping.success) {
    const allowed = booleans ? 'true, false or a mapping of attended and unattended to off, ask or auto' : 'a mapping of attended and unattended to off, ask or auto';
    return { set: {}, problems: [`${key} is ${JSON.stringify(value)}, not ${allowed}, so it is ignored`] };
  }
  const set: Partial<SessionPolicies> = {};
  const problems: string[] = [];
  for (const [name, policy] of Object.entries(mapping.data)) {
    const mode = RunModeSchema.safeParse(name);
    const parsed = SessionPolicySchema.safeParse(policy);
    if (!mode.success) problems.push(`${key}.${name} is not a run mode (attended, unattended), so it is ignored`);
    else if (!parsed.success) problems.push(`${key}.${name} is ${JSON.stringify(policy)}, not off, ask or auto, so it is ignored`);
    else set[mode.data] = { policy: parsed.data, source: `${key}.${name}` };
  }
  return { set, problems };
}

/**
 * Each mode's policy from the first of `levels` that sets it, the most restrictive of that level's sets, else its
 * default.
 */
function resolve(levels: ReadonlyArray<ReadonlyArray<Partial<SessionPolicies>>>, defaults: Record<RunMode, SessionPolicy>): SessionPolicies {
  const of = (mode: RunMode): SessionPolicies[RunMode] => {
    for (const level of levels) {
      const [strictest] = level.flatMap((set) => set[mode] ?? []).sort((left, right) => POLICIES.indexOf(left.policy) - POLICIES.indexOf(right.policy));
      if (strictest) return strictest;
    }
    return { policy: defaults[mode], source: DEFAULT_SOURCE };
  };
  return { attended: of('attended'), unattended: of('unattended') };
}

export const SessionPolicy = { read, resolve } as const;
