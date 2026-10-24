import { loadModelAliases } from './models/aliases.js';
import { cachedScorerNames, loadCachedScorer } from './scorers/cache.js';
import { formatScorerDiagnostic } from './scorers/definition.js';
import { installedJudgeTools, judgeToolLevels } from './scorers/judge.js';
import { chooseJudgeModel } from './scorers/judge-model.js';
import { scoringUnavailable } from './scorers/home.js';
import { requiredIsolation, unknownIsolationText } from './scorers/isolation.js';
import { scopeScoring } from './scorers/settings.js';
import type { LocalConfig } from './types.js';
import { isSilent, setSilent } from './utils/logger.js';
import { formatUnknownScorer, syncWorkflowDefinitions } from './workflow/cache.js';

async function isolationNotes(localConfig: LocalConfig, verified: readonly string[]): Promise<string[]> {
  const scoring = await scopeScoring(localConfig);
  if (!scoring.ok) return [scoring.reason];
  const required = requiredIsolation(scoring.isolation);
  const setBy = required.setBy.length > 0 ? `set by ${required.setBy.join(' and ')}` : 'the default';
  const [only, ...more] = verified;
  const raising = required.level === 'best-effort' && only
    ? [more.length === 0 ? `${only} asks for verified for its own work.` : `${verified.slice(0, -1).join(', ')} and ${verified.at(-1)} ask for verified for their own work.`]
    : [];
  return [[`Scoring isolation: ${required.level}, ${setBy}.`, ...required.unknown.map((unknown) => `${unknownIsolationText(unknown)}.`), ...raising].join(' '), ...scoring.problems.map((problem) => `${problem}.`)];
}

async function judgeToolsNote(resolveTool: ResolveTool | undefined): Promise<string> {
  const tools = await judgeToolLevels(resolveTool ? { resolveTool } : {});
  if (tools.length === 0) return 'Judge tools here: none on PATH. Install Claude Code, Codex, OpenCode or CodeBuddy to judge on this machine.';
  return `Judge tools here: ${tools.map(({ tool, version, isolation }) => `${tool} ${version || '(version unknown)'} is ${isolation}`).join(', ')}.`;
}

/**
 * For each cached scorer with a `model`, why the judge tools on this machine cannot run it, or why the tool default
 * judges in its place. Says nothing when no judge tool is installed.
 */
async function scorerModelNotes(localConfig: LocalConfig, resolveTool: ResolveTool | undefined): Promise<string[]> {
  const tools = installedJudgeTools([], resolveTool ? { resolveTool } : {});
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
    const result = await syncWorkflowDefinitions(localConfig, { dryRun: true });
    const scored = result.scorers.cached.length > 0;
    const unavailable = scored ? scoringUnavailable(localConfig) : undefined;
    return [
      ...(unavailable ? [unavailable] : scored ? [...await isolationNotes(localConfig, result.scorers.verified), await judgeToolsNote(resolveTool)] : []),
      ...result.scorers.invalid.map((diagnostic) => `Invalid scorer: ${formatScorerDiagnostic(diagnostic)}`),
      ...result.unknownScorers.map((unknown) => `Unknown scorer: ${formatUnknownScorer(unknown)}`),
      ...await scorerModelNotes(localConfig, resolveTool),
    ];
  } catch (error) {
    return [`Scorers could not be checked: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setSilent(wasSilent);
  }
}
