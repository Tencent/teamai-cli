/** Writes a `workflow-<name>` skill for each workflow an agent may start, into every tool's skills root. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinSkillsTarget } from '../../builtin-skills.js';
import type { DeliveryRecorder } from '../../git-exclude-delivered.js';
import { SHARED_AGENT_SKILLS_PATH } from '../../locate.js';
import { keepsTrackedCopy } from '../../resources/delivered-copies.js';
import {
  allowsSkillDirectory, CODEX_TOOL, describeSkippedSkillDirectory, findSkillDirectoryBlock, skillTargetsFor,
} from '../../resources/skills.js';
import { isAgentExcluded, scopedToolPaths, type LocalConfig, type TeamaiConfig } from '../../types.js';
import { pathExists, readFileSafe, writeFileAtomic } from '../../utils/fs.js';
import { warnOnce } from '../../utils/warn-once.js';
import { listCachedWorkflows, loadCachedWorkflow } from '../cache.js';
import { generatedSkillAt, readGenerated } from './generated-marker.js';
import { renderWorkflowSkill, type AdvertisedWorkflow } from './render.js';

/**
 * Every cached `invoke: allow` or `ask` workflow, each with its alias only when the alias starts it. The cache is what
 * `start` resolves from, so no skill names a workflow that cannot start.
 */
async function advertisedWorkflows(config: LocalConfig): Promise<AdvertisedWorkflow[]> {
  const advertised: AdvertisedWorkflow[] = [];
  for (const { definition } of await listCachedWorkflows(config)) {
    const { name, description, alias, invoke } = definition;
    if (invoke !== 'allow' && invoke !== 'ask') continue;
    const starts = alias !== undefined && (await loadCachedWorkflow(config, alias))?.definition.name === name;
    advertised.push({ name, description, invoke, ...(starts ? { alias } : {}) });
  }
  return advertised;
}

/** Where one generated skill goes, and what it holds there. */
interface Placement {
  tool: string;
  workflow: string;
  dir: string;
  guardBase: string;
  content: string;
}

/** A skills root pull looks through for generated skills it no longer places. */
interface Root {
  dir: string;
  guardBase: string;
}

const PREFIX = 'workflow-';
const WRITER = 'workflow-skills';

/**
 * The generated skill of each advertised workflow for each tool that takes skills, and every root those tools read
 * skills from: Codex reads `.agents/skills` beside its own. A directory two tools share (Codex and another tool in
 * `.agents/skills`) gets the first tool's render.
 */
async function plan(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<{ placements: Placement[]; roots: Root[] }> {
  const workflows = await advertisedWorkflows(localConfig);
  const skillTarget = skillTargetsFor(teamConfig, localConfig);
  const placed = new Map<string, Placement>();
  const roots = new Map<string, Root>();
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    if (!toolPath.skills || isAgentExcluded(localConfig, tool)) continue;
    const target = await builtinSkillsTarget(tool, teamConfig, localConfig);
    if (!target) continue;
    const { guardBase } = target;
    // Codex takes the shared `.agents/skills` copy only when it is free or already generated.
    const ownsShared = async (dir: string): Promise<boolean> => await allowsSkillDirectory(guardBase, dir)
      && (!await pathExists(dir) || (await generatedSkillAt(dir)).kind === 'ours');
    for (const dir of [target.skillsDir, ...tool === CODEX_TOOL ? [path.join(guardBase, SHARED_AGENT_SKILLS_PATH)] : []]) {
      if (!roots.has(dir)) roots.set(dir, { dir, guardBase });
    }
    for (const workflow of workflows) {
      const skillName = `${PREFIX}${workflow.name}`;
      const dir = await skillTarget({ tool, skillName, ownsShared }) ?? path.join(target.skillsDir, skillName);
      if (placed.has(dir)) continue;
      placed.set(dir, { tool, workflow: workflow.name, dir, guardBase, content: renderWorkflowSkill(workflow, tool) });
    }
  }
  return { placements: [...placed.values()], roots: [...roots.values()] };
}

function shadowed({ tool, workflow, dir }: Pick<Placement, 'tool' | 'workflow' | 'dir'>): string {
  return `${dir} is a skill teamai did not generate, so agents read it in place of the generated skill of workflow ${workflow} (${tool}). To receive the generated skill, rename or remove that skill, in the team repository when the team ships it.`;
}

function keptEdited(file: string, workflow: string, advertised: boolean): string {
  return advertised
    ? `Kept ${file}: it was generated from workflows/${workflow}.yaml and edited since, so teamai pull no longer updates it. Delete it to receive the current one, or remove its teamai-generated metadata to keep it as your own.`
    : `Kept ${file}: it was generated from workflows/${workflow}.yaml and edited since, and that workflow no longer offers a skill, so teamai pull left it. Delete it, or remove its teamai-generated metadata to keep it as your own.`;
}

/**
 * Writes `placement`, unless a link, a skill of the member's or the team's, or an edit is in the way. True when the
 * file is the generated skill now: written, or already as pull renders it.
 */
async function place({ tool, workflow, dir, guardBase, content }: Placement): Promise<boolean> {
  const block = await findSkillDirectoryBlock(guardBase, dir);
  if (block) {
    warnOnce(describeSkippedSkillDirectory(`${PREFIX}${workflow}`, tool, block));
    return false;
  }
  const file = path.join(dir, 'SKILL.md');
  const existing = await readFileSafe(file);
  const generated = existing === null ? null : readGenerated(existing);
  if (generated?.kind === 'theirs' || (generated === null && await pathExists(dir))) {
    warnOnce(shadowed({ tool, workflow, dir }));
    return false;
  }
  if (generated?.edited) {
    warnOnce(keptEdited(file, generated.name, true));
    return false;
  }
  if (existing !== content) {
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(file, content);
  }
  return true;
}

/** Removes the generated skill at `dir` when it is unedited, reachable without a link, and untracked. */
async function prune({ dir, guardBase }: Root): Promise<void> {
  if (await findSkillDirectoryBlock(guardBase, dir)) return;
  const generated = await generatedSkillAt(dir);
  if (generated.kind === 'theirs') return;
  const file = path.join(dir, 'SKILL.md');
  if (generated.edited) {
    warnOnce(keptEdited(file, generated.name, false));
    return;
  }
  if (await keepsTrackedCopy(file)) return;
  await fs.rm(file);
  // A file the member put beside it keeps the directory.
  await fs.rmdir(dir).catch(() => undefined);
}

/**
 * Writes the generated workflow skills into every tool's skills root, and removes each unedited one pull no longer
 * places. A skill without the marker, an edited one, a link, a tracked file or a directory outside the repository
 * boundary is never touched. `recorder` gets every file that is the generated skill after this run, so the git
 * exclude lists exactly those.
 */
export async function deployWorkflowSkills({ teamConfig, localConfig, recorder }: {
  teamConfig: TeamaiConfig;
  localConfig: LocalConfig;
  recorder?: DeliveryRecorder;
}): Promise<void> {
  try {
    const { placements, roots } = await plan(teamConfig, localConfig);
    const placed = new Set(placements.map(({ dir }) => dir));
    for (const placement of placements) {
      if (await place(placement)) recorder?.report(WRITER, path.join(placement.dir, 'SKILL.md'));
    }
    for (const root of roots) {
      const entries = await fs.readdir(root.dir).catch(() => []);
      for (const entry of entries) {
        const dir = path.join(root.dir, entry);
        if (entry.startsWith(PREFIX) && !placed.has(dir)) await prune({ ...root, dir });
      }
    }
  } catch (error) {
    recorder?.failed(WRITER);
    throw error;
  }
  recorder?.judgedAll(WRITER);
}

/** For `teamai doctor`: each generated skill a skill of the team's or the member's stands in for. Writes nothing. */
export async function shadowedWorkflowSkills({ teamConfig, localConfig }: { teamConfig: TeamaiConfig; localConfig: LocalConfig }): Promise<string[]> {
  const lines: string[] = [];
  for (const placement of (await plan(teamConfig, localConfig)).placements) {
    if (await findSkillDirectoryBlock(placement.guardBase, placement.dir) || !await pathExists(placement.dir)) continue;
    if ((await generatedSkillAt(placement.dir)).kind === 'theirs') lines.push(shadowed(placement));
  }
  return lines;
}
