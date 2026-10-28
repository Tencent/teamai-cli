/**
 * What teamai proposes to close one attended session with its default `session-close` workflow (#1388): whether to
 * publish the session, which scorers judge it, and who judges. The Stop hook's friction reminder records the offer it
 * made from these values, and `workflow start --describe` proposes them, each with why, as the workflow's inputs.
 */
import { loadTeamConfig } from './config.js';
import { requiredIsolation, scorerIsolationSource } from './scorers/isolation.js';
import { installedJudgeTools } from './scorers/judge.js';
import { scopeScoring } from './scorers/settings.js';
import { AgentSession } from './session-flow/agent-session.js';
import { SessionPolicy, type PolicySource, type SessionPolicies } from './session-flow/session-policy.js';
import { SessionWork, type SampledScorer } from './session-flow/session-work.js';
import type { LocalConfig } from './types.js';
import type { OutputSchema } from './workflow/types.js';

/** The name of teamai's default close-out workflow, and of a team file that replaces it. */
const NAME = 'session-close';

/** A value teamai proposes for one input, and why it proposes that value. */
export interface Proposal<T> {
  value: T;
  why: string;
}

/** What teamai proposes for each input of the session-close input contract, for one session. */
export interface SessionCloseOffer {
  session: Proposal<string>;
  source: Proposal<string>;
  publish: Proposal<boolean>;
  scorers: Proposal<string[]>;
  judge: Proposal<'here' | 'driver'>;
}

const PUBLISH_WHY = 'Archive this session\'s transcript, scrubbed, for the team.';
const SCORERS_WHY = 'Scorers that judge this session now.';
const NAME_ANY = 'Name any scorer to judge with it.';

/** `items` as an English list: `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}` : items.join('');
}

/** What set a policy, as a reason names it. */
function setBy(source: PolicySource): string {
  switch (source.kind) {
    case 'default':
      return 'the default';
    case 'setting':
      return source.key;
    case 'http-team':
      return 'the team repo, an HTTP repo that keeps no session archive';
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
}

function publishProposal(policy: SessionPolicies['attended']): Proposal<boolean> {
  switch (policy.policy) {
    case 'ask':
      return { value: true, why: `${PUBLISH_WHY} Proposed because the attended publish policy (${setBy(policy.source)}) is ask. You confirm it again from your own terminal or the dashboard before it runs.` };
    case 'off':
      return { value: false, why: `${PUBLISH_WHY} Not proposed: the attended publish policy (${setBy(policy.source)}) is off.` };
    case 'auto':
      return { value: false, why: `${PUBLISH_WHY} Not proposed: the attended publish policy is auto, so teamai publishes this session, scrubbed, once it has been idle 6 hours.` };
    default: {
      const unhandled: never = policy.policy;
      return unhandled;
    }
  }
}

/** The files that ask a scorer's judge for verified isolation, by the sources `requiredIsolation` names. */
function filesOf(sources: readonly string[]): string {
  return listOf(sources.map((source) => source.replace(/ isolation$/, '')));
}

/**
 * The open scorers of `sampled`, without those whose required isolation is verified when `judge` is the session's
 * agent, which judges only best-effort.
 */
function scorersProposal(sampled: readonly SampledScorer[], { judge, team }: { judge: 'here' | 'driver'; team: Parameters<typeof requiredIsolation>[0] }): Proposal<string[]> {
  const open = sampled.filter(({ state }) => state.kind === 'open');
  const verifiedBy = (one: SampledScorer) => {
    const required = requiredIsolation([...team, { source: scorerIsolationSource(one.scorer, one.pin.relativePath), value: one.definition.isolation }]);
    return judge === 'driver' && required.level === 'verified' ? required.setBy : undefined;
  };
  const proposed = open.filter((one) => verifiedBy(one) === undefined);
  const leftOut = new Map<string, string[]>();
  for (const one of open) {
    const files = verifiedBy(one);
    if (files) leftOut.set(filesOf(files), [...leftOut.get(filesOf(files)) ?? [], one.scorer]);
  }
  const left = [...leftOut].map(([files, scorers]) => `${listOf(scorers)} ${scorers.length > 1 ? 'are' : 'is'} left out: ${files} ${files.includes(' and ') ? 'ask' : 'asks'} for verified isolation, which this session's agent cannot give.`);
  const sampling = proposed.length === 1
    ? [`${proposed[0]?.scorer} samples this session (samplingRate ${proposed[0]?.definition.samplingRate}).`]
    : proposed.length > 1 ? [`${listOf(proposed.map(({ scorer, definition }) => `${scorer} (samplingRate ${definition.samplingRate})`))} sample this session.`] : [];
  if (proposed.length > 0) return { value: proposed.map(({ scorer }) => scorer), why: [SCORERS_WHY, ...sampling, ...left, '[] skips scoring.'].join(' ') };
  return { value: [], why: [SCORERS_WHY, `None proposed: ${left.length > 0 ? left.join(' ') : 'no scorer samples this session.'}`, NAME_ANY].join(' ') };
}

/**
 * What teamai proposes to close session `sessionId` of `tool` in this scope at `now`: publishing while the attended
 * publish policy is `ask`, the open scorers that sample it while the attended scoring policy is `ask`, and teamai's own
 * judge when one of `judgeTools`, the judge tools installed on this machine, is there, else the session's agent. A tool
 * teamai reads no sessions from gets neither publishing nor scorers, since `session push` and `score` cannot read its
 * session.
 */
async function offer(
  config: LocalConfig,
  { tool, sessionId }: { tool: string; sessionId: string },
  { now = new Date().toISOString(), judgeTools = installedJudgeTools([]) }: { now?: string; judgeTools?: readonly string[] } = {},
): Promise<SessionCloseOffer> {
  const [installed] = judgeTools;
  const judge: Proposal<'here' | 'driver'> = installed
    ? { value: 'here', why: `${installed} is installed here, so teamai's own judge scores it.` }
    : { value: 'driver', why: 'No judge tool teamai runs is installed here, so this session\'s agent judges, best-effort.' };
  const platform = AgentSession.platformForTool(tool);
  const session = { value: sessionId, why: 'The session to close: this one.' };
  if (platform === undefined) {
    return {
      session, source: { value: tool, why: 'This session\'s tool.' }, judge,
      publish: { value: false, why: `${PUBLISH_WHY} Not proposed: teamai reads no sessions from ${tool}.` },
      scorers: { value: [], why: `${SCORERS_WHY} None proposed: teamai reads no sessions from ${tool}.` },
    };
  }
  const [team, scoring] = await Promise.all([loadTeamConfig(config.repo.localPath), scopeScoring(config)]);
  const publish = publishProposal(SessionPolicy.publish(config, team).policies.attended);
  const source = { value: platform, why: 'This session\'s tool, as teamai session list names it.' };
  if (!scoring.ok) return { session, source, publish, judge, scorers: { value: [], why: `${SCORERS_WHY} None proposed: ${scoring.reason} ${NAME_ANY}` } };
  const policy = scoring.sessions.policies.attended;
  switch (policy.policy) {
    case 'ask': {
      const sampled = await SessionWork.sampledScorers(config, { platform, sessionId }, now);
      return { session, source, publish, judge, scorers: scorersProposal(sampled, { judge: judge.value, team: scoring.isolation }) };
    }
    case 'off':
      return { session, source, publish, judge, scorers: { value: [], why: `${SCORERS_WHY} None proposed: the attended scoring policy (${setBy(policy.source)}) is off. ${NAME_ANY}` } };
    case 'auto':
      return { session, source, publish, judge, scorers: { value: [], why: `${SCORERS_WHY} None proposed: the attended scoring policy is auto, so the background judge scores this session once it has been idle 6 hours. ${NAME_ANY}` } };
    default: {
      const unhandled: never = policy.policy;
      return unhandled;
    }
  }
}

/**
 * The inputs teamai proposes values for, by name and parsed type. A team override that declares one with the same name
 * and type gets it filled; an enum matches in any order.
 */
const CONTRACT = {
  session: { type: 'string' },
  source: { type: 'string' },
  publish: { type: 'boolean' },
  scorers: { type: 'array', items: { type: 'string' } },
  judge: { type: 'enum', values: ['here', 'driver'] },
} as const satisfies Record<keyof SessionCloseOffer, OutputSchema>;

function isContractInput(name: string): name is keyof SessionCloseOffer {
  return Object.hasOwn(CONTRACT, name);
}

function sameType(left: OutputSchema, right: OutputSchema): boolean {
  if (left.type === 'enum' && right.type === 'enum') return [...left.values].sort().join('\0') === [...right.values].sort().join('\0');
  return JSON.stringify(left) === JSON.stringify(right);
}

const NO_SESSION_WHY = 'No agent session found: give the session and its tool.';

/**
 * What describe proposes for the declared `inputs` of the workflow `name` resolves to, by input: for `session-close`,
 * each input the contract names with the same type, from {@link offer} for the calling session; with no agent session,
 * only why for `session` and `source`. Nothing for another workflow or another input.
 */
async function proposals(
  config: LocalConfig,
  { name, inputs }: { name: string; inputs: Readonly<Record<string, OutputSchema>> },
  caller: { session: string | undefined; tool: string | undefined },
): Promise<Record<string, { value?: unknown; why: string }>> {
  if (name !== NAME) return {};
  const matching = Object.entries(inputs).flatMap(([input, type]) => (isContractInput(input) && sameType(type, CONTRACT[input]) ? [input] : []));
  if (matching.length === 0) return {};
  if (caller.session === undefined || caller.tool === undefined) {
    return Object.fromEntries(matching.filter((input) => input === 'session' || input === 'source').map((input) => [input, { why: NO_SESSION_WHY }]));
  }
  const proposed = await offer(config, { tool: caller.tool, sessionId: caller.session });
  return Object.fromEntries(matching.map((input) => [input, proposed[input]]));
}

export const SessionClose = { NAME, offer, proposals } as const;
