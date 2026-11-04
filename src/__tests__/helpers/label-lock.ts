import path from 'node:path';
import { scoresDir } from '../../scorers/home.js';
import type { LocalConfig } from '../../types.js';
import { acquireLock, releaseLock } from '../../update.js';

/** Runs `action` while `scores/labels.lock` of `config` is held, as another teamai process writing a label holds it. */
export async function whileLabelsLocked<T>(config: LocalConfig, action: () => Promise<T>): Promise<T> {
  const lock = path.join(scoresDir(config), 'labels.lock');

  if (!await acquireLock(lock)) throw new Error(`${lock} is already held`);

  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}
