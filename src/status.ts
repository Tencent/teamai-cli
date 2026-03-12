import path from 'node:path';
import YAML from 'yaml';
import { requireInit, loadState } from './config.js';
import { getRepoStatus } from './utils/git.js';
import { log } from './utils/logger.js';
import { getAllHandlers } from './resources/index.js';
import { listDirs, listFiles, pathExists, readFileSafe } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import type { GlobalOptions, ResourceType } from './types.js';

export async function status(options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await requireInit();

  // Git status
  console.log('');
  log.info('Team repo status:');
  try {
    const gitStatus = await getRepoStatus(localConfig.repo.localPath);
    console.log(`  repo: ${localConfig.repo.remote}`);
    console.log(`  local: ${localConfig.repo.localPath}`);
    if (gitStatus.ahead > 0) console.log(`  ahead: ${gitStatus.ahead} commit(s)`);
    if (gitStatus.behind > 0) console.log(`  behind: ${gitStatus.behind} commit(s)`);
    if (gitStatus.modified.length > 0) {
      console.log(`  modified: ${gitStatus.modified.length} file(s)`);
    }
    if (gitStatus.ahead === 0 && gitStatus.behind === 0 && gitStatus.modified.length === 0) {
      console.log('  up to date');
    }
  } catch (e) {
    log.warn(`Could not check git status: ${(e as Error).message}`);
  }

  // State
  const state = await loadState();
  console.log('');
  log.info('Sync state:');
  console.log(`  last push: ${state.lastPush ?? 'never'}`);
  console.log(`  last pull: ${state.lastPull ?? 'never'}`);

  // Resource counts
  console.log('');
  log.info('Team resources:');

  const repoPath = localConfig.repo.localPath;
  const counts: Record<string, number> = {};

  // Skills
  const skillsDirs = await listDirs(path.join(repoPath, 'skills'));
  counts.skills = skillsDirs.length;

  // Rules
  const rulesFiles = (await listFiles(path.join(repoPath, 'rules'))).filter(f => f.endsWith('.md'));
  counts.rules = rulesFiles.length;

  // Docs
  const docsExists = await pathExists(path.join(repoPath, 'docs'));
  const docFiles = docsExists ? (await listFiles(path.join(repoPath, 'docs'))).filter(f => !f.startsWith('.')) : [];
  counts.docs = docFiles.length;

  // Env
  const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
  let envCount = 0;
  if (await pathExists(envYamlPath)) {
    const envContent = await readFileSafe(envYamlPath);
    if (envContent) {
      try {
        const envData = YAML.parse(envContent) as { variables?: unknown[] };
        envCount = Array.isArray(envData?.variables) ? envData.variables.length : 0;
      } catch {
        // invalid yaml
      }
    }
  }
  counts.env = envCount;

  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type}: ${count}`);
  }

  // Local pushable items
  console.log('');
  log.info('Local resources not yet pushed:');
  let anyNew = false;
  for (const handler of getAllHandlers()) {
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    if (items.length > 0) {
      anyNew = true;
      console.log(`  [${handler.type}] ${items.length} new`);
      if (options.verbose) {
        for (const item of items) {
          console.log(`    - ${item.name}`);
        }
      }
    }
  }
  if (!anyNew) {
    console.log('  (none)');
  }

  console.log('');
}

export async function list(type: string | undefined, options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await requireInit();
  const repoPath = localConfig.repo.localPath;

  const types: ResourceType[] = type
    ? [type as ResourceType]
    : ['skills', 'rules', 'docs', 'env'];

  for (const t of types) {
    console.log('');
    console.log(`=== ${t.toUpperCase()} ===`);

    if (t === 'env') {
      // Special handling: show individual variables from env.yaml
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      if (await pathExists(envYamlPath)) {
        const envContent = await readFileSafe(envYamlPath);
        if (envContent) {
          try {
            const envData = YAML.parse(envContent) as { variables?: Array<{ key: string; value: string; description?: string }> };
            if (envData?.variables && envData.variables.length > 0) {
              for (const v of envData.variables) {
                console.log(`  ${v.key}=${v.value}`);
                if (options.verbose && v.description) {
                  console.log(`    ${v.description}`);
                }
              }
            } else {
              console.log('  (none)');
            }
          } catch {
            console.log('  (invalid env.yaml)');
          }
        } else {
          console.log('  (none)');
        }
      } else {
        console.log('  (none)');
      }
      continue;
    }

    const handler = getAllHandlers().find((h) => h.type === t);
    if (!handler) continue;

    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    if (items.length === 0) {
      console.log('  (none)');
    } else {
      for (const item of items) {
        let suffix = '';
        if (t === 'skills') {
          const contributors = await SkillsHandler.readContributors(item.sourcePath);
          if (contributors.length > 0) {
            suffix = `  (${contributors.join(', ')})`;
          }
        }
        console.log(`  ${item.name}${suffix}`);
        if (options.verbose) {
          console.log(`    path: ${item.sourcePath}`);
        }
      }
    }
  }
  console.log('');
}
