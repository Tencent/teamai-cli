/**
 * The member's own environment (#879 Conflict 10).
 *
 * The profile loads whichever teamai `env.sh` a scope wrote, so the process
 * environment also carries values teamai exported: another team's, this
 * scope's from before a team edit, or this scope's repo value for a key the
 * team now declares as a secret. Those are the team's values, not the
 * member's, and a secret must not fall back to them.
 *
 * Each env.sh keeps a record of what it has exported (env-sh-exports.ts), so a
 * shell opened before any scope's pull keeps being discounted after it.
 *
 * Not covered: a project in a non-git directory other than this scope
 * (`<dir>/.teamai/env.sh`), a value exported before the last 20 changes of its
 * key, and one an env.sh written by a CLI without the record dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportDigest, readEnvShExports, type EnvShExports } from './env-sh-exports.js';
import { parseEnvFile } from './resources/env.js';
import { getDataHome, getTeamaiHomeDir, type LocalConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';

/** A key's value in the member's own environment, or undefined. */
export type MemberEnvironment = (key: string) => string | undefined;

/** Every teamai env.sh on this machine that a shell may have loaded. */
async function teamaiEnvShPaths(localConfig: LocalConfig): Promise<string[]> {
  const home = getTeamaiHomeDir();
  const projects = path.join(home, 'projects');
  let partitions: string[] = [];
  try {
    partitions = (await fs.promises.readdir(projects)).map((name) => path.join(projects, name, 'env.sh'));
  } catch {
    // No project partitions on this machine.
  }
  return [...new Set([path.join(home, 'env.sh'), path.join(getDataHome(localConfig), 'env.sh'), ...partitions])];
}

/**
 * For key K, `env[K]` is the member's unless it is empty, equals what a teamai
 * env.sh exports for K or has exported for K since it recorded its exports
 * (env-sh-exports.ts), or K is a declared secret and it equals this scope's
 * env.yaml value for K.
 */
export async function memberEnvironment(
  localConfig: LocalConfig,
  scope: { secretKeys: ReadonlySet<string>; envYaml: ReadonlyMap<string, string> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberEnvironment> {
  const exported: ReadonlyMap<string, string>[] = [];
  const recorded: EnvShExports[] = [];
  for (const envSh of await teamaiEnvShPaths(localConfig)) {
    const content = await readFileSafe(envSh);
    if (content !== null) exported.push(parseEnvFile(content));
    recorded.push(await readEnvShExports(envSh));
  }
  return (key) => {
    const value = env[key];
    if (value === undefined || value === '') return undefined;
    if (exported.some((exports) => exports.get(key) === value)) return undefined;
    const digest = exportDigest(key, value);
    if (recorded.some((exports) => exports.get(key)?.has(digest))) return undefined;
    if (scope.secretKeys.has(key) && scope.envYaml.get(key) === value) return undefined;
    return value;
  };
}
