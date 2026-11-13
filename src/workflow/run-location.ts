import fs from 'node:fs/promises';
import path from 'node:path';
import { parseYaml } from '@teamai/shared/yaml';
import { loadLocalConfigForScope, readConfigFrom } from '../config.js';
import { ATTEMPT_ENV } from '../launch-context.js';
import { LocalConfigSchema, getDataHome, type LocalConfig } from '../types.js';
import { memberHome } from '@teamai/shared/home';
import { projectsRootDir } from '../utils/partition.js';
import type { LeasedStep } from './step-state.js';
import { markedAttempt } from './attempt-marker.js';
import { isRunId, readRun } from './store.js';
import type { RunState, WorkflowFailure } from './types.js';
import { readRegularFile } from '@teamai/shared/regular-file';

/**
 * Each project partition of this machine, with the config stored in it: enough to read the partition's local state.
 * Under the member's home, as is every run: a command a step starts in its clone uses the clone's install for the rest.
 */
export async function projectPartitions(): Promise<LocalConfig[]> {
  const root = projectsRootDir(memberHome());
  let dirs: import('node:fs').Dirent[] = [];

  try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { /* No project partitions yet. */ }

  const partitions: LocalConfig[] = [];

  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    const raw = await readRegularFile(path.join(dir, 'config.yaml'), 'utf8').catch(() => null);

    if (!raw) continue;

    try {
      const parsed = LocalConfigSchema.parse(parseYaml(raw));

      if (parsed.scope === 'project') partitions.push({ ...parsed, dataHome: dir });
    } catch { /* An unusable config cannot authorize a run mutation. */ }
  }

  return partitions;
}

/** The whole config of `partition`, as teamai reads it in `anchor`, else in the partition's project root. Null when it is unusable. */
export async function partitionConfig(partition: LocalConfig, anchor?: string): Promise<LocalConfig | null> {
  const dir = getDataHome(partition);

  return readConfigFrom(dir, anchor ?? partition.projectRoot ?? partition.repo.businessRepoRoot ?? dir, undefined, undefined, { dryRun: true, selfHeal: false }).catch(() => null);
}

/**
 * The checkout `run` started in, when it is still a directory: the config is read as there. A run whose checkout was
 * removed since, such as a worktree, is read with its partition's own project root instead, so it can still be found,
 * cancelled and retried.
 */
export async function existingCheckout(run: RunState | 'corrupt'): Promise<string | undefined> {
  const checkout = run === 'corrupt' ? undefined : run.checkout;

  return checkout !== undefined && (await fs.stat(checkout).catch(() => undefined))?.isDirectory() === true ? checkout : undefined;
}

/** Run ids address local state across scopes. A duplicate id never picks a project by cwd. */
export async function findRunConfig(runId: string, current?: LocalConfig): Promise<{ config: LocalConfig; run: RunState } | { error: WorkflowFailure }> {
  if (!isRunId(runId)) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };
  const candidates: LocalConfig[] = current ? [current] : [];
  const user = await loadLocalConfigForScope('user', undefined, { dryRun: true, home: memberHome() });

  if (user) candidates.push(user);

  for (const partition of await projectPartitions()) {
    const stored = await readRun(partition, runId);

    if (stored === 'missing') continue;
    const config = await partitionConfig(partition, await existingCheckout(stored));

    if (config) candidates.push(config);
  }

  const seen = new Set<string>();
  const matches: Array<{ config: LocalConfig; run: RunState | 'corrupt' }> = [];

  for (const config of candidates) {
    const home = await fs.realpath(getDataHome(config)).catch(() => path.resolve(getDataHome(config)));

    if (seen.has(home)) continue;
    seen.add(home);
    const run = await readRun(config, runId);

    if (run !== 'missing') {
      const checkout = await existingCheckout(run);

      const anchored = checkout !== undefined && config.scope === 'project'
        ? await readConfigFrom(home, checkout, undefined, undefined, { dryRun: true, selfHeal: false }) : null;

      matches.push({ config: anchored ?? config, run });
    }
  }

  const [match, ...others] = matches;

  if (others.length > 0) return { error: { code: 'ambiguous_run', message: `Run ${runId} exists in more than one local scope; resolve the duplicate before continuing` } };

  if (!match) return { error: { code: 'run_not_found', message: `Run ${runId} was not found in the configured local scopes` } };

  return match.run === 'corrupt' ? { error: { code: 'run_unreadable', message: `Run ${runId} could not be read` } } : { config: match.config, run: match.run };
}

/**
 * The run and the leased step of the attempt `env` marks (the attempt marker, `<run>/<attempt>`), wherever on
 * this machine the run is: what a step's own command reads of the run it is part of, from the place the step runs in.
 */
export async function findAttemptRun(env: NodeJS.ProcessEnv): Promise<{ config: LocalConfig; run: RunState; step: LeasedStep } | { error: WorkflowFailure }> {
  const marked = markedAttempt(env);

  if (!marked) {
    return { error: { code: 'invalid_arguments', message: `${ATTEMPT_ENV} is not set to <run>/<attempt>, so this command runs as no step of a run. It runs only as a step of a workflow run, which sets it.` } };
  }

  const { run: runId, attempt } = marked;
  const found = await findRunConfig(runId);

  if ('error' in found) return found;
  const step = found.run.steps.find((state): state is LeasedStep => state.status === 'leased' && state.attempt === attempt);

  if (!step) return { error: { code: 'wrong_attempt', message: `Attempt ${attempt} is not a leased attempt of run ${runId}, so its step is over and this command has nothing to run for.` } };

  return { config: found.config, run: found.run, step };
}
