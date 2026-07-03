import path from 'node:path';
import { autoDetectInit, saveLocalConfigForScope } from './config.js';
import { log } from './utils/logger.js';
import { readFileSafe, writeFile, remove, pathExists } from './utils/fs.js';
import { ResourceHandler } from './resources/base.js';
import {
  resolveBaseDir,
  isRecallEnabled,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
} from './types.js';

async function removeRecallArtifacts(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const baseDir = resolveBaseDir(localConfig);

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    // Remove recall rule file
    if (toolPath.rules) {
      const ruleFile = path.join(baseDir, toolPath.rules, 'teamai-recall.md');
      if (await pathExists(ruleFile)) {
        await remove(ruleFile);
        log.debug(`Removed recall rule from ${tool}`);
      }
    }

    // Remove recall agent file
    if (toolPath.agents) {
      const agentFile = path.join(baseDir, toolPath.agents, 'teamai-recall.md');
      if (await pathExists(agentFile)) {
        await remove(agentFile);
        log.debug(`Removed recall agent from ${tool}`);
      }
    }

    // Remove recall block from CLAUDE.md
    if (toolPath.claudemd) {
      const claudeMdPath = path.join(baseDir, toolPath.claudemd);
      const content = await readFileSafe(claudeMdPath);
      if (content && content.includes(TEAMAI_RECALL_RULES_START)) {
        const startIdx = content.indexOf(TEAMAI_RECALL_RULES_START);
        const endIdx = content.indexOf(TEAMAI_RECALL_RULES_END);
        if (startIdx !== -1 && endIdx !== -1) {
          const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
          const after = content.substring(endIdx + TEAMAI_RECALL_RULES_END.length).replace(/^\n+/, '\n');
          const cleaned = (before + after).trim();
          if (cleaned.length === 0) {
            await remove(claudeMdPath);
          } else {
            await writeFile(claudeMdPath, cleaned + '\n');
          }
          log.debug(`Removed recall rules block from ${tool} CLAUDE.md`);
        }
      }
    }
  }
}

async function deployRecallArtifacts(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const { deployBuiltinRules } = await import('./builtin-rules.js');
  const { deployBuiltinAgents } = await import('./builtin-agents.js');

  await deployBuiltinRules(teamConfig, localConfig, { skipRecall: false });
  await deployBuiltinAgents(teamConfig, localConfig, { skipRecall: false });

  // Inject recall rules block into CLAUDE.md for Tier-1 tools
  const { injectClaudeMdSection } = await import('./utils/claudemd.js');
  const { compileRecallRulesBlock } = await import('./pull.js');
  const baseDir = resolveBaseDir(localConfig);
  const recallBlock = compileRecallRulesBlock();

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.claudemd || !toolPath.agents) continue;
    if (!await ResourceHandler.isToolInstalled(toolPath.agents, baseDir)) continue;

    const claudeMdPath = path.join(baseDir, toolPath.claudemd);
    try {
      await injectClaudeMdSection(
        claudeMdPath,
        TEAMAI_RECALL_RULES_START,
        TEAMAI_RECALL_RULES_END,
        recallBlock,
      );
    } catch {
      // best-effort
    }
  }
}

export async function recallDisable(_opts: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

  const updated = { ...localConfig, recallEnabled: false };
  await saveLocalConfigForScope(updated, localConfig.scope, localConfig.projectRoot);

  await removeRecallArtifacts(teamConfig, localConfig);
  log.success('Recall disabled. AI tools will no longer auto-search the knowledge base.');
}

export async function recallEnable(_opts: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

  const updated = { ...localConfig, recallEnabled: true };
  await saveLocalConfigForScope(updated, localConfig.scope, localConfig.projectRoot);

  await deployRecallArtifacts(teamConfig, localConfig);
  log.success('Recall enabled. AI tools will auto-search the knowledge base before tasks.');
}

export async function recallStatus(_opts: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit();

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
