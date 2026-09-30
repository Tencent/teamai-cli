/**
 * The member's own environment (#879 Conflict 10).
 *
 * The profile loads whichever teamai `env.sh` a scope wrote, so the process
 * environment also carries values teamai exported: another team's, this
 * scope's from before a team edit, or this scope's repo value for a key the
 * team now declares as a secret. Those are the team's values, not the
 * member's, and a secret must not fall back to them.
 *
 * Each env.sh exports a marker of what it exported, which reaches a shell that
 * sourced one no scan finds (`<dir>/.teamai/env.sh` of a non-git project), and
 * keeps a record of what it has exported (env-sh-exports.ts), so a shell
 * opened before any scope's pull keeps being discounted after it.
 *
 * Not covered: a value a shell got from an env.sh no scan finds, written by a
 * CLI without the marker; a value exported before the last 20 changes of its
 * key; and one an env.sh written by a CLI without the record dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportDigest, markedAsExported, readEnvShExports, type EnvShExports } from './env-sh-exports.js';
import { parseEnvFile } from './resources/env.js';
import { envName, envValue } from './resources/env-key.js';
import { getDataHome, getTeamaiHomeDir, type LocalConfig } from './types.js';
import { readFileSafe } from './utils/fs.js';

/** A key's value in the member's own environment, or undefined. */
export type MemberEnvironment = (key: string) => string | undefined;

/** Every teamai env.sh on this machine that a shell may have loaded, with the one in each of `dataHomes`. */
async function teamaiEnvShPaths(dataHomes: readonly string[]): Promise<string[]> {
  const home = getTeamaiHomeDir();
  const projects = path.join(home, 'projects');
  let partitions: string[] = [];
  try {
    partitions = (await fs.promises.readdir(projects)).map((name) => path.join(projects, name, 'env.sh'));
  } catch {
    // No project partitions on this machine.
  }
  return [...new Set([path.join(home, 'env.sh'), ...dataHomes.map((dataHome) => path.join(dataHome, 'env.sh')), ...partitions])];
}

/**
 * For key K, `env[K]` is the member's unless it is empty, a marker in `env`
 * says a teamai env.sh exported it for K, it equals what a teamai env.sh
 * exports for K or has exported for K since it recorded its exports
 * (env-sh-exports.ts), or K is a declared secret and it equals this scope's
 * env.yaml value for K.
 */
export async function memberEnvironment(
  localConfig: LocalConfig,
  scope: { secretKeys: ReadonlySet<string>; envYaml: ReadonlyMap<string, string> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<MemberEnvironment> {
  return memberEnvironmentAt([getDataHome(localConfig)], scope, env);
}

/**
 * The member's own environment where the config that governs the directory
 * cannot be read: no scope declares anything, and `dataHomes` are the
 * directories of the configs that could not be read, whose env.sh a shell may
 * have loaded.
 */
export function memberEnvironmentWithoutScope(dataHomes: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<MemberEnvironment> {
  return memberEnvironmentAt(dataHomes, { secretKeys: new Set(), envYaml: new Map() }, env);
}

async function memberEnvironmentAt(
  dataHomes: readonly string[],
  scope: { secretKeys: ReadonlySet<string>; envYaml: ReadonlyMap<string, string> },
  env: NodeJS.ProcessEnv,
): Promise<MemberEnvironment> {
  const exported: ReadonlyMap<string, string>[] = [];
  const recorded: EnvShExports[] = [];
  for (const envSh of await teamaiEnvShPaths(dataHomes)) {
    const content = await readFileSafe(envSh);
    if (content !== null) exported.push(parseEnvFile(content));
    recorded.push(await readEnvShExports(envSh));
  }
  const marked = markedAsExported(env);
  return (key) => {
    const value = envValue(env, key);
    if (value === undefined || value === '') return undefined;
    if (marked(key, value)) return undefined;
    // On Windows another scope's `token` is this key's `TOKEN`: compare names as the platform does.
    const name = envName(key);
    const sameName = ([other]: readonly [string, unknown]): boolean => envName(other) === name;
    if (exported.some((exports) => [...exports].some((entry) => sameName(entry) && entry[1] === value))) return undefined;
    const digest = exportDigest(key, value);
    if (recorded.some((exports) => [...exports].some((entry) => sameName(entry) && entry[1].has(digest)))) return undefined;
    if (scope.secretKeys.has(key) && [...scope.envYaml].some((entry) => sameName(entry) && entry[1] === value)) return undefined;
    return value;
  };
}
