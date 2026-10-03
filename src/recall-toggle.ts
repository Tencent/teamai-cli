import path from 'node:path';
import { autoDetectInit, saveLocalConfigForScope } from './config.js';
import { log } from './utils/logger.js';
import { remove, pathExists } from './utils/fs.js';
import { applyInstructionPlan, planInstructionFiles, registerOpencodeContext, resolveInstructionTargets } from './instruction-targets.js';
import {
  ALL_SUPPORTED_TOOLS,
  agentFileExtensionForTool,
  type ToolName,
} from './resources/agent-format.js';
import { ruleFileExtensionForTool } from './resources/rule-format.js';
import { LEGACY_RECALL_SKILL_NAMES, builtinSkillsTarget, pruneLegacyBuiltinSkills } from './builtin-skills.js';
import {
  resolveToolBaseDir,
  isRecallEnabled,
  isAgentExcluded,
  scopedToolPaths,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
} from './types.js';

async function removeRecallArtifacts(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    const baseDir = resolveToolBaseDir(tool, localConfig);
    // Remove recall rule file
    if (toolPath.rules) {
      // Cursor and JoyCode copies are `.mdc`; older layouts also left `.md` files.
      const extensions = new Set<string>([ruleFileExtensionForTool(tool), '.md']);
      for (const extension of extensions) {
        const ruleFile = path.join(baseDir, toolPath.rules, `teamai-recall${extension}`);
        if (await pathExists(ruleFile)) {
          await remove(ruleFile);
          log.debug(`Removed recall rule from ${tool}`);
        }
      }
    }

    // Remove the legacy recall skill an earlier release deployed. The served
    // `share` workflow is gated at run time, but a member who upgrades and
    // disables recall before pulling still has the old directory.
    // Same resolver and gates as deployment: an uninstalled Codex must not have
    // the shared .agents/skills root pruned on its behalf, and OpenClaw and
    // Hermes are pruned where their skills actually live.
    if (toolPath.skills && !isAgentExcluded(localConfig, tool)) {
      const target = await builtinSkillsTarget(tool, toolPath.skills, localConfig);
      if (target) await pruneLegacyBuiltinSkills(tool, target, LEGACY_RECALL_SKILL_NAMES);
    }

    // Remove recall agent file
    if (toolPath.agents) {
      const agentsDir = path.join(baseDir, toolPath.agents);
      const extensions = new Set<string>(['.md']);
      if ((ALL_SUPPORTED_TOOLS as string[]).includes(tool)) {
        extensions.add(agentFileExtensionForTool(tool as ToolName));
      }
      for (const extension of extensions) {
        const agentFile = path.join(agentsDir, `teamai-recall${extension}`);
        if (await pathExists(agentFile)) {
          await remove(agentFile);
          log.debug(`Removed recall agent from ${tool}`);
        }
      }
    }
  }

  // Remove the recall block from every file teamai may have written it to.
  await writeRecallBlock(teamConfig, localConfig, null);
}

/** Set or remove (`null`) the recall blocks wherever teamai delivers instruction blocks. */
async function writeRecallBlock(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  blocks: { recall: string; directRecall: string } | null,
): Promise<void> {
  const resolved = await resolveInstructionTargets(teamConfig, localConfig);
  const { targets, stale } = resolved;
  // Removal also reaches files no installed tool reads any more, but leaves
  // their other blocks to the next pull's cleanup.
  const files = blocks === null ? [...targets, ...stale] : targets;
  const plan = await planInstructionFiles(files, blocks ?? { recall: null, directRecall: null });
  for (const warning of plan.warnings) log.warn(warning);
  const { report, failures, files: results } = await applyInstructionPlan(plan, { dryRun: false });
  for (const line of report) log.debug(line);
  for (const failure of failures) log.warn(failure);
  await registerOpencodeContext(teamConfig, localConfig, resolved, false, results);
}

async function deployRecallArtifacts(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const { deployBuiltinRules } = await import('./builtin-rules.js');
  const { deployBuiltinAgents } = await import('./builtin-agents.js');
  const { deployBuiltinSkills } = await import('./builtin-skills.js');

  await deployBuiltinRules(teamConfig, localConfig, { skipRecall: false });
  await deployBuiltinAgents(teamConfig, localConfig, { skipRecall: false });
  await deployBuiltinSkills(teamConfig, localConfig);

  const { compileDirectRecallRulesBlock, compileRecallRulesBlock } = await import('./pull.js');
  await writeRecallBlock(teamConfig, localConfig, { recall: compileRecallRulesBlock(), directRecall: compileDirectRecallRulesBlock() });
}

export async function recallDisable(opts: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });

  if (opts.dryRun) {
    log.info('[dry-run] Would set recallEnabled=false and remove managed Recall artifacts.');
    return;
  }

  const updated = { ...localConfig, recallEnabled: false };
  await saveLocalConfigForScope(updated, localConfig.scope, localConfig.projectRoot);

  await removeRecallArtifacts(teamConfig, localConfig);
  log.success('Recall disabled. AI tools will no longer auto-search the knowledge base.');
}

export async function recallEnable(opts: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: opts.dryRun });

  if (opts.dryRun) {
    log.info('[dry-run] Would set recallEnabled=true and deploy managed Recall artifacts.');
    return;
  }

  const updated = { ...localConfig, recallEnabled: true };
  await saveLocalConfigForScope(updated, localConfig.scope, localConfig.projectRoot);

  await deployRecallArtifacts(teamConfig, localConfig);
  log.success('Recall enabled. AI tools will auto-search the knowledge base before tasks.');
}

export async function recallStatus(_opts: GlobalOptions): Promise<void> {
  // Read-only: the load never persists a migration (#893).
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: true });

  const effective = isRecallEnabled(localConfig, teamConfig);
  const teamSetting = teamConfig.sharing?.recall?.enabled ?? false;
  const userOverride = localConfig.recallEnabled;

  console.log(`Recall: ${effective ? 'enabled' : 'disabled'}`);
  console.log(`  Team config (sharing.recall.enabled): ${teamSetting}`);
  if (userOverride !== undefined) {
    console.log(`  User override (recallEnabled): ${userOverride}`);
  } else {
    console.log(`  User override: not set (using team default)`);
  }
}
