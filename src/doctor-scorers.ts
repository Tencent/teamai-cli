import { loadModelAliases } from './models/aliases.js';
import { cachedScorerNames, loadCachedScorer } from './scorers/cache.js';
import { formatScorerDiagnostic } from './scorers/definition.js';
import { confinedToolLevels, installedConfinedTools } from './tool-launch/confined.js';
import { CONFINED_TOOLS } from './tool-launch/tools.js';
import { chooseJudgeModel } from './scorers/judge-model.js';
import { scoringUnavailable } from './scorers/home.js';
import { Marks } from './scorers/marks.js';
import { requiredIsolation, unknownIsolationText } from './scorers/isolation.js';
import { scopeScoring, upvoteJudgeAliasNotes, type SessionScoring } from './scorers/settings.js';
import { RUN_MODES } from './launch-context.js';
import { SessionPolicy, type PolicySource } from './session-flow/session-policy.js';
import type { LocalConfig } from './types.js';
import { isSilent, setSilent } from './utils/logger.js';
import { syncTeamDefinitions } from './benchmark/suite-cache.js';
import { formatUnknownScorer } from './scorers/team-sync.js';

/** What scoring in this scope follows: its isolation, what decides session judging, and the problems with its settings. */
async function scoringNotes(localConfig: LocalConfig, verified: readonly string[]): Promise<string[]> {
  const scoring = await scopeScoring(localConfig);

  if (!scoring.ok) return [scoring.reason];
  const required = requiredIsolation(scoring.isolation);
  const setBy = required.setBy.length > 0 ? `set by ${required.setBy.join(' and ')}` : 'the default';
  const [only, ...more] = verified;

  const raising = required.level === 'best-effort' && only
    ? [more.length === 0 ? `${only} asks for verified for its own work.` : `${verified.slice(0, -1).join(', ')} and ${verified.at(-1)} ask for verified for their own work.`]
    : [];

  return [
    [`Scoring isolation: ${required.level}, ${setBy}.`, ...required.unknown.map((unknown) => `${unknownIsolationText(unknown)}.`), ...raising].join(' '),
    ...sessionJudgingNote(scoring.sessions),
    ...scoring.problems.map((problem) => `${problem}.`),
  ];
}

/** Each run mode's session judging policy and the daily limit, with what set each, once a setting rather than the default does. */
function sessionJudgingNote({ policies, dailyLimit, dailyLimitSource }: SessionScoring): string[] {
  const sources = [...RUN_MODES.map((mode) => policies[mode].source), dailyLimitSource];

  if (sources.every((source) => source.kind === 'default')) return [];
  const named = (source: PolicySource) => (source.kind === 'default' ? 'the default' : `set by ${SessionPolicy.setBy(source)}`);
  const modes = RUN_MODES.map((mode) => `${mode} ${policies[mode].policy}, ${named(policies[mode].source)}`);

  return [`Session judging: ${[...modes, `up to ${dailyLimit} sessions a day, ${named(dailyLimitSource)}`].join('; ')}.`];
}

async function judgeToolsNote(resolveTool: ResolveTool | undefined): Promise<string> {
  const tools = await confinedToolLevels(resolveTool ? { resolveTool } : {});

  if (tools.length === 0) return `Judge tools here: none on PATH. Install one of: ${CONFINED_TOOLS.join(', ')} to judge on this machine.`;

  return `Judge tools here: ${tools.map(({ tool, version, isolation }) => `${tool} ${version || '(version unknown)'} is ${isolation}`).join(', ')}.`;
}

/**
 * For each cached scorer with a `model`, why the judge tools on this machine cannot run it, or why the tool default
 * judges in its place. Says nothing when no judge tool is installed.
 */
async function scorerModelNotes(localConfig: LocalConfig, resolveTool: ResolveTool | undefined): Promise<string[]> {
  const tools = installedConfinedTools([], resolveTool ? { resolveTool } : {});

  if (tools.length === 0) return [];
  const aliases = await loadModelAliases(localConfig);
  const notes: string[] = [];

  for (const name of await cachedScorerNames(localConfig)) {
    const definition = (await loadCachedScorer(localConfig, name))?.definition;

    if (definition?.model === undefined) continue;
    const chosen = chooseJudgeModel(aliases, definition, tools);
    const note = chosen.ok ? chosen.note : chosen.message;

    if (note) notes.push(note);
  }

  return notes;
}

type ResolveTool = (tool: string) => string | null;

/** How much open judge work the upgrade to marks carried over from judge attempts, when it carried any. */
async function carriedNote(localConfig: LocalConfig): Promise<string[]> {
  const carried = await Marks.carriedOver(localConfig, { now: new Date().toISOString() });
  const counted = (count: number, one: string, many: string) => (count === 0 ? [] : [`${count} ${count === 1 ? one : many}`]);
  const parts = [...counted(carried?.passes ?? 0, 'open workflow pass', 'open workflow passes'), ...counted(carried?.sessions ?? 0, 'open session', 'open sessions')];

  return parts.length === 0 ? [] : [`The upgrade carried ${parts.join(' and ')} over from judge attempts into marks. The next teamai score --drain, or a session start where sessions are judged or archived automatically, starts teamai-score for each, and for a pass only while its run last changed under 14 days ago.`];
}

/**
 * What a pull says about scorers, for members whose pull ran silently from a hook: each invalid file in `scorers/`, and
 * each scorer a workflow step lists that has no valid file. Also, when the team has scorers, why this install cannot
 * score, or else the isolation every judge needs, what sets it, the scorers that ask for more, and the level each judge
 * tool here reaches. Dry-run, so no cache changes.
 */
export async function scorerNotes(localConfig: LocalConfig, { resolveTool }: { resolveTool?: ResolveTool } = {}): Promise<string[]> {
  const wasSilent = isSilent();
  setSilent(true);

  try {
    const result = await syncTeamDefinitions(localConfig, { dryRun: true });
    const scored = result.scorers.cached.length > 0;
    const unavailable = scored ? scoringUnavailable(localConfig) : undefined;

    return [
      ...upvoteJudgeAliasNotes(),
      ...(unavailable ? [unavailable] : scored ? [...await scoringNotes(localConfig, result.scorers.verified), await judgeToolsNote(resolveTool)] : []),
      ...result.scorers.invalid.map((diagnostic) => `Invalid scorer: ${formatScorerDiagnostic(diagnostic)}`),
      ...result.unknownScorers.map((unknown) => `Unknown scorer: ${formatUnknownScorer(unknown)}`),
      ...await scorerModelNotes(localConfig, resolveTool),
      ...await carriedNote(localConfig),
    ];
  } catch (error) {
    return [`Scorers could not be checked: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setSilent(wasSilent);
  }
}
