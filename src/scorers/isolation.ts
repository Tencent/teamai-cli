/**
 * How isolated a judge must be. The team (`scorers/scoring.yaml` `isolation`), a scorer (`isolation`) and this machine
 * (`config.yaml` `scoring.isolation`) may each ask; the strictest wins, and nobody asking means `best-effort`.
 */
import type { LocalConfig } from '../types.js';
import { ISOLATIONS, type Isolation } from './label.js';

export function scorerIsolationSource(scorer: string, relativePath = `scorers/${scorer}.md`): string {
  return `${relativePath} isolation`;
}

/** One place that may ask for an isolation, such as `scorers/scoring.yaml isolation`, and what it says there. */
export interface IsolationSetting {
  source: string;
  value: string | undefined;
}

export interface RequiredIsolation {
  level: Isolation;
  /** The sources that ask for `level`; none when it is the default. */
  setBy: string[];
  /** Settings whose value is not an isolation teamai knows. Each counts as `verified`. */
  unknown: Array<{ source: string; value: string }>;
}

/** What this scope's `config.yaml` asks of every judge. */
export function machineIsolation(config: LocalConfig): IsolationSetting {
  return { source: 'config.yaml scoring.isolation', value: config.scoring?.isolation };
}

function levelOf(value: string): Isolation {
  return ISOLATIONS.find((isolation) => isolation === value) ?? 'verified';
}

export function requiredIsolation(settings: readonly IsolationSetting[]): RequiredIsolation {
  const given = settings.flatMap(({ source, value }) => (value === undefined ? [] : [{ source, value, level: levelOf(value) }]));
  const level: Isolation = given.some((setting) => setting.level === 'verified') ? 'verified' : 'best-effort';
  return {
    level,
    setBy: given.filter((setting) => setting.level === level).map((setting) => setting.source),
    unknown: given.filter((setting) => !ISOLATIONS.some((isolation) => isolation === setting.value)).map(({ source, value }) => ({ source, value })),
  };
}

/** Why an unknown setting raised the level, for a warning or a doctor note. */
export function unknownIsolationText({ source, value }: { source: string; value: string }): string {
  return `${source} is "${value}", which is not verified or best-effort, so it counts as verified`;
}
