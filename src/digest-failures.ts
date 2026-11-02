/**
 * `teamai digest --json` (#1249): what an improvement starts from. The failing score labels of the last 30 days, each
 * with the subject it judges and the commit its work started at, and each scorer's cohorts with, for a model judge,
 * how it agrees with hand labels. It reads labels as the dashboard's Scorers page does, so a benchmark's labels are
 * left out, and it never reads a judge's reasoning, a prompt or a transcript.
 */
import { detectProjectConfig, requireInit } from './config.js';
import { readScorerLabels, rubricLabelsOf } from './dashboard/scorers.js';
import { ScorerResults, type ScorerFailures } from './scorers/results.js';
import type { LocalConfig } from './types.js';

/** The window failures are read over, in days of `scoredAt`: the dashboard's default. */
const WINDOW_DAYS = 30;

async function failures(config: LocalConfig, now = new Date()): Promise<ScorerFailures> {
  const labels = await readScorerLabels(config);
  const rubricLabels = await rubricLabelsOf(config, labels.map(({ label }) => label));
  return ScorerResults.failures({ labels, windowDays: WINDOW_DAYS, now, rubricLabels });
}

/** Prints the digest's JSON envelope on stdout, and only that. */
async function print(): Promise<void> {
  const config = await detectProjectConfig(undefined, undefined, { dryRun: true }) ?? (await requireInit({ dryRun: true })).localConfig;
  console.log(JSON.stringify({ data: await failures(config) }));
}

export const DigestFailures = { print } as const;
