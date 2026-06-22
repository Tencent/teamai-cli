import path from 'node:path';
import { autoDetectInit } from './config.js';
import { removeHooks } from './hooks.js';
import {
  TEAMAI_RULES_START,
  TEAMAI_RULES_END,
  TEAMAI_CULTURE_START,
  TEAMAI_CULTURE_END,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TEAMAI_RECALL_RULES_START,
  TEAMAI_RECALL_RULES_END,
  TEAMAI_ENV_START,
  TEAMAI_ENV_END,
  getTeamaiHome,
  resolveBaseDir,
  type GlobalOptions,
  type TeamaiConfig,
  type LocalConfig,
} from './types.js';
import { EXCLUDED_RULE_NAMES } from './builtin-rules.js';
import {
  pathExists,
  readFileSafe,
  writeFile,
  remove,
  listDirs,
  listFilesRecursive,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { askConfirmation } from './utils/prompt.js';

// ─── Types ─────────────────────────────────────────────

interface UninstallOptions extends GlobalOptions {
  force?: boolean;
}

interface RemovalPlan {
  /** Tool settings files that contain teamai hooks. */
  hookFiles: Array<{ path: string; tool: string }>;
  /** CLAUDE.md files with teamai rules blocks. */
  claudeMdFiles: string[];
  /** Skill directories synced from team repo. */
  skillDirs: string[];
  /** Rule .md files synced from team repo. */
  ruleFiles: string[];
  /** Shell profile path containing env block (null if none). */
  shellProfile: string | null;
  /** Docs directory (null if doesn't exist). */
  docsDir: string | null;
  /** The .teamai home directory path. */
  teamaiHome: string;
  /** Whether teamaiHome exists on disk. */
  teamaiHomeExists: boolean;
}

// ─── Helpers ───────────────────────────────────────────

const CLAUDEMD_MARKER_PAIRS: Array<[string, string]> = [
  [TEAMAI_RULES_START, TEAMAI_RULES_END],
  [TEAMAI_CULTURE_START, TEAMAI_CULTURE_END],
  [TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END],
  [TEAMAI_RECALL_RULES_START, TEAMAI_RECALL_RULES_END],
];

function detectShellProfile(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) {
    return path.join(home, '.zshrc');
  }
  return path.join(home, '.bashrc');
}

/**
 * Collect team repo skill names, handling both flat and namespaced layouts.
 * A directory is a namespace if it does NOT contain SKILL.md.
 */
async function collectTeamSkillNames(repoPath: string): Promise<Set<string>> {
  const teamSkillsDir = path.join(repoPath, 'skills');
  if (!await pathExists(teamSkillsDir)) return new Set();

  const names = new Set<string>();
  const topDirs = await listDirs(teamSkillsDir);

  for (const dir of topDirs) {
    const dirPath = path.join(teamSkillsDir, dir);
    const hasSkillMd = await pathExists(path.join(dirPath, 'SKILL.md'));
    if (hasSkillMd) {
      // Flat skill
      names.add(dir);
    } else {
      // Namespace directory — add sub-skills
      const subDirs = await listDirs(dirPath);
      for (const sub of subDirs) {
        names.add(sub);
      }
    }
  }

  return names;
}

/**
 * Collect team repo rule names (relative paths without .md extension).
 */
async function collectTeamRuleNames(repoPath: string): Promise<Set<string>> {
  const teamRulesDir = path.join(repoPath, 'rules');
  if (!await pathExists(teamRulesDir)) return new Set();

  const files = await listFilesRecursive(teamRulesDir);
  return new Set(
    files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
}

// ─── Discovery ─────────────────────────────────────────

async function buildRemovalPlan(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig,
): Promise<RemovalPlan> {
  const baseDir = resolveBaseDir(localConfig);
  const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);

  const plan: RemovalPlan = {
    hookFiles: [],
    claudeMdFiles: [],
    skillDirs: [],
    ruleFiles: [],
    shellProfile: null,
    docsDir: null,
    teamaiHome,
    teamaiHomeExists: await pathExists(teamaiHome),
  };

  // Discover team repo resource names for targeted removal
  const repoPath = localConfig.repo.localPath;
  const teamSkillNames = await collectTeamSkillNames(repoPath);
  const teamRuleNames = await collectTeamRuleNames(repoPath);

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    // (a) Hooks — settings.json / hooks.json
    if (toolPath.settings) {
      const settingsPath = path.join(baseDir, toolPath.settings);
      if (await pathExists(settingsPath)) {
        plan.hookFiles.push({ path: settingsPath, tool });
      }
    }

    // (b) CLAUDE.md teamai section blocks
    if (toolPath.claudemd) {
      const claudeMdPath = path.join(baseDir, toolPath.claudemd);
      const content = await readFileSafe(claudeMdPath);
      if (content && CLAUDEMD_MARKER_PAIRS.some(([start]) => content.includes(start))) {
        plan.claudeMdFiles.push(claudeMdPath);
      }
    }

    // (c) Skills — only those matching team repo
    if (toolPath.skills) {
      const skillsDir = path.join(baseDir, toolPath.skills);
      if (await pathExists(skillsDir)) {
        const dirs = await listDirs(skillsDir);
        for (const dir of dirs) {
          if (teamSkillNames.has(dir)) {
            plan.skillDirs.push(path.join(skillsDir, dir));
          }
        }
      }
    }

    // (d) Rules — only those matching team repo, excluding built-in
    if (toolPath.rules) {
      const rulesDir = path.join(baseDir, toolPath.rules);
      if (await pathExists(rulesDir)) {
        const files = await listFilesRecursive(rulesDir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const ruleName = file.replace(/\.md$/, '');
          if (EXCLUDED_RULE_NAMES.has(ruleName)) continue;
          if (teamRuleNames.has(ruleName)) {
            plan.ruleFiles.push(path.join(rulesDir, file));
          }
        }
      }
    }
  }

  // (e) Shell profile env block
  const shellProfilePath = teamConfig.sharing.env.shellProfilePath
    ? expandHome(teamConfig.sharing.env.shellProfilePath)
    : detectShellProfile();
  if (shellProfilePath) {
    const profileContent = await readFileSafe(shellProfilePath);
    if (profileContent && profileContent.includes(TEAMAI_ENV_START)) {
      plan.shellProfile = shellProfilePath;
    }
  }

  // (f) Docs directory
  const docsLocalDir = teamConfig.sharing.docs.localDir;
  let docsDir: string;
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    docsDir = docsLocalDir.startsWith('~/')
      ? path.join(localConfig.projectRoot, docsLocalDir.substring(2))
      : expandHome(docsLocalDir);
  } else {
    docsDir = expandHome(docsLocalDir);
  }
  if (await pathExists(docsDir)) {
    plan.docsDir = docsDir;
  }

  return plan;
}

// ─── Summary ───────────────────────────────────────────

function isPlanEmpty(plan: RemovalPlan): boolean {
  return (
    plan.hookFiles.length === 0 &&
    plan.claudeMdFiles.length === 0 &&
    plan.skillDirs.length === 0 &&
    plan.ruleFiles.length === 0 &&
    plan.shellProfile === null &&
    plan.docsDir === null &&
    !plan.teamaiHomeExists
  );
}

function printSummary(plan: RemovalPlan): void {
  console.log('');
  console.log('⚠  以下 teamai 资源将被移除:');
  console.log('');

  if (plan.hookFiles.length > 0) {
    console.log(`   Hooks (${plan.hookFiles.length} 个文件):`);
    for (const { path: p } of plan.hookFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.claudeMdFiles.length > 0) {
    console.log(`   CLAUDE.md 规则块 (${plan.claudeMdFiles.length} 个文件):`);
    for (const p of plan.claudeMdFiles) {
      console.log(`     ${p}`);
    }
    console.log('');
  }

  if (plan.skillDirs.length > 0) {
    console.log(`   Skills (${plan.skillDirs.length} 个目录)`);
    console.log('');
  }

  if (plan.ruleFiles.length > 0) {
    console.log(`   Rules (${plan.ruleFiles.length} 个文件)`);
    console.log('');
  }

  if (plan.shellProfile) {
    console.log('   Shell profile 环境变量块:');
    console.log(`     ${plan.shellProfile}`);
    console.log('');
  }

  if (plan.docsDir) {
    console.log('   Docs 目录:');
    console.log(`     ${plan.docsDir}`);
    console.log('');
  }

  if (plan.teamaiHomeExists) {
    console.log('   TeamAI 主目录:');
    console.log(`     ${plan.teamaiHome}/`);
    console.log('');
  }
}

// ─── Execution ─────────────────────────────────────────

async function executeRemoval(plan: RemovalPlan): Promise<void> {
  // (a) Remove hooks from tool settings
  for (const { path: settingsPath, tool } of plan.hookFiles) {
    try {
      await removeHooks(settingsPath, tool);
    } catch (e) {
      log.warn(`移除 hooks 失败 ${settingsPath}: ${(e as Error).message}`);
    }
  }

  // (b) Clean CLAUDE.md teamai section blocks
  for (const claudeMdPath of plan.claudeMdFiles) {
    try {
      const raw = await readFileSafe(claudeMdPath);
      if (!raw) continue;

      let content: string = raw;
      for (const [startMarker, endMarker] of CLAUDEMD_MARKER_PAIRS) {
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        if (startIdx === -1 || endIdx === -1) continue;

        const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
        const after = content.substring(endIdx + endMarker.length).replace(/^\n+/, '\n');
        content = (before + after).trim();
      }

      if (content.length === 0) {
        await remove(claudeMdPath);
      } else {
        await writeFile(claudeMdPath, content + '\n');
      }
      log.success(`清理 CLAUDE.md: ${claudeMdPath}`);
    } catch (e) {
      log.warn(`清理 CLAUDE.md 失败 ${claudeMdPath}: ${(e as Error).message}`);
    }
  }

  // (c) Remove synced skills
  for (const skillDir of plan.skillDirs) {
    try {
      await remove(skillDir);
    } catch (e) {
      log.warn(`移除 skill 失败 ${skillDir}: ${(e as Error).message}`);
    }
  }
  if (plan.skillDirs.length > 0) {
    log.success(`移除了 ${plan.skillDirs.length} 个 skill 目录`);
  }

  // (d) Remove synced rules
  for (const ruleFile of plan.ruleFiles) {
    try {
      await remove(ruleFile);
    } catch (e) {
      log.warn(`移除 rule 失败 ${ruleFile}: ${(e as Error).message}`);
    }
  }
  if (plan.ruleFiles.length > 0) {
    log.success(`移除了 ${plan.ruleFiles.length} 个 rule 文件`);
  }

  // (e) Clean shell profile env block
  if (plan.shellProfile) {
    try {
      const content = await readFileSafe(plan.shellProfile);
      if (content) {
        const startIdx = content.indexOf(TEAMAI_ENV_START);
        const endIdx = content.indexOf(TEAMAI_ENV_END);
        if (startIdx !== -1 && endIdx !== -1) {
          const before = content.substring(0, startIdx).replace(/\n+$/, '\n');
          const after = content.substring(endIdx + TEAMAI_ENV_END.length).replace(/^\n+/, '\n');
          await writeFile(plan.shellProfile, before + after);
          log.success(`清理 shell profile: ${plan.shellProfile}`);
        }
      }
    } catch (e) {
      log.warn(`清理 shell profile 失败: ${(e as Error).message}`);
    }
  }

  // (f) Remove docs directory
  if (plan.docsDir) {
    try {
      await remove(plan.docsDir);
      log.success(`移除 docs: ${plan.docsDir}`);
    } catch (e) {
      log.warn(`移除 docs 失败: ${(e as Error).message}`);
    }
  }

  // (g) Remove ~/.teamai/ directory (last — earlier steps read from it)
  if (plan.teamaiHomeExists) {
    try {
      await remove(plan.teamaiHome);
      log.success(`移除 ${plan.teamaiHome}/`);
    } catch (e) {
      log.warn(`移除 ${plan.teamaiHome} 失败: ${(e as Error).message}`);
    }
  }
}

// ─── Public API ────────────────────────────────────────

export async function uninstall(opts: UninstallOptions): Promise<void> {
  let localConfig: LocalConfig | null = null;
  let teamConfig: TeamaiConfig | null = null;

  try {
    const result = await autoDetectInit();
    localConfig = result.localConfig;
    teamConfig = result.teamConfig;
  } catch {
    log.warn('teamai 配置未找到或无效');
  }

  if (localConfig && teamConfig) {
    // Full uninstall with discovery
    const plan = await buildRemovalPlan(localConfig, teamConfig);

    if (isPlanEmpty(plan)) {
      log.info('没有需要卸载的内容');
      return;
    }

    printSummary(plan);

    if (opts.dryRun) {
      log.info('Dry run — 未做任何更改');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('确认卸载? [y/N] ');
      if (!confirmed) {
        log.info('已取消');
        return;
      }
    }

    await executeRemoval(plan);
    log.success('teamai 卸载完成');
  } else {
    // Minimal uninstall — just try to remove ~/.teamai/
    const homeDir = process.env.HOME;
    if (!homeDir) {
      log.error('无法确定用户主目录（HOME 环境变量未设置）');
      return;
    }
    const home = path.join(homeDir, '.teamai');
    if (!await pathExists(home)) {
      log.info('没有需要卸载的内容');
      return;
    }

    console.log('');
    console.log('⚠  将移除 TeamAI 主目录:');
    console.log(`     ${home}/`);
    console.log('');

    if (opts.dryRun) {
      log.info('Dry run — 未做任何更改');
      return;
    }

    if (!opts.force) {
      const confirmed = await askConfirmation('确认卸载? [y/N] ');
      if (!confirmed) {
        log.info('已取消');
        return;
      }
    }

    try {
      await remove(home);
      log.success(`移除 ${home}/`);
      log.success('teamai 卸载完成');
    } catch (e) {
      log.warn(`移除 ${home} 失败: ${(e as Error).message}`);
    }
  }
}
