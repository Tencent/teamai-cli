/**
 * Team-defined post-pull scripts (`scripts.postPull` in teamai.yaml).
 *
 * The team repo owns its deployment, but the CLI only knows the surfaces it
 * implements (skills, rules, hooks, MCP, env, docs). `scripts.postPull` is the
 * way to add a step of the team's own: a Node entrypoint (the CLI runs it with
 * its own node, no shell) for extra model or policy files, a silent first-time
 * installer, a deploy of the team's tooling. The CLI's share of the job is
 * deliberately narrow — resolve and validate the path, run it at the very
 * end of the pull, and record the outcome so a quiet machine is still
 * diagnosable.
 *
 * The script runs as a child of the pull process itself — no supervisor, no
 * second escape: on the session-start path that process already left the
 * host's job object (see hook-dispatch-cli.ts), so the script survives the
 * host by construction and inherits the child's hidden console. How the pull
 * launches it depends on who triggered the pull — see the two launch shapes
 * below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

import { loadTeamConfig } from './config.js';
import { withTimeout } from './utils/async.js';
import { log } from './utils/logger.js';
import { captureTail, detachChild } from './utils/exec.js';
import { assertSafePath } from './utils/path-safety.js';
import { redactWithEnv } from './utils/redact.js';
import type { TeamaiConfig } from './types.js';

/** Output kept from a failed script, for its log line. */
const TAIL_CHARS = 400;

/**
 * Measured worst case of a cold pull (fetch + submodules + reconcile): the
 * part of the pull handler's budget the deploy wait cannot have. Named so the
 * sizing relation has one spelling - the guard test reads it.
 */
export const COLD_PULL_WORST_CASE_MS = 25_000;

/**
 * How long the pull waits for the script before giving up on it. Must fit
 * under the pull handler's own budget (PULL_TIMEOUT_MS) minus a cold pull,
 * so the script's outcome line lands before the handler deadline can exit
 * the process - the test pins the relation.
 */
export const POST_PULL_BUDGET_SEC = 90;

/**
 * Resolve the declared script for one team clone, or null when the team
 * declares none. Lexical only — containment is checked by the caller once the
 * file is known to exist, so a missing script costs one stat, not a
 * resolution walk.
 */
function resolvePostPullScript(teamConfig: TeamaiConfig, repoPath: string): string | null {
  const declared = teamConfig.scripts?.postPull;
  if (!declared?.path) return null;
  return path.resolve(repoPath, declared.path);
}

/**
 * Run the team's post-pull script for one pulled scope, if it declares one.
 * Never throws: a team script rides on the pull, so a bad path, a missing file
 * or a failed spawn is one log line — not a failed sync.
 *
 * `interactive` picks the launch shape: the hook path (a headless pull) passes
 * nothing and waits the script out under the budget; a human-triggered pull
 * passes true and gets the fire-and-forget shape.
 */
export async function runDeclaredPostPull(
  repoPath: string,
  { interactive = false }: { interactive?: boolean } = {},
): Promise<void> {
  try {
    const teamConfig = await loadTeamConfig(repoPath);
    if (!teamConfig) return;
    const scriptPath = resolvePostPullScript(teamConfig, repoPath);
    if (!scriptPath) return;
    // A declared-but-missing script is a rollout state (not yet committed,
    // submodule not populated), not an error — one stat and done.
    if (!fs.existsSync(scriptPath)) {
      log.debug(`postPull: declared script not found: ${scriptPath}`);
      return;
    }
    // Containment: this script runs on every member's machine, so the repo
    // must not be able to point it outside its own clone, symlinks included.
    // Checked after existence so the common missing case skips the walk.
    assertSafePath(scriptPath, [repoPath]);
    if (interactive) {
      runPostPullInteractive(scriptPath, repoPath);
    } else {
      await runPostPull(scriptPath, repoPath);
    }
  } catch (e) {
    log.debug(`postPull: skipped: ${(e as Error).message}`);
  }
}

/**
 * Interactive `teamai pull`: launch the script fire-and-forget into the user's
 * terminal and return at once — the deploy's output streams where the user can
 * see it, and there is nothing here that must outlive the prompt. Safe because
 * this pull was spawned by the user's shell, not by a kill-on-exit hook host:
 * no job object to escape, and no deadline to fit. The script still self-limits
 * its heavy step against the exported budget.
 */
function runPostPullInteractive(scriptPath: string, repoPath: string): void {
  const child = spawnScript(scriptPath, repoPath, ['ignore', 'inherit', 'inherit'], POST_PULL_BUDGET_SEC);
  detachChild(child);
  log.debug(`postPull: launched path=${scriptPath} budget=${POST_PULL_BUDGET_SEC}s (unawaited, terminal attached)`);
}

/**
 * Launch the team's script under our node, handing it the repo and its budget.
 * The canonical spawn-failure log line lives here: every child we hand out
 * already has an 'error' listener, so an async spawn failure (EAGAIN, an
 * unusable cwd) is a log line for every consumer — an unlistened 'error'
 * event would crash the pull.
 */
function spawnScript(
  scriptPath: string,
  repoPath: string,
  stdio: StdioOptions,
  budgetSec: number,
): ChildProcess {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoPath,
    stdio,
    env: {
      ...process.env,
      TEAMAI_REPO: repoPath,
      TEAMAI_POSTPULL_TIMEOUT_SEC: String(budgetSec),
    },
  });
  child.on('error', (e) => {
    log.debug(`postPull: could not run ${scriptPath}: ${e.message}`);
  });
  return child;
}

/**
 * Headless launch shape: run the script and wait for it under the budget.
 * Never throws — the log line is the whole point.
 *
 * The budget only bounds how long the pull waits. On expiry the waiter gives
 * up, not the worker: killing a deploy mid-flight strands the machine it was
 * updating, while leaving it running costs nothing — the next pull
 * reconciles. The script is told the same budget via the
 * TEAMAI_POSTPULL_TIMEOUT_SEC env var, so its inner npm/git step can cut
 * itself off with a clean error line instead of being cut down.
 *
 * Exported for the tests' short-budget injection; production callers go
 * through {@link runDeclaredPostPull}.
 */
export async function runPostPull(
  scriptPath: string,
  repoPath: string,
  budgetSec: number = POST_PULL_BUDGET_SEC,
): Promise<void> {
  log.debug(`postPull: launched path=${scriptPath} budget=${budgetSec}s`);
  const startedAt = Date.now();
  const child = spawnScript(scriptPath, repoPath, ['ignore', 'pipe', 'pipe'], budgetSec);
  const readTail = captureTail(child, TAIL_CHARS);

  const exited = new Promise<number | null>((resolve) => {
    // spawnScript already logged the canonical line for an async spawn
    // failure; here it just ends the wait.
    child.on('error', () => resolve(null));
    // 'close', not 'exit': the last output chunks can arrive after the process
    // is gone, and this tail is the whole failure report.
    child.on('close', (code) => resolve(code));
  });

  let code: number | null;
  try {
    code = await withTimeout(exited, budgetSec * 1000, 'postPull budget');
  } catch {
    // Detach so "stop waiting" is this module's own doing, not a side effect of
    // whoever exits next: the ref'd child and its pipe sockets would otherwise
    // hold this process's event loop until the script finishes, hanging the
    // pull for the script's whole remaining runtime.
    detachChild(child);
    log.debug(`postPull: timed out after ${budgetSec}s — orphaned ${scriptPath} (still running)`);
    return;
  }

  const ms = Date.now() - startedAt;
  if (code === null) return;
  if (code === 0) {
    log.debug(`postPull: exited 0 in ${ms}ms (${scriptPath})`);
    return;
  }
  const tail = redactWithEnv(readTail());
  log.debug(`postPull: exited ${code} in ${ms}ms (${scriptPath})${tail ? ` — ${tail}` : ''}`);
}
