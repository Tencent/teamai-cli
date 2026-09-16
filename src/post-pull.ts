/**
 * Team-defined post-pull scripts (`scripts.postPull` in teamai.yaml).
 *
 * The team repo owns its deployment, but the CLI only knows the surfaces it
 * implements (skills, rules, hooks, MCP, env, docs). `scripts.postPull` is the
 * extension point for everything else: the team's own tooling, extra model or
 * policy files, a silent first-time installer. The CLI's share of the job is
 * deliberately narrow — resolve and validate the path, launch it detached and
 * unawaited (the pull, and the host hook that triggered it, must return
 * immediately), and record the outcome so a quiet machine is still diagnosable.
 *
 * The script is not awaited, so the deadline is enforced by the detached
 * supervisor (`teamai post-pull-run`, spawned by {@link launchDeclaredPostPull}),
 * which outlives the pull and can therefore still log `exited`/`timed out`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { loadTeamConfig } from './config.js';
import { log } from './utils/logger.js';
import { assertSafePath } from './utils/path-safety.js';
import type { LocalConfig, TeamaiConfig } from './types.js';

/** Budget for a team post-pull script when teamai.yaml does not set one. */
export const DEFAULT_POST_PULL_TIMEOUT_SEC = 300;

export interface PostPullSpec {
  /** Absolute path of the script, validated to resolve inside `repoPath`. */
  scriptPath: string;
  /** Team repo root — the script's cwd and TEAMAI_REPO. */
  repoPath: string;
  /** Wall-clock budget in seconds before the script is killed. */
  timeoutSec: number;
}

/**
 * Resolve `scripts.postPull` for one team clone, or null when the team declares
 * none. Throws when the declared path escapes the clone — this script runs on
 * every member's machine, so the repo must not be able to point it elsewhere
 * (assertSafePath resolves symlinks on both sides, so a symlink out of the
 * clone is rejected too).
 */
export function resolvePostPullSpec(
  teamConfig: TeamaiConfig,
  repoPath: string,
): PostPullSpec | null {
  const declared = teamConfig.scripts?.postPull;
  if (!declared?.path) return null;
  const scriptPath = path.resolve(repoPath, declared.path);
  assertSafePath(scriptPath, [repoPath]);
  return {
    scriptPath,
    repoPath,
    timeoutSec: declared.timeoutSec ?? DEFAULT_POST_PULL_TIMEOUT_SEC,
  };
}

/**
 * Run the team's post-pull script for one pulled scope, if it declares one.
 * Never throws: a team script rides on the pull, so a bad path, a missing file
 * or a failed spawn is one log line — not a failed sync.
 */
export async function launchDeclaredPostPull(localConfig: LocalConfig): Promise<void> {
  const repoPath = localConfig.repo.localPath;
  try {
    const teamConfig = await loadTeamConfig(repoPath);
    if (!teamConfig) return;
    const spec = resolvePostPullSpec(teamConfig, repoPath);
    if (!spec) return;
    if (!fs.existsSync(spec.scriptPath)) {
      log.warn(`postPull: declared script not found: ${spec.scriptPath}`);
      return;
    }
    launchPostPull(spec);
  } catch (e) {
    log.warn(`postPull: skipped: ${(e as Error).message}`);
  }
}

/** Spawn the detached supervisor that runs the script and reports its outcome. */
export function launchPostPull(spec: PostPullSpec): void {
  // A plain detached spawn is enough here: the supervisor only has to outlive
  // this process, and whichever host started the pull has already been escaped
  // (the session-start pull is the one that has to leave a job object).
  let launched = false;
  try {
    const child = spawn(
      process.execPath,
      [
        process.argv[1],
        'post-pull-run',
        '--repo', spec.repoPath,
        '--script', spec.scriptPath,
        '--timeout-sec', String(spec.timeoutSec),
      ],
      { cwd: spec.repoPath, detached: true, windowsHide: true, stdio: 'ignore' },
    );
    child.on('error', () => {});
    child.unref();
    launched = true;
  } catch {
    launched = false;
  }
  const detail = `path=${spec.scriptPath} timeout=${spec.timeoutSec}s`;
  if (launched) log.debug(`postPull: launched ${detail}`);
  else log.warn(`postPull: could not launch ${detail}`);
}

/**
 * Body of the detached `post-pull-run` child: run the script under a deadline,
 * report how it ended, and never throw — the log line is the whole point.
 */
export async function runPostPull(spec: PostPullSpec): Promise<void> {
  const timeoutMs = Math.max(1, spec.timeoutSec) * 1000;
  const startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [spec.scriptPath], {
      cwd: spec.repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEAMAI_REPO: spec.repoPath,
        TEAMAI_POSTPULL_TIMEOUT_SEC: String(spec.timeoutSec),
      },
    });
  } catch (e) {
    log.warn(`postPull: spawn failed: ${(e as Error).message}`);
    return;
  }

  const readTail = collectTail(child);
  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      killChildTree(child);
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  const ms = Date.now() - startedAt;
  if (outcome.timedOut) {
    log.warn(`postPull: timed out after ${spec.timeoutSec}s — killed ${spec.scriptPath}`);
    return;
  }
  const tail = readTail();
  const suffix = tail ? ` — ${tail}` : '';
  if (outcome.code === 0) log.debug(`postPull: exited 0 in ${ms}ms (${spec.scriptPath})`);
  else log.warn(`postPull: exited ${outcome.code} in ${ms}ms (${spec.scriptPath})${suffix}`);
}

/** Best-effort kill for a script that ignored its deadline. */
function killChildTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // node's kill() terminates only the direct child; /T reaches whatever the
    // script started (git, installers, shell wrappers).
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      // best effort — the timeout is logged either way
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // best effort
  }
}

/** Keep the last `limit` characters of the child's output, drained as it arrives. */
function collectTail(child: ChildProcess, limit = 400): () => string {
  let buffer = '';
  const append = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString('utf8')).slice(-limit);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => buffer.trim().replace(/\s+/g, ' ').slice(-limit);
}
