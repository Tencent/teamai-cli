import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataHome, isSelfMode, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';

export function scoresDir(config: LocalConfig): string {
  return path.join(getDataHome(config), 'scores');
}

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

/** Runs `change` under `<scores>/<name>.lock`, or answers busy when another process holds it for about a second. */
export async function scoresLocked<T>(config: LocalConfig, name: 'labels' | 'marks', change: () => Promise<T>): Promise<{ status: 'done'; value: T } | { status: 'busy' }> {
  const lock = path.join(scoresDir(config), `${name}.lock`);
  await fs.mkdir(scoresDir(config), { recursive: true });
  let held = false;

  for (let tries = 0; tries < LOCK_ATTEMPTS && !held; tries += 1) {
    held = await acquireLock(lock);

    if (!held) await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
  }

  if (!held) return { status: 'busy' };

  try {
    return { status: 'done', value: await change() };
  } finally {
    await releaseLock(lock);
  }
}

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
