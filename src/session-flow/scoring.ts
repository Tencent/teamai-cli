/**
 * Judging a finished agent session with team scorers (#1178), on the judge, evidence and label store `src/scorers/`
 * keeps for every subject. The session is read redacted and goes only to the local judge; only its labels are published.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { observedModel } from '../agent-observation.js';
import { collectTeamSecrets } from '../env-resolution.js';
import { loadModelAliases } from '../models/aliases.js';
import { AttemptStore, newAttemptId, scoresDir } from '../scorers/attempts.js';
import { batchesScorers, verdictsOf } from '../scorers/batch.js';
import { cachedScorerNames, pinScorers } from '../scorers/cache.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import { answerSchema, evidenceDirOf, type Rubrics } from '../scorers/evidence.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scorerIsolationSource } from '../scorers/isolation.js';
import { scopeScoring } from '../scorers/settings.js';
import { installedJudgeTools, runLocalJudge, type JudgeTool } from '../scorers/judge.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import type { ScoreLabel } from '../scorers/label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from '../scorers/label-store.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { log } from '../utils/logger.js';
import { collectEnvSecrets, redact } from '../utils/redact.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { agentSessionFromEnv } from '../utils/session-id.js';
import { AgentSession } from './agent-session.js';
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import { SessionCaptures } from './captures.js';
import { judgeSession, sessionLabel, writeSessionEvidence } from './session-work.js';
import type { Session } from './ir.js';

function failure(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

/** What `teamai score --session <id> [--source <platform>] --scorer <name>… [--batch] [--push]` asks for. */
export interface SessionDemand {
  session?: string;
  source?: string;
  scorers: readonly [string, ...string[]];
  batch?: boolean;
  /** Publish the scope's pending labels after scoring, as `teamai score --push` does. */
  push?: boolean;
}

interface Asked {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  /** The scorer's `model` when it is an alias, also when the tool default judges in its place. */
  alias?: string;
}

async function sessionOf(config: LocalConfig, demand: SessionDemand): Promise<{ platform: string; sessionId: string } | Extract<WorkflowEnvelope, { error: unknown }>> {
  const env = await agentSessionFromEnv();
  const current = env.unambiguous && env.id ? { sessionId: env.id, platform: env.agent && AgentSession.platformForTool(env.agent) } : undefined;
  const sessionId = demand.session ?? current?.sessionId;
  if (sessionId === undefined) return { error: { code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' } };
  const captured = await SessionCaptures.platformsOf(config, sessionId);
  const platform = demand.source ?? (current?.sessionId === sessionId ? current.platform : undefined) ?? (captured.length === 1 ? captured[0] : undefined);
  if (platform !== undefined) return { platform, sessionId };
  const holding: string[] = [];
  for (const candidate of listInstalledPlatforms()) {
    if ((await AgentSession.find({ platform: candidate, sessionId }, { scrub: false })).status === 'done') holding.push(candidate);
  }
  return { error: { code: 'source_required', message: holding.length > 0
    ? `Pass --source with --session ${sessionId}: the platform that holds it. Found in: ${holding.join(', ')}.`
    : `No installed tool holds session ${sessionId}. Pass --source <platform> to read it from one of: ${listAvailablePlatforms().join(', ')}.` } };
}

/**
 * The config of the scope a session ran in, found from its directory as the hooks that captured it found it, else
 * `config`, with its workspace children, whose namespaces it receives too.
 */
async function scopeOf(config: LocalConfig, platform: string, session: Session): Promise<LocalConfig> {
  if (!session.cwd) return config;
  const { resolveHookConfig } = await import('../dashboard-collector.js');
  const resolved = await resolveHookConfig({ cwd: session.cwd, session_id: session.sessionId }, AgentSession.toolForPlatform(platform));
  return resolved ? readWorkspaceChildren(resolved) : config;
}

/**
 * Judges one finished session with the named scorers, whatever their sampling says, and keeps one label per scorer on
 * this machine, in the scope the session ran in, whichever scope `from` is. Scorers that resolve to the same tool and
 * model share one judge call with `--batch`, or when the team's `scorers/scoring.yaml` sets `batch`.
 */
export async function scoreSession(from: LocalConfig, demand: SessionDemand, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const named = await sessionOf(from, demand);
  if ('error' in named) return named;
  const { platform, sessionId } = named;
  const found = await AgentSession.find({ platform, sessionId }, { subagents: true });
  if (found.status !== 'done') return failure('session_not_found', found.failure.message);
  const { session } = found;
  if (session.sessionId !== sessionId) {
    const ids = (await AgentSession.list({ platforms: [platform], archived: true })).sessions.map((listed) => listed.sessionId).filter((id) => id.endsWith(sessionId)).sort();
    if (ids.length > 1) return failure('session_ambiguous', `--session ${sessionId} names more than one ${platform} session: ${ids.join(', ')}. Pass the whole id of one.`);
  }
  const config = await scopeOf(from, platform, session);
  const unavailable = scoringUnavailable(config);
  if (unavailable) return failure('scoring_unavailable', unavailable);
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return failure('scoring_settings_invalid', scoring.reason);
  const pins = await pinScorers(config, demand.scorers);
  const asked: Asked[] = [];
  for (const scorer of new Set(demand.scorers)) {
    const pin = pins[scorer];
    const definition = pin && pinnedDefinition(scorer, pin);
    if (!pin || !definition) {
      const known = await cachedScorerNames(config);
      return failure('scorer_not_found', `Scorer ${scorer} is not cached here. ${known.length > 0 ? `Scorers: ${known.join(', ')}.` : 'Run teamai pull to cache the team\'s scorers.'}`);
    }
    asked.push({ scorer, pin, definition });
  }
  log.info(`Scoring ${platform} session ${session.sessionId} in ${session.cwd || '(directory unknown)'}`);
  const envSecrets = { ...collectEnvSecrets(), ...await collectTeamSecrets(config) };
  const mask = (text: string): string => redact(text, { envSecrets });
  const judged = judgeSession({ platform, found, captures: await SessionCaptures.read(config, platform, session.sessionId), mask });
  const { subject, context: { prompt, used } } = judged;
  log.info(`First prompt: ${prompt || '(none)'}`);

  const tools = installedJudgeTools([]);
  if (tools.length === 0) {
    return failure('judge_tool_unavailable', 'No installed tool can run a scorer judge with every tool turned off. Install a supported version of Claude Code, Codex or OpenCode.');
  }
  const aliases = await loadModelAliases(config);
  const batch = demand.batch || batchesScorers({ team: scoring.batch });
  const groups: Array<{ choice: { tool: JudgeTool; model?: { name: string; effort?: string } }; members: [Asked, ...Asked[]] }> = [];
  for (const member of asked) {
    const chosen = chooseJudgeModel(aliases, member.definition, tools);
    if (!chosen.ok) return failure('judge_model_unavailable', chosen.message);
    if (chosen.note) log.info(chosen.note);
    const judged = { ...member, ...(chosen.choice.alias !== undefined ? { alias: chosen.choice.alias } : {}) };
    const group = batch ? groups.find(({ choice }) => choice.tool === chosen.choice.tool && choice.model?.name === chosen.choice.model?.name && choice.model?.effort === chosen.choice.model?.effort) : undefined;
    if (group) group.members.push(judged);
    else groups.push({ choice: chosen.choice, members: [judged] });
  }
  const answers: Array<Record<string, unknown>> = [];
  for (const { choice, members } of groups) {
    const [head, ...tail] = members;
    const rubrics: Rubrics = [head.definition, ...tail.map((member) => member.definition)];
    const attempt = newAttemptId();
    const evidence = evidenceDirOf(scoresDir(config), attempt);
    try {
      await writeSessionEvidence(evidence, judged, rubrics);
      const required = requiredIsolation([...scoring.isolation, ...members.map(({ scorer, pin, definition }) => ({ source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }))]);
      const result = await runLocalJudge({ tool: choice.tool, model: choice.model, evidence, schema: answerSchema(rubrics), isolation: required.level });
      const verdicts = result.ok ? verdictsOf(members, (member) => member.definition, result.answer) : undefined;
      if (!result.ok || !verdicts?.ok) {
        const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
        let saved = '';
        if (raw !== undefined) {
          const file = path.join(scoresDir(config), 'raw', `${attempt}.txt`);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, raw, { mode: 0o600 });
          saved = ` Output saved to ${file}.`;
        }
        return result.ok
          ? failure('judge_answer_invalid', `The judge's answer names no label of the scorer: ${verdicts && !verdicts.ok ? verdicts.message : ''} No label was written.${saved}`)
          : failure(result.code, result.message + (result.code === 'judge_tool_unavailable' && required.level === 'verified' ? ` ${required.setBy.join(' and ')} asks for verified.` : '') + saved);
      }
      const labels = verdicts.verdicts.map(({ judged: member, label, passed, reasoning }) => {
        const model = observedModel({ ...result.judge.model, alias: member.alias });
        return { reasoning, label: sessionLabel({
          scorer: member.scorer,
          rubric: { sourceHash: member.pin.sourceHash, ...(member.pin.teamRevision ? { teamRevision: member.pin.teamRevision } : {}) },
          label: label.value,
          score: label.score,
          passed,
          judge: { kind: 'model', ...result.judge, ...(model ? { model } : {}), ...(members.length > 1 ? { batched: true as const } : {}) },
          scoredAt: now,
        }, subject, judged.context) };
      });
      const stored = await AttemptStore.locked(config, async () => {
        const kept: Array<{ label: ScoreLabel; id: string; version: string }> = [];
        for (const { label, reasoning } of labels) kept.push({ label, ...await LabelStore.append(config, label, reasoning, prompt) });
        return kept;
      });
      if (stored.status === 'busy') return failure('busy', 'Another teamai process holds the label store, so no label was written. Score the session again.');
      for (const { label, id, version } of stored.value) {
        const file = reasoningPath(config, version);
        log.info(`${label.scorer}: ${label.label} (score ${label.score}, ${label.passed ? 'passed' : 'did not pass'}). Reasoning: ${file}`);
        if (!label.passed) log.info(shareFailedLabelHint(file, session.sessionId));
        answers.push({ scorer: label.scorer, subject, label: label.label, score: label.score, passed: label.passed, ...(used.skills.length > 0 ? { used } : {}), labelId: id, reasoning: file });
      }
    } finally {
      await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const [only, ...more] = answers;
  const scored = only && more.length === 0 ? { label: only } : { labels: answers };
  if (!demand.push) return { data: scored };
  const pushed = await LabelStore.push(config);
  return 'data' in pushed ? { data: { ...scored, ...pushed.data } } : pushed;
}
