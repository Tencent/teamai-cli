import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadLocalConfigForScope, readConfigFrom } from '../config.js';
import { LocalConfigSchema, getDataHome, type LocalConfig } from '../types.js';
import { readFileSafe } from '../utils/fs.js';
import { projectsRootDir } from '../utils/partition.js';
import { isRunId, readRun } from './store.js';
import type { RunState, WorkflowEnvelope } from './types.js';

/** Run ids address local state across scopes. A duplicate id never picks a project by cwd. */
export async function findRunConfig(runId: string, current?: LocalConfig): Promise<{ config: LocalConfig; run: RunState } | WorkflowEnvelope> {
  if (!isRunId(runId)) return { error: { code: 'invalid_run', message: 'Run id must look like r followed by 8 or 16 hex digits' } };
  const candidates: LocalConfig[] = current ? [current] : [];
  const user = await loadLocalConfigForScope('user', undefined, { dryRun: true });
  if (user) candidates.push(user);
  let dirs: import('node:fs').Dirent[] = [];
  try { dirs = await fs.readdir(projectsRootDir(), { withFileTypes: true }); } catch { /* No project partitions yet. */ }
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(projectsRootDir(), entry.name);
    const raw = await readFileSafe(path.join(dir, 'config.yaml'));
    if (!raw) continue;
    try {
      const parsed = LocalConfigSchema.parse(YAML.parse(raw));
      if (parsed.scope !== 'project') continue;
      const stored = await readRun({ ...parsed, dataHome: dir }, runId);
      if (stored === 'missing') continue;
      const checkout = typeof stored === 'object' ? stored.checkout : undefined;
      const config = await readConfigFrom(dir, checkout ?? parsed.projectRoot ?? parsed.repo.businessRepoRoot ?? dir, undefined, undefined, { dryRun: true, selfHeal: false });
      if (config) candidates.push(config);
    } catch { /* An unusable config cannot authorize a run mutation. */ }
  }
  const seen = new Set<string>();
  const matches: Array<{ config: LocalConfig; run: RunState | 'corrupt' }> = [];
  for (const config of candidates) {
    const home = await fs.realpath(getDataHome(config)).catch(() => path.resolve(getDataHome(config)));
    if (seen.has(home)) continue;
    seen.add(home);
    const run = await readRun(config, runId);
    if (run !== 'missing') {
      const anchored = typeof run === 'object' && run.checkout && config.scope === 'project'
        ? await readConfigFrom(home, run.checkout, undefined, undefined, { dryRun: true, selfHeal: false }) : null;
      matches.push({ config: anchored ?? config, run });
    }
  }
  const [match, ...others] = matches;
  if (others.length > 0) return { error: { code: 'ambiguous_run', message: `Run ${runId} exists in more than one local scope; resolve the duplicate before continuing` } };
  if (!match) return { error: { code: 'run_not_found', message: `Run ${runId} was not found in the configured local scopes` } };
  return match.run === 'corrupt' ? { error: { code: 'run_unreadable', message: `Run ${runId} could not be read` } } : { config: match.config, run: match.run };
}
