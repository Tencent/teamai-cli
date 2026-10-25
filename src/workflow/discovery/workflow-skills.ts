/** Writes a `workflow-<name>` skill for each workflow an agent may start. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinSkillsTarget } from '../../builtin-skills.js';
import { findSkillDirectoryBlock } from '../../resources/skills.js';
import { isAgentExcluded, type LocalConfig, type TeamaiConfig } from '../../types.js';
import { readFileSafe, writeFileAtomic } from '../../utils/fs.js';
import { listCachedWorkflows, loadCachedWorkflow } from '../cache.js';
import { readGenerated } from './generated-marker.js';
import { renderWorkflowSkill, type AdvertisedWorkflow } from './render.js';

const TOOL = 'claude';

/**
 * Every cached `invoke: allow` workflow, each with its alias only when the alias starts it. The cache is what `start`
 * resolves from, so no skill names a workflow that cannot start.
 */
async function advertisedWorkflows(config: LocalConfig): Promise<AdvertisedWorkflow[]> {
  const advertised: AdvertisedWorkflow[] = [];
  for (const { definition } of await listCachedWorkflows(config)) {
    const { name, description, alias, invoke } = definition;
    if (invoke !== 'allow') continue;
    const starts = alias !== undefined && (await loadCachedWorkflow(config, alias))?.definition.name === name;
    advertised.push({ name, description, ...(starts ? { alias } : {}) });
  }
  return advertised;
}

/**
 * Writes the generated workflow skills into the Claude skills root. A skill without the marker, an edited one, a
 * symlink or a directory outside the repository boundary is never touched.
 */
export async function deployWorkflowSkills({ teamConfig, localConfig }: { teamConfig: TeamaiConfig; localConfig: LocalConfig }): Promise<void> {
  if (isAgentExcluded(localConfig, TOOL)) return;
  const target = await builtinSkillsTarget(TOOL, teamConfig, localConfig);
  if (!target) return;
  for (const workflow of await advertisedWorkflows(localConfig)) {
    const dir = path.join(target.skillsDir, `workflow-${workflow.name}`);
    if (await findSkillDirectoryBlock(target.guardBase, dir)) continue;
    const file = path.join(dir, 'SKILL.md');
    const existing = await readFileSafe(file);
    const generated = existing === null ? undefined : readGenerated(existing);
    if (generated && (generated.kind === 'theirs' || generated.edited)) continue;
    const render = renderWorkflowSkill(workflow);
    if (existing === render) continue;
    await fs.mkdir(dir, { recursive: true });
    await writeFileAtomic(file, render);
  }
}
