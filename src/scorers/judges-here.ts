/** Which judges this machine has for a set of scorers, at the isolation the team, each scorer and this machine ask for. */
import { loadModelAliases } from '../models/aliases.js';
import { confinedOffers } from '../tool-launch/confined.js';
import type { LocalConfig } from '../types.js';
import { pinScorers } from './cache.js';
import { scoringUnavailable } from './home.js';
import { requiredIsolation, scorerIsolationSource, type IsolationSetting, type RequiredIsolation } from './isolation.js';
import { chooseJudgeModel } from './judge-model.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import type { ScorerDefinition } from './definition.js';
import { scopeScoring } from './settings.js';

function requiredFor(settings: readonly IsolationSetting[], scorer: string, pin: PinnedScorer, definition: ScorerDefinition): RequiredIsolation {
  return requiredIsolation([...settings, { source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }]);
}

/**
 * The scorers among `names` whose judge must be `verified` here, as the team, the scorer and this machine ask; or why
 * this scope's scoring settings cannot be read. A scorer is read as `pinned` holds it, such as a run's, else as cached now.
 */
export async function verifiedScorers(config: LocalConfig, names: readonly string[], pinned?: Record<string, PinnedScorer>): Promise<{ ok: true; scorers: string[] } | { ok: false; reason: string }> {
  const scoring = await scopeScoring(config);

  if (!scoring.ok) return scoring;
  const pins = Object.entries(pinned ?? await pinScorers(config, names)).filter(([scorer]) => names.includes(scorer));

  return { ok: true, scorers: pins.flatMap(([scorer, pin]) => {
    const definition = pinnedDefinition(scorer, pin);

    return definition && requiredFor(scoring.isolation, scorer, pin, definition).level === 'verified' ? [scorer] : [];
  }) };
}

/**
 * Why this machine cannot judge with `scorers`, or undefined: scoring is off in this scope, the team's scoring settings
 * cannot be read, no judge tool is on PATH, or none here runs a scorer's model at the isolation it needs.
 */
export async function judgeUnavailable(config: LocalConfig, scorers: Record<string, PinnedScorer>): Promise<string | undefined> {
  const unavailable = scoringUnavailable(config);

  if (unavailable) return unavailable;
  const scoring = await scopeScoring(config);

  if (!scoring.ok) return scoring.reason;
  const offers = await confinedOffers();

  if (offers.length === 0) return 'No judge tool is on PATH: install Claude Code, Codex, OpenCode or CodeBuddy.';
  const aliases = await loadModelAliases(config);

  for (const [name, pin] of Object.entries(scorers)) {
    const definition = pinnedDefinition(name, pin);

    if (!definition) return `This teamai cannot read scorer ${name}. Update teamai.`;
    const required = requiredFor(scoring.isolation, name, pin, definition);
    const tools = offers.flatMap((offer) => (offer.level === required.level ? offer.tools : []));

    // Every judge tool here runs best-effort, so only a verified scorer finds none.
    if (tools.length === 0) return `Scorer "${name}" needs a verified judge, which ${required.setBy.join(' and ')} asks for, and no judge tool here runs verified.`;
    const chosen = chooseJudgeModel(aliases, definition, tools);

    if (!chosen.ok) return chosen.message;
  }

  return undefined;
}
