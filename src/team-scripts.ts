/**
 * Team scripts other than the post-pull launch shapes (`scripts.preInit`,
 * `postInit`, `prePull`, `postDeploy`, and an explicit `script run` of
 * `postPull`).
 *
 * The team repo owns what the script does. TeamAI resolves the path, refuses
 * one that leaves the repo, and passes the checkout identity it already
 * computed. It does not create personal files, and it does not reimplement
 * worktree or submodule rules for the script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

import { loadTeamConfig } from './config.js';
import { POST_PULL_BUDGET_SEC } from './post-pull.js';
import type { LocalConfig, TeamaiConfig } from './types.js';
import { withTimeout } from './utils/async.js';
import { captureTail, detachChild } from './utils/exec.js';
import { resolveAnchors } from './utils/git.js';
import { log } from './utils/logger.js';
import { assertSafePath } from './utils/path-safety.js';
import { closePrompt } from './utils/prompt.js';
import { redactWithEnv } from './utils/redact.js';

/** Output kept from a failed budgeted script, for its log line. */
const TAIL_CHARS = 400;

/**
 * How long checkout preparation waits for `scripts.postDeploy`. This runs
 * inside `git worktree add` (and a submodule's first checkout), so a stuck
 * script must not hold git for the full post-pull budget. The script is told
 * the same number and left running if the wait ends first.
 */
export const POST_DEPLOY_BUDGET_SEC = 15;

export const TEAM_SCRIPT_EVENTS = ['preInit', 'postInit', 'prePull', 'postPull', 'postDeploy'] as const;
export type TeamScriptEvent = (typeof TEAM_SCRIPT_EVENTS)[number];

const PROMPTED: ReadonlySet<TeamScriptEvent> = new Set(['preInit', 'postInit']);

export function isTeamScriptEvent(value: string): value is TeamScriptEvent {
  return (TEAM_SCRIPT_EVENTS as readonly string[]).includes(value);
}

/** preInit and postInit read the terminal. The others must not. */
export function teamScriptPrompts(event: TeamScriptEvent): boolean {
  return PROMPTED.has(event);
}

export interface TeamScriptResult {
  /** `absent`: not declared, or the file is not there yet. `skipped`: not run. `ran`: the process was started. */
  status: 'absent' | 'skipped' | 'ran';
  /** Exit code when the process closed. Null on a skip, a timeout, or a spawn error. */
  code: number | null;
}

export interface TeamScriptOptions {
  /**
   * For `preInit` and `postInit`: inherit the terminal and wait with no
   * timeout. Anything else is ignored. A false value skips those two.
   */
  interactive?: boolean;
  /** Say why a prompted script was skipped or failed. Init uses this. `script run` speaks for itself. */
  announce?: boolean;
  /** Test injection. Production uses the event's own budget. */
  budgetSec?: number;
  /**
   * Show the script on the terminal while still applying the budget.
   * `teamai script run` sets this. Pull and checkout preparation do not:
   * they have no member watching.
   */
  inherit?: boolean;
}

/**
 * Environment every team script sees. `TEAMAI_PROJECT` is the resolver's
 * `projectAnchor`: the same value for every worktree of one repo.
 * `TEAMAI_MAIN_CHECKOUT` is `mainCheckout` when TeamAI resolved one. Scripts
 * use these instead of walking worktrees themselves. A bare anchor is an
 * identity only, not a checkout to write into.
 */
export async function teamScriptEnv(localConfig: LocalConfig): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A git hook sets this for the pull. A team script must not look like one.
  delete env.TEAMAI_GIT_HOOK;
  env.TEAMAI_REPO = localConfig.repo.localPath;
  env.TEAMAI_SCOPE = localConfig.scope;
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const anchors = await resolveAnchors(localConfig.projectRoot);
    env.TEAMAI_CHECKOUT = anchors?.workspaceRoot ?? localConfig.projectRoot;
    if (anchors?.projectAnchor) {
      env.TEAMAI_PROJECT = anchors.projectAnchor;
      if (anchors.mainCheckout) env.TEAMAI_MAIN_CHECKOUT = anchors.mainCheckout;
    }
  }
  return env;
}

/**
 * Run one declared script. Never throws: init and pull keep going, and the
 * log line is the record.
 */
export async function runTeamScript(
  localConfig: LocalConfig,
  event: TeamScriptEvent,
  options: TeamScriptOptions = {},
): Promise<TeamScriptResult> {
  try {
    const scriptPath = await resolveScript(localConfig.repo.localPath, event);
    if (scriptPath === 'absent') return { status: 'absent', code: null };
    if (scriptPath === 'unsafe') {
      if (options.announce) log.warn(`scripts.${event} was not run because its path leaves the team repo.`);
      return { status: 'skipped', code: null };
    }
    if (PROMPTED.has(event) && !options.interactive) {
      if (options.announce) {
        log.info(
          `Skipped scripts.${event} because this run is not interactive. `
          + `Run it in a terminal with: teamai script run ${event}`,
        );
      }
      return { status: 'skipped', code: null };
    }

    const env = await teamScriptEnv(localConfig);
    if (PROMPTED.has(event)) {
      // Init's readline would consume the keystrokes the script is waiting for.
      closePrompt();
      const code = await runInherited(scriptPath, localConfig.repo.localPath, env, event);
      if (options.announce) announceExit(event, code);
      return { status: 'ran', code };
    }

    const budget = options.budgetSec ?? (event === 'postDeploy' ? POST_DEPLOY_BUDGET_SEC : POST_PULL_BUDGET_SEC);
    env.TEAMAI_SCRIPT_TIMEOUT_SEC = String(budget);
    if (event === 'postPull') env.TEAMAI_POSTPULL_TIMEOUT_SEC = String(budget);
    const code = await runBudgeted(
      scriptPath,
      localConfig.repo.localPath,
      env,
      event,
      budget,
      options.inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    );
    return { status: 'ran', code };
  } catch (e) {
    log.debug(`scripts.${event}: skipped: ${(e as Error).message}`);
    return { status: 'skipped', code: null };
  }
}

/**
 * One MCP reconcile after `postInit`, so a token the script just collected is
 * in the tool config without a second command. Init calls this because it
 * does not pull team resources before it exits.
 */
export async function syncMcpAfterPostInit(localConfig: LocalConfig): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return;
  try {
    const { reconcileMcpForConfig } = await import('./mcp-reconcile.js');
    const { wrote, unresolved, unparsed } = await reconcileMcpForConfig(teamConfig, localConfig);
    if (wrote) log.success('MCP servers updated. Restart your AI tool session to load them.');
    if (unresolved || (unparsed && !wrote)) {
      log.info('Run `teamai pull` to finish updating MCP servers.');
    }
  } catch (e) {
    log.warn(`MCP sync after scripts.postInit failed: ${(e as Error).message}`);
  }
}

function announceExit(event: TeamScriptEvent, code: number | null): void {
  if (code === 0) return;
  const again = `Run it again with: teamai script run ${event}`;
  if (code === null) {
    log.warn(`scripts.${event} did not run. Setup will continue. ${again}`);
    return;
  }
  log.warn(`scripts.${event} exited ${code}. Setup will continue. ${again}`);
}

async function resolveScript(
  repoPath: string,
  event: TeamScriptEvent,
): Promise<string | 'absent' | 'unsafe'> {
  const teamConfig = await loadTeamConfig(repoPath);
  const declared = teamConfig ? scriptPathOf(teamConfig, event) : undefined;
  if (!declared) return 'absent';
  const scriptPath = path.resolve(repoPath, declared);
  // A declared-but-missing file is a rollout state, not an error.
  if (!fs.existsSync(scriptPath)) {
    log.debug(`scripts.${event}: declared script not found: ${scriptPath}`);
    return 'absent';
  }
  try {
    assertSafePath(scriptPath, [repoPath]);
  } catch (e) {
    log.debug(`scripts.${event}: skipped: ${(e as Error).message}`);
    return 'unsafe';
  }
  return scriptPath;
}

function scriptPathOf(teamConfig: TeamaiConfig, event: TeamScriptEvent): string | undefined {
  return teamConfig.scripts?.[event]?.path;
}

function spawnScript(
  scriptPath: string,
  repoPath: string,
  stdio: StdioOptions,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(process.execPath, [scriptPath], { cwd: repoPath, stdio, env });
  child.on('error', (e) => {
    log.debug(`scripts: could not run ${scriptPath}: ${e.message}`);
  });
  return child;
}

function waitForClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });
}

/** Prompted scripts: the member is at the terminal, and the script may read it. No budget. */
async function runInherited(
  scriptPath: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  event: TeamScriptEvent,
): Promise<number | null> {
  log.debug(`scripts.${event}: waiting on ${scriptPath}`);
  const child = spawnScript(scriptPath, repoPath, ['inherit', 'inherit', 'inherit'], env);
  const code = await waitForClose(child);
  log.debug(`scripts.${event}: exited ${code ?? 'error'} (${scriptPath})`);
  return code;
}

/**
 * Headless scripts. The budget bounds the wait only: on expiry the script is
 * left running, same as a post-pull script that overruns.
 */
async function runBudgeted(
  scriptPath: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  event: TeamScriptEvent,
  budgetSec: number,
  stdio: StdioOptions,
): Promise<number | null> {
  log.debug(`scripts.${event}: launched path=${scriptPath} budget=${budgetSec}s`);
  const child = spawnScript(scriptPath, repoPath, stdio, env);
  const readTail = captureTail(child, TAIL_CHARS);
  let code: number | null;
  try {
    code = await withTimeout(waitForClose(child), budgetSec * 1000, `${event} budget`);
  } catch {
    detachChild(child);
    log.debug(`scripts.${event}: timed out after ${budgetSec}s — orphaned ${scriptPath} (still running)`);
    return null;
  }
  if (code === null || code === 0) {
    if (code === 0) log.debug(`scripts.${event}: exited 0 (${scriptPath})`);
    return code;
  }
  const tail = redactWithEnv(readTail());
  log.debug(`scripts.${event}: exited ${code} (${scriptPath})${tail ? ` — ${tail}` : ''}`);
  return code;
}
