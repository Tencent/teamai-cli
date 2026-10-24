import path from 'node:path';
import { getDataHome, isSelfMode, type LocalConfig } from '../types.js';

/**
 * Why this install cannot score, or undefined when it can. A project install that still keeps its data in
 * `<project>/.teamai` would write judge evidence, which holds the repository's files, inside the repository it judges.
 */
export function scoringUnavailable(config: LocalConfig): string | undefined {
  if (config.scope !== 'project' || isSelfMode(config) || !config.projectRoot) return undefined;
  const legacy = path.join(config.projectRoot, '.teamai');
  if (path.resolve(getDataHome(config)) !== path.resolve(legacy)) return undefined;
  return `Scoring is off for this project: its teamai data is still in ${legacy}, inside the repository, where judge evidence would land. Run teamai pull to move it to ~/.teamai/projects/, then score again.`;
}
