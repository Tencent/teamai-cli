import path from 'node:path';
import { readFileSafe, writeFile, pathExists, listDirs } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

// ─── Marketplace refresh ────────────────────────────────
//
//  When the team repo contains .codebuddy-plugin/marketplace.json,
//  push/remove of skills should keep the plugins list in sync.
//
//  Strategy: read existing marketplace.json → rebuild plugins array
//  from actual skills/ directory → write back if changed.
//
//  Only skills with strict:false entries are auto-managed.
//  Skills not in the marketplace (or with strict:true) are left alone.

const MARKETPLACE_PATH = '.codebuddy-plugin/marketplace.json';
const SKILL_MD = 'SKILL.md';

interface MarketplacePlugin {
  name: string;
  source: string;
  description: string;
  version: string;
  category?: string;
  keywords?: string[];
  strict?: boolean;
  [key: string]: unknown;
}

interface MarketplaceJson {
  name: string;
  description: string;
  version: string;
  owner: { name: string; email: string };
  plugins: MarketplacePlugin[];
  [key: string]: unknown;
}

/**
 * Extract the description from a SKILL.md frontmatter.
 * Reads the YAML frontmatter between --- delimiters.
 */
async function extractSkillDescription(skillDir: string): Promise<string> {
  const skillMdPath = path.join(skillDir, SKILL_MD);
  const content = await readFileSafe(skillMdPath);
  if (!content) return '';

  const { data } = parseFrontmatter(content);
  const desc = data['description'];
  if (!desc) return '';

  return String(desc).replace(/\s+/g, ' ').trim();
}

/**
 * Refresh .codebuddy-plugin/marketplace.json to reflect the current
 * skills/ directory state. Only updates entries with strict:false.
 *
 * - New skills in skills/ → added with a default entry
 * - Removed skills → entry removed from plugins array
 * - Existing entries → description refreshed from SKILL.md frontmatter
 *
 * Returns true if the file was modified, false if no changes needed.
 * Returns false (no-op) if marketplace.json does not exist.
 */
export async function refreshMarketplace(repoPath: string): Promise<boolean> {
  const marketplacePath = path.join(repoPath, MARKETPLACE_PATH);
  if (!await pathExists(marketplacePath)) {
    return false;
  }

  const raw = await readFileSafe(marketplacePath);
  if (!raw) return false;

  let marketplace: MarketplaceJson;
  try {
    marketplace = JSON.parse(raw);
  } catch {
    log.warn('Failed to parse marketplace.json, skipping refresh');
    return false;
  }

  if (!Array.isArray(marketplace.plugins)) return false;

  // Collect current skill names from skills/ directory (flat layout only,
  // namespaced skills are not registered in marketplace)
  const skillsDir = path.join(repoPath, 'skills');
  const currentSkills = new Set<string>();
  const dirs = await listDirs(skillsDir);
  for (const dir of dirs) {
    const hasSkillMd = await pathExists(path.join(skillsDir, dir, SKILL_MD));
    if (hasSkillMd) {
      currentSkills.add(dir);
    }
  }

  // Build a map of existing strict:false plugins
  const existingPlugins = new Map<string, MarketplacePlugin>();
  const nonAutoPlugins: MarketplacePlugin[] = []; // strict:true or no strict field
  for (const plugin of marketplace.plugins) {
    if (plugin.strict === false) {
      existingPlugins.set(plugin.name, plugin);
    } else {
      nonAutoPlugins.push(plugin);
    }
  }

  let changed = false;
  const updatedPlugins: MarketplacePlugin[] = [];

  // Update existing entries and add new skills
  for (const skillName of currentSkills) {
    const existing = existingPlugins.get(skillName);
    if (existing) {
      // Refresh description from SKILL.md
      const desc = await extractSkillDescription(path.join(skillsDir, skillName));
      if (desc && desc !== existing.description) {
        existing.description = desc;
        changed = true;
      }
      updatedPlugins.push(existing);
      existingPlugins.delete(skillName);
    } else {
      // New skill — add with default entry
      const desc = await extractSkillDescription(path.join(skillsDir, skillName));
      updatedPlugins.push({
        name: skillName,
        source: `./skills/${skillName}`,
        description: desc || `${skillName} skill`,
        version: '1.0.0',
        strict: false,
      });
      changed = true;
      log.debug(`Added ${skillName} to marketplace.json`);
    }
  }

  // Remaining entries in existingPlugins are skills that were removed
  if (existingPlugins.size > 0) {
    changed = true;
    for (const name of existingPlugins.keys()) {
      log.debug(`Removed ${name} from marketplace.json`);
    }
  }

  if (!changed) return false;

  // Sort by name for stable output
  updatedPlugins.sort((a, b) => a.name.localeCompare(b.name));

  // Merge: non-auto plugins first, then auto-managed plugins
  marketplace.plugins = [...nonAutoPlugins, ...updatedPlugins];

  await writeFile(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
  log.debug(`Refreshed marketplace.json (${updatedPlugins.length} auto-managed plugins)`);
  return true;
}
