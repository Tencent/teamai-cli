/**
 * What one pass of a step ran as (#1176): the definition and how the launch
 * applied it, the tool and its version, the requested and reported model and
 * effort, the team revision delivered to the checkout, the project commit, the
 * CLI version and the driver kind, with a fingerprint over the parts two
 * passes can be compared by.
 *
 * A driver reports what it observed (`ReportedAgent`); the engine settles it
 * (`settleObservation`), stamping what it owns and dropping what is not shaped
 * like a name, so the value it saves is the value a run record publishes.
 * Readers of a record get `RecordedAgent`, which also covers the string
 * `agent` of records written before.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { getAgentVersion } from './agent-version.js';
import { getCurrentVersion } from './package-info.js';
import { recordedUnchanged } from './resources/delivered-copies.js';
import type { LocalConfig } from './types.js';
import { getHeadState } from './utils/git.js';

/**
 * A model as a driver reports it, such as `claude-sonnet-4.6` or `anthropic/claude-sonnet-4.6@2026`. A report is free
 * text, so a record carries one only when it is shaped like a name: no leading "/", no drive such as "C:", no ":/" as
 * in a URL, no "..", no spaces, and at most 80 characters.
 */
const NAME = /^(?![A-Za-z]:)(?!.*:\/)(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;
/** A tool name, version or effort, such as `claude`, `2.1.301` or `high`: a name with no "/" or ":", which only models need. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const Name = z.string().regex(NAME);
const Label = z.string().regex(LABEL);
const Applied = z.enum(['main', 'prompt', 'subagent']);

/** What one pass of a step ran as. Every field is best effort: absent when not observed, never inferred. */
export const AgentObservationSchema = z.object({
  v: z.literal(1),
  definition: z.object({ name: z.string().min(1), applied: Applied.optional() }).optional(),
  tool: z.object({ name: Label, version: Label.optional() }),
  model: z.object({ requested: Name.optional(), reported: Name.optional(), alias: Name.optional() }).optional(),
  effort: z.object({ requested: Label.optional(), reported: Label.optional() }).optional(),
  team: z.object({ revision: z.string().regex(COMMIT), localChanges: z.boolean() }).optional(),
  project: z.object({ commit: z.string().regex(COMMIT), dirty: z.boolean() }).optional(),
  teamai: z.string(),
  driver: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type AgentObservation = z.infer<typeof AgentObservationSchema>;

/**
 * What a driver may report. It has no key the engine owns (definition.name, teamai, driver) and no fingerprint. Zod
 * strips those keys, so a driver that sends them is accepted and ignored. `tool.name` and `model.reported` count only
 * when the report has no flat `tool` or `model`. Values are plain strings: one not shaped like a name is dropped when
 * the pass settles, not rejected.
 */
const ReportedAgentSchema = z.object({
  definition: z.object({ applied: Applied.optional() }).optional(),
  tool: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  model: z.object({ requested: z.string().optional(), reported: z.string().optional(), alias: z.string().optional() }).optional(),
  effort: z.object({ requested: z.string().optional(), reported: z.string().optional() }).optional(),
  team: z.object({ revision: z.string(), localChanges: z.boolean() }).optional(),
  project: z.object({ commit: z.string(), dirty: z.boolean() }).optional(),
});
export type ReportedAgent = z.infer<typeof ReportedAgentSchema>;

const DefinitionOnlySchema = z.object({ definition: z.object({ name: z.string().min(1) }) });

/**
 * A step entry's `agent` as a reader finds it: a full observation, or only the definition's name, for a record written
 * before #1176 and for a pass nothing observed, such as a skipped step.
 */
export type RecordedAgent = AgentObservation | z.infer<typeof DefinitionOnlySchema>;

export function isNameShaped(value: string): boolean {
  return NAME.test(value);
}

/** What a launch hands the observer. */
export type ToolLaunch = {
  /** Locates the checkout record: the driver's config, not the step's cwd, which may be a subdirectory. */
  config: LocalConfig;
  /** The exact tool id launched; a version is detected only under this id. */
  tool: string;
  cwd: string;
  definition?: {
    /** The deployed file's stem, the key of `agentModels`. */
    stem: string;
    /** The absolute path the launch read, the key of `delivered`. */
    file: string;
    /** The definition's model the launch passes on argv (Codex, OpenCode); absent when the tool reads its own file. */
    model?: string;
    /** The definition's effort the launch passes on argv with its model (an OpenCode variant). */
    effort?: string;
  };
  /** The model the step or its `defaults.model` chose, which the launch passes on argv in place of the definition's. */
  chosen?: { model: string; effort?: string; alias?: string };
};

/** Observe a launch before the tool starts. Never throws: each field it cannot observe is left out. */
export async function observeLaunch(launch: ToolLaunch): Promise<ReportedAgent> {
  const { teamDelivery } = await import('./pull.js');
  const [version, delivery, head] = await Promise.all([
    getAgentVersion(launch.tool),
    teamDelivery(launch.config, launch.tool).catch(() => undefined),
    getHeadState(launch.cwd).catch(() => null),
  ]);
  const record = delivery?.record;
  const definition = launch.definition;
  const resolved = definition && await recordedUnchanged(record?.delivered, definition.file)
    ? record?.agentModels?.[definition.stem]?.[launch.tool]
    : undefined;
  const { chosen } = launch;
  const model = chosen
    ? names({ requested: chosen.model, alias: chosen.alias })
    : definition?.model
      ? names({ requested: definition.model, alias: resolved?.model === definition.model ? resolved.alias : undefined })
      // With no model on argv, the tool runs the one its deployed file sets, as the pull recorded it.
      : definition ? names({ requested: resolved?.model, alias: resolved?.alias }) : undefined;
  // The effort requested is the one the launch passes on argv. Claude does not apply an agent file's `effort:` under
  // `--agent`, so the file's value is not what ran.
  const effort = names({ requested: chosen ? chosen.effort : definition?.effort }, LABEL);
  const team = delivery?.complete
    ? { revision: delivery.commit, localChanges: !await allUnchanged(delivery.record.delivered ?? {}) }
    : undefined;
  return {
    ...(version ? { tool: { version } } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(team ? { team } : {}),
    ...(head ? { project: { commit: head.head, dirty: head.dirty } } : {}),
  };
}

function names<T extends Record<string, string | undefined>>(values: T, shape = NAME): Partial<T> | undefined {
  const kept = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && shape.test(value)));
  return Object.keys(kept).length > 0 ? kept as Partial<T> : undefined;
}

async function allUnchanged(delivered: Record<string, string>): Promise<boolean> {
  const unchanged = await Promise.all(Object.keys(delivered).map((file) => recordedUnchanged(delivered, file)));
  return unchanged.every(Boolean);
}

/**
 * The observation a pass settles with: the report's agent, filtered to name-shaped values, plus what the engine owns,
 * and its fingerprint. `definition` is the step's `agent:`; the driver's `applied` is kept only when the step has one.
 * Undefined when the report has no agent, or its tool is not shaped like a name.
 */
export function settleObservation(
  report: { agent?: ReportedAgent; tool?: string; model?: string; driver: { kind: string } },
  definition: string | undefined,
): AgentObservation | undefined {
  const reported = report.agent;
  const tool = report.tool ?? reported?.tool?.name;
  if (!reported || !tool || !LABEL.test(tool)) return undefined;
  const model = names({
    requested: reported.model?.requested,
    reported: report.model ?? reported.model?.reported,
    alias: reported.model?.alias,
  });
  const effort = names({ requested: reported.effort?.requested, reported: reported.effort?.reported }, LABEL);
  const team = reported.team && COMMIT.test(reported.team.revision) ? reported.team : undefined;
  const project = reported.project && COMMIT.test(reported.project.commit) ? reported.project : undefined;
  const version = !reported.tool?.name || reported.tool.name === tool ? reported.tool?.version : undefined;
  const applied = reported.definition?.applied;
  const observation: AgentObservation = {
    v: 1,
    ...(definition ? { definition: { name: definition, ...(applied ? { applied } : {}) } } : {}),
    tool: { name: tool, ...(version && LABEL.test(version) ? { version } : {}) },
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(team ? { team } : {}),
    ...(project ? { project } : {}),
    teamai: getCurrentVersion(),
    driver: report.driver.kind,
  };
  const fingerprint = fingerprintOf(observation);
  return fingerprint ? { ...observation, fingerprint } : observation;
}

/**
 * The sha256 of the comparable parts as recorded, or undefined when they do not name what ran: no model, no team
 * revision, or a checkout with local changes. It claims only that these parts are equal. The project, the CLI and the
 * driver are outside it, and so are the member's own config and hook context.
 */
function fingerprintOf(observation: AgentObservation): string | undefined {
  const { v, definition, tool, model, effort, team } = observation;
  if (!(model?.requested ?? model?.reported) || !team || team.localChanges) return undefined;
  return crypto.createHash('sha256').update(canonicalJson({ v, definition, tool, model, effort, team }), 'utf8').digest('hex');
}

/** JSON with object keys sorted at every depth, undefined values left out, and no whitespace. */
function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Parse the `agent` field of a report payload, or return an `invalid_report` message for a wrong JSON type. */
export function parseReportedAgent(value: unknown): ReportedAgent | string {
  const parsed = ReportedAgentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = ['agent', ...(issue?.path ?? [])].join('.');
  return issue?.code === 'invalid_type' ? `${field} must be ${article(issue.expected)}` : `${field} is invalid`;
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/** Read a published entry's `agent`, old or new: a string as `{ definition: { name } }`, an observation as it is. */
export function readRecordedAgent(value: unknown): RecordedAgent | undefined {
  if (typeof value === 'string') return value ? { definition: { name: value } } : undefined;
  const observation = AgentObservationSchema.safeParse(value);
  if (observation.success) return observation.data;
  const definitionOnly = DefinitionOnlySchema.safeParse(value);
  return definitionOnly.success ? definitionOnly.data : undefined;
}
