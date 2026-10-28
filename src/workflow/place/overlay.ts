import fs from 'node:fs/promises';
import { pathExists } from '../../utils/fs.js';
import type { WorkflowFailure } from '../types.js';
import { applyBaseConfig, hooksPath, recordConfigOverlay, restoreUneditedConfig } from '../worktree.js';

/**
 * Puts the base agent configuration at `configCommit` over the copy `dir` of `root`, with the branch's own files kept
 * in `saved`, then delivers the team's assets into it. The delivery is recorded as part of the overlay, so it is not
 * the step's edit. With `resume`, it finishes an overlay a killed process left, over the files it kept in `saved`.
 */
export async function applyOverlay({ root, dir, configCommit, saved, resume }: { root: string; dir: string; configCommit: string; saved: string; resume?: true }): Promise<WorkflowFailure | undefined> {
  const applied = await applyBaseConfig(dir, configCommit, hooksPath(root), saved, resume ? { resume } : {});
  if (!applied.ok) return { code: 'base_config', message: applied.message };
  await deliverTeamAssets(dir);
  await recordConfigOverlay(dir, saved);
  return undefined;
}

/**
 * Puts back each branch agent file the step left unchanged. Why they are not back, when git could not list the copy's
 * files. An overlay already restored, whose `saved` is gone, has nothing left to put back. An overlay a killed process
 * left `unfinished` had no step run over it, so every agent file in the copy is the overlay's, and all are put back.
 */
export async function restoreOverlay({ dir, configCommit, saved, unfinished }: { dir: string; configCommit: string; saved: string; unfinished?: true }): Promise<string | undefined> {
  // A copy aside cut short left the branch's files in the copy.
  if (unfinished) await fs.rm(`${saved}.partial`, { recursive: true, force: true });
  if (!await pathExists(saved)) return undefined;
  if (unfinished) await recordConfigOverlay(dir, saved);
  return restoreUneditedConfig(dir, configCommit, saved);
}

/** What a step's failure adds when git could not list its copy `dir` to put the branch's agent files back. */
export function unrestoredConfig(reason: string, dir: string): string {
  return `The branch's agent files were not put back: ${reason}. Fix what git reported and copy those files into ${dir}, then retry the step.`;
}

/**
 * Gives a workflow worktree the skills, rules, agents and MCP a new worktree of this checkout gets. It runs after the
 * base agent files are in place and before their overlay is recorded, so the delivered files are not the step's edits.
 */
async function deliverTeamAssets(dir: string): Promise<void> {
  const exitCode = process.exitCode;
  try {
    const { createProjectToolRoots } = await import('../../project-agent-root.js');
    await createProjectToolRoots({ cwd: dir });
    const { pull } = await import('../../pull.js');
    await pull({ silent: true, inline: true, gitHook: 'post-checkout', prepareCheckout: 'always', cwd: dir });
  } finally {
    process.exitCode = exitCode;
  }
}
