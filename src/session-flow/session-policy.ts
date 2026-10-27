/**
 * What teamai does with a member's captured sessions in each run mode (#1385): `off` does nothing, `ask` offers it to
 * the person (#1388), `auto` does it unasked. Scoring reads its policies from `scorers/scoring.yaml` `sessions`,
 * publishing from `teamai.yaml` `sessions.publish`; a member's `config.yaml` overrides either, one mode at a time.
 */
import { z } from 'zod';
import { RunModeSchema, type RunMode } from '../launch-context.js';
import { usesBranchWorktree, type LocalConfig, type TeamaiConfig } from '../types.js';

/** Most restrictive first: where two files of one level disagree, the earlier policy wins. */
const POLICIES = ['off', 'ask', 'auto'] as const;
export type SessionPolicy = typeof POLICIES[number];
const SessionPolicySchema = z.enum(POLICIES);
const MappingSchema = z.record(z.string(), z.unknown());

/** What set a policy: its default, the setting `key` (such as `teamai.yaml sessions.publish.unattended`), or an HTTP team repo, which keeps no session archive. */
export type PolicySource = { kind: 'default' } | { kind: 'setting'; key: string } | { kind: 'http-team' };

/** The policy of each run mode, with what set it. */
export type SessionPolicies = Record<RunMode, { policy: SessionPolicy; source: PolicySource }>;

/**
 * The policies `value`, the setting `key` names (such as `teamai.yaml sessions.publish`), sets: a mapping of run modes
 * to policies, or with `booleans`, `true` for `auto` and `false` for `off` in both modes. Each value it cannot use is a
 * problem that names the key and what it allows, and sets nothing, so that mode falls to the next level.
 */
function read(key: string, value: unknown, { booleans = false }: { booleans?: boolean } = {}): { set: Partial<SessionPolicies>; problems: string[] } {
  if (booleans && typeof value === 'boolean') {
    const policy = value ? 'auto' : 'off';
    const source = { kind: 'setting', key } as const;
    return { set: { attended: { policy, source }, unattended: { policy, source } }, problems: [] };
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
    else set[mode.data] = { policy: parsed.data, source: { kind: 'setting', key: `${key}.${name}` } };
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
    return { policy: defaults[mode], source: { kind: 'default' } };
  };
  return { attended: of('attended'), unattended: of('unattended') };
}

/** What the `sessions` setting of `file` sets for `publish`, read as {@link read} reads it. */
function readPublish(file: string, sessions: unknown): { set: Partial<SessionPolicies>; problems: string[] } {
  if (sessions === undefined) return { set: {}, problems: [] };
  const mapping = MappingSchema.safeParse(sessions);
  if (!mapping.success) return { set: {}, problems: [`${file} sessions is ${JSON.stringify(sessions)}, not a mapping such as publish: { unattended: off }, so it is ignored`] };
  return read(`${file} sessions.publish`, mapping.data.publish ?? {});
}

/**
 * Each run mode's `sessions.publish` policy for this member: its `config.yaml`, else `teamai.yaml`, else the default.
 * An HTTP team keeps no session archive, so there every mode is `off`, with a problem while one would publish.
 */
function publish(config: LocalConfig, team: TeamaiConfig | null): { policies: SessionPolicies; problems: string[] } {
  const member = readPublish('config.yaml', config.sessions);
  const ofTeam = readPublish('teamai.yaml', team?.sessions);
  const policies = resolve([[member.set], [ofTeam.set]], { attended: 'ask', unattended: 'auto' });
  const problems = [...member.problems, ...ofTeam.problems];
  if (usesBranchWorktree(config)) return { policies, problems };
  const off = { policy: 'off', source: { kind: 'http-team' } } as const;
  const wouldPublish = policies.attended.policy !== 'off' || policies.unattended.policy !== 'off';
  return {
    policies: { attended: off, unattended: off },
    problems: wouldPublish ? [...problems, 'Sessions are not published: the team repo is an HTTP repo, which keeps no session archive, so sessions.publish acts as off'] : problems,
  };
}

export const SessionPolicy = { read, resolve, readPublish, publish } as const;
