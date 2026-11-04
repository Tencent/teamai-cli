/**
 * `workflows.retention` (#1689): how long `teamai doctor --fix` leaves what a settled run left behind, a duration or
 * `never`. Each level keeps the value as written, so a wrong one never makes its file unreadable: it is skipped with a
 * warning, and the next level decides. The order is that of every member setting: this scope's config, then
 * ~/.teamai/config.yaml, then the team's teamai.yaml, then the default.
 */
import path from 'node:path';
import { z } from 'zod';
import { loadMemberSettings, ownMemberSettings } from '../config.js';
import { getDataHome, getTeamaiHomeDir, type LocalConfig, type TeamaiConfig } from '../types.js';
import type { RunState } from './types.js';
import { warnOnce } from '../utils/warn-once.js';
import { durationMs } from './parse.js';

export const DEFAULT_RETENTION = '14d';

/** How long leftovers stay: `never`, or a duration in milliseconds, with the text it was written as. */
export type Retention = { kind: 'never'; text: 'never' } | { kind: 'after'; ms: number; text: string };

// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse itself: each level keeps the value as written
export function parseRetention(value: unknown): Retention | undefined {
  const text = z.string().trim().safeParse(value);

  if (!text.success) return undefined;

  if (text.data === 'never') return { kind: 'never', text: 'never' };
  const ms = durationMs(text.data);

  return ms === undefined ? undefined : { kind: 'after', ms, text: text.data };
}

/** The retention in effect, and the file that set it, absent for the default. */
export type ResolvedRetention = Retention & { file?: string };

/** When what a run that settled at `settledAt` left goes past `retention`, in epoch milliseconds; undefined under `never`. */
export function retentionEnds(settledAt: string, retention: Retention): number | undefined {
  return retention.kind === 'after' ? Date.parse(settledAt) + retention.ms : undefined;
}

/**
 * When what settled run `run` left goes past its retention, in epoch milliseconds: the `retainedUntil` it settled with,
 * else, on a run that settled before teamai recorded it, its settle time plus `retention`. Undefined: kept for good.
 */
export function runRetainedUntil(run: Pick<RunState, 'retainedUntil' | 'updatedAt'>, retention: Retention): number | undefined {
  return run.retainedUntil !== undefined ? Date.parse(run.retainedUntil) : retentionEnds(run.updatedAt, retention);
}

/**
 * When `doctor --fix` on the machine that owns settled run `run` removes what it left: once no retry reopens it, and once
 * `retention`, which may have grown since, or become `never`, passed too. Undefined: never.
 */
export function ownRunSweptAt(run: Pick<RunState, 'retainedUntil' | 'updatedAt'>, retention: Retention): number | undefined {
  const reopenable = runRetainedUntil(run, retention);
  const retained = retentionEnds(run.updatedAt, retention);

  return reopenable === undefined || retained === undefined ? undefined : Math.max(reopenable, retained);
}

/** The retention for `config`'s scope, warning once of each level whose value is neither a duration nor `never`. */
export async function resolveRetention(config: LocalConfig, team: Pick<TeamaiConfig, 'workflows'> | null): Promise<ResolvedRetention> {
  const machineFile = path.join(getTeamaiHomeDir(), 'config.yaml');
  const scopeFile = config.scope === 'user' ? machineFile : path.join(getDataHome(config), 'config.yaml');

  const levels = [
    { file: scopeFile, value: ownMemberSettings(config).workflows?.retention },
    ...config.scope === 'user' ? [] : [{ file: machineFile, value: (await loadMemberSettings(machineFile)).workflows?.retention }],
    { file: path.join(config.repo.localPath, 'teamai.yaml'), value: team?.workflows?.retention },
  ];

  for (const { file, value } of levels) {
    if (value === undefined) continue;
    const retention = parseRetention(value);

    if (retention) return { ...retention, file };
    warnOnce(`Ignoring workflows.retention in ${file}: ${JSON.stringify(value)} is not a duration such as 14d, or never.`);
  }

  const fallback = parseRetention(DEFAULT_RETENTION);

  if (!fallback) throw new Error(`DEFAULT_RETENTION ${DEFAULT_RETENTION} is not a retention.`);

  return fallback;
}
