/**
 * What teamai proposes to share one attended session with its default workflows `teamai-share-learnings` and
 * `teamai-share-session` (#1388): whether to publish the session, and which scorers judge it. The Stop
 * hook's friction reminder offers `teamai-share-learnings` and records the offer it made from these values, and
 * `workflow start --describe` proposes them, each with why, as the inputs of either workflow.
 */
import { loadTeamConfig } from './config.js';
import type { SessionRun } from './launch-context.js';
import { scopeScoring } from './scorers/settings.js';
import { AgentSession } from './session-flow/agent-session.js';
import { SessionPolicy, type SessionPolicies } from './session-flow/session-policy.js';
import { SessionWork, type SessionScorer } from './session-flow/session-work.js';
import { markFacts } from './scorers/score-plan.js';
import type { LocalConfig, SessionShareOffered } from './types.js';
import { WorkflowOffers } from './workflow-offers.js';
import type { OutputSchema } from './workflow/types.js';

/** teamai's default that shares what a session taught, then the session: the one the friction reminder offers. */
const SHARE_LEARNINGS = 'teamai-share-learnings';

/** A value teamai proposes for one input, and why it proposes that value. */
interface Proposal<T> {
  value: T;
  why: string;
}

/** What teamai proposes for each input of the input contract the share workflows have, for one session. */
interface SessionShareOffer {
  session: Proposal<string>;
  source: Proposal<string>;
  publish: Proposal<boolean>;
  scorers: Proposal<string[]>;
  demand: Proposal<'named'>;
}

const PUBLISH_WHY = 'Archive this session\'s transcript, scrubbed, for the team.';
const SCORERS_WHY = 'Scorers that judge this session now.';
const NAME_ANY = 'Name any scorer to judge with it.';
const DEMAND = { value: 'named', why: 'This session asks to be judged, so every scorer named judges it, sampled or not, and it counts toward daily_limit. auto samples it, as a background pass does.' } as const;

/** `items` as an English list: `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.slice(-1).join('')}` : items.join('');
}

function publishProposal(policy: SessionPolicies['attended']): Proposal<boolean> {
  switch (policy.policy) {
    case 'ask':
      return { value: true, why: `${PUBLISH_WHY} Proposed because the attended publish policy (${SessionPolicy.setBy(policy.source)}) is ask. It publishes once the run starts, with no other approval. Set it false to skip publishing.` };
    case 'off':
      return { value: false, why: `${PUBLISH_WHY} Not proposed: the attended publish policy (${SessionPolicy.setBy(policy.source)}) is off.` };
    case 'auto':
      return { value: false, why: `${PUBLISH_WHY} Not proposed: the attended publish policy is auto, so teamai publishes this session, scrubbed, once it has been idle 6 hours.` };
    default: {
      const unhandled: never = policy.policy;

      return unhandled;
    }
  }
}

/**
 * The open scorers of `sampled`. One that asks for verified isolation is proposed too: a driver that offers no verified
 * judge leaves its run open for one that does.
 */
function scorersProposal(sampled: readonly SessionScorer[]): Proposal<string[]> {
  if (sampled.length > 0) return { value: sampled.map(({ scorer }) => scorer), why: [SCORERS_WHY, samplingWhy(sampled), '[] skips scoring.'].join(' ') };

  return { value: [], why: [SCORERS_WHY, 'None proposed: no scorer samples this session.', NAME_ANY].join(' ') };
}

/** That `proposed`, one scorer or more, sample this session, with their sampling rates. */
function samplingWhy(proposed: readonly SessionScorer[]): string {
  const [only, ...more] = proposed;

  if (only !== undefined && more.length === 0) return `${only.scorer} samples this session (samplingRate ${only.definition.samplingRate}).`;

  return `${listOf(proposed.map(({ scorer, definition }) => `${scorer} (samplingRate ${definition.samplingRate})`))} sample this session.`;
}

interface OfferOptions {
  now?: string;
}

/**
 * What teamai proposes to share session `sessionId` of `tool` in this scope at `now`: publishing while the attended
 * publish policy is `ask`, and the open scorers that sample it while the attended scoring policy is `ask`. A tool
 * teamai reads no sessions from gets neither publishing nor scorers, since `session push` and `score` cannot read its
 * session.
 */
async function propose(config: LocalConfig, { tool, sessionId }: { tool: string; sessionId: string }, { now = new Date().toISOString() }: OfferOptions): Promise<Omit<SessionShareOffer, 'demand'>> {
  const platform = AgentSession.platformForTool(tool);
  const session = { value: sessionId, why: 'The session to share: this one.' };

  if (platform === undefined) {
    return {
      session, source: { value: tool, why: 'This session\'s tool.' },
      publish: { value: false, why: `${PUBLISH_WHY} Not proposed: teamai reads no sessions from ${tool}.` },
      scorers: { value: [], why: `${SCORERS_WHY} None proposed: teamai reads no sessions from ${tool}.` },
    };
  }

  const [team, scoring] = await Promise.all([loadTeamConfig(config.repo.localPath), scopeScoring(config)]);
  const publish = publishProposal(SessionPolicy.publish(config, team).policies.attended);
  const source = { value: platform, why: 'This session\'s tool, as teamai session list names it.' };

  if (!scoring.ok) return { session, source, publish, scorers: { value: [], why: `${SCORERS_WHY} None proposed: ${scoring.reason} ${NAME_ANY}` } };
  const policy = scoring.sessions.policies.attended;

  switch (policy.policy) {
    case 'ask': {
      const sampled = await SessionWork.sampledScorers(config, { platform, sessionId }, markFacts(config, now));

      return { session, source, publish, scorers: scorersProposal(sampled) };
    }

    case 'off':
      return { session, source, publish, scorers: { value: [], why: `${SCORERS_WHY} None proposed: the attended scoring policy (${SessionPolicy.setBy(policy.source)}) is off. ${NAME_ANY}` } };
    case 'auto':
      return { session, source, publish, scorers: { value: [], why: `${SCORERS_WHY} None proposed: the attended scoring policy is auto, so the background judge scores this session once it has been idle 6 hours. ${NAME_ANY}` } };
    default: {
      const unhandled: never = policy.policy;

      return unhandled;
    }
  }
}

/** Every proposal for session `sessionId` of `tool`, as describe gives them. */
async function offer(config: LocalConfig, session: { tool: string; sessionId: string }, options: OfferOptions = {}): Promise<SessionShareOffer> {
  const proposed = await propose(config, session, options);

  return { ...proposed, demand: DEMAND };
}

/**
 * What the friction reminder offers session `sessionId` of `tool`, whose Stop hook runs under `config` in `cwd`, in a
 * session of `run`: the `publish` and `scorers` describe proposes for it. Undefined, so the reminder stays today's,
 * where a hook may not offer teamai-share-learnings ({@link WorkflowOffers.offerable}), its own undone share run
 * included. The values are those of the scope a start would run in.
 */
async function reminderOffer(
  config: LocalConfig,
  { tool, sessionId, cwd, run }: { tool: string; sessionId: string; cwd: string; run: SessionRun },
  options: OfferOptions = {},
): Promise<SessionShareOffered | undefined> {
  const startConfig = await WorkflowOffers.offerable(config, SHARE_LEARNINGS, { sessionId, cwd, run });

  if (startConfig === undefined) return undefined;
  const { publish, scorers } = await propose(startConfig, { tool, sessionId }, options);

  return { publish: publish.value, scorers: scorers.value };
}

/** The inputs teamai proposes values for, by name and parsed type. */
const CONTRACT = {
  session: { type: 'string' },
  source: { type: 'string' },
  publish: { type: 'boolean' },
  scorers: { type: 'array', items: { type: 'string' } },
  demand: { type: 'enum', values: ['auto', 'named'] },
} as const satisfies Record<keyof SessionShareOffer, OutputSchema>;

const NO_SESSION_WHY = 'No agent session found: give the session and its tool.';

/**
 * What describe proposes for the declared `inputs` of either share workflow, by input: each input the contract names
 * with the same type, from {@link offer} for the calling session; with no agent session, only why for `session` and
 * `source`. Nothing for another input.
 */
async function proposals(
  config: LocalConfig,
  { inputs }: { inputs: Readonly<Record<string, OutputSchema>> },
  caller: { session: string | undefined; tool: string | undefined },
): Promise<Record<string, { value?: unknown; why: string }>> {
  const matching = WorkflowOffers.contractInputs(inputs, CONTRACT);

  if (matching.length === 0) return {};

  if (caller.session === undefined || caller.tool === undefined) {
    return Object.fromEntries(matching.filter((input) => input === 'session' || input === 'source').map((input) => [input, { why: NO_SESSION_WHY }]));
  }

  const proposed = await offer(config, { tool: caller.tool, sessionId: caller.session });

  return Object.fromEntries(matching.map((input) => [input, proposed[input]]));
}

export const SessionShare = { SHARE_LEARNINGS, offer, reminderOffer, proposals } as const;
