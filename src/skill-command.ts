/**
 * Shared skill-distribution primitive (issue #1, §二·五).
 *
 * This is the single, global skill-distribution executor used by BOTH:
 *   - push path (方案二 status reporting): commands come from `sync`,
 *     targetSkillsDir = the agent's own skills dir (e.g. ~/.codebuddy/skills).
 *   - pull path (方案一 HTTP team repo): commands come from `GET /repo`,
 *     targetSkillsDir = localPath/skills (materialized into the team repo tree).
 *
 * A skill package is a ZIP whose top level is a single skill directory named
 * after the slug (`<slug>/SKILL.md ...`). We decompress with `fflate` (pure JS,
 * cross-platform) — never the system `unzip`, which is absent on Windows.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import YAML from 'yaml';
import { ensureDir, remove, writeFile, pathExists, readFileSafe, readJson, writeJson } from './utils/fs.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { log } from './utils/logger.js';

/** Command types in the iWiki/clawpro contract. */
export type SkillCommandType = 'install_skill' | 'uninstall_skill' | 'update_skill';

/** A single skill-distribution command (server `skill_distribution_record`). */
export interface SkillCommand {
  /** Command id (int, echoed back in the ack request body). Optional for the pull path. */
  id?: number;
  type: SkillCommandType;
  skill_slug: string;
  /** Target version (required for install/update; optional for uninstall). */
  skill_version?: string;
  /** Temporary, SMH-signed download URL (required for install/update). */
  download_url?: string;
}

/** Maximum accepted skill-package size (defensive limit). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** Optional download host allowlist via env (comma-separated). Empty = allow all. */
function downloadHostAllowlist(): string[] {
  const raw = process.env.TEAMAI_SKILL_DOWNLOAD_HOSTS;
  if (!raw) return [];
  return raw.split(',').map((h) => h.trim()).filter(Boolean);
}

function assertAllowedDownloadHost(downloadUrl: string): void {
  const allow = downloadHostAllowlist();
  if (allow.length === 0) return;
  let host: string;
  try {
    host = new URL(downloadUrl).host;
  } catch {
    throw new Error(`Invalid download_url: ${downloadUrl}`);
  }
  if (!allow.includes(host)) {
    throw new Error(`download_url host "${host}" is not in TEAMAI_SKILL_DOWNLOAD_HOSTS allowlist`);
  }
}

/**
 * Download a skill ZIP. The URL is SMH-signed (auth lives in the query string),
 * so we GET it directly, following 30x redirects, WITHOUT a Bearer header.
 */
async function downloadZip(downloadUrl: string): Promise<Uint8Array> {
  assertAllowedDownloadHost(downloadUrl);
  log.debug(`[skill-command] downloading skill package: ${downloadUrl}`);
  const res = await fetch(downloadUrl, { redirect: 'follow' });
  if (!res.ok) {
    // Surface the server's response body (truncated) + the URL so a failed
    // install is actually diagnosable from debug.log / the ack error field.
    let detail = '';
    try {
      const body = (await res.text()).trim();
      if (body) detail = `: ${body.slice(0, 300)}`;
    } catch {
      // body may be unreadable — best-effort only
    }
    throw new Error(`download failed: HTTP ${res.status}${detail} (url: ${downloadUrl})`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_ZIP_BYTES) {
    throw new Error(`skill package too large: ${buf.byteLength} bytes`);
  }
  return buf;
}

/**
 * Locate the SKILL.md inside a skill ZIP and return the path prefix that should
 * be stripped when installing. Tolerates the layouts seen in the wild:
 *
 *   1. `<slug>/SKILL.md ...`  → prefix `<slug>/`  (teamai contract)
 *   2. `SKILL.md ...`         → prefix `''`        (flat zip, e.g. skillhub/clawpro)
 *   3. `<anyDir>/SKILL.md`    → prefix `<anyDir>/` (nested dir whose name ≠ slug)
 *
 * Returns null when no SKILL.md is present at all (truly malformed package).
 */
function resolveSkillPrefix(entries: Record<string, Uint8Array>, slug: string): string | null {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(entries, k);
  if (has(`${slug}/SKILL.md`)) return `${slug}/`;
  if (has('SKILL.md')) return '';
  for (const key of Object.keys(entries)) {
    const m = key.match(/^([^/]+)\/SKILL\.md$/);
    if (m) return `${m[1]}/`;
  }
  return null;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

async function readSkillNameFromExtracted(skillDir: string): Promise<string | null> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return null;
  const fm = content.match(FRONTMATTER_REGEX);
  if (!fm) return null;
  try {
    const parsed = YAML.parse(fm[1]);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      return parsed.name.trim() || null;
    }
  } catch { /* malformed YAML — fall through */ }
  return null;
}

function slugMapPath(targetSkillsDir: string): string {
  return path.join(targetSkillsDir, '_slug-map.json');
}

async function readSlugMap(targetSkillsDir: string): Promise<Record<string, string>> {
  return (await readJson<Record<string, string>>(slugMapPath(targetSkillsDir))) ?? {};
}

async function writeSlugMapEntry(targetSkillsDir: string, slug: string, dirName: string): Promise<void> {
  const map = await readSlugMap(targetSkillsDir);
  map[slug] = dirName;
  await writeJson(slugMapPath(targetSkillsDir), map);
}

async function removeSlugMapEntry(targetSkillsDir: string, slug: string): Promise<void> {
  const map = await readSlugMap(targetSkillsDir);
  if (!(slug in map)) return;
  delete map[slug];
  if (Object.keys(map).length === 0) {
    await remove(slugMapPath(targetSkillsDir));
  } else {
    await writeJson(slugMapPath(targetSkillsDir), map);
  }
}

/**
 * Decompress a skill ZIP and install it under `targetSkillsDir/`.
 *
 * The directory name is determined by the SKILL.md `name:` frontmatter field
 * when it differs from the server-provided slug. Falls back to `slug` when the
 * name is missing, empty, or fails safety validation.
 *
 * Returns the actual directory name used (may differ from `slug`).
 */
export async function installSkillZip(
  zip: Uint8Array,
  slug: string,
  targetSkillsDir: string,
): Promise<string> {
  assertSafeResourceName(slug);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (e) {
    throw new Error(`failed to unzip skill package: ${(e as Error).message}`);
  }

  const prefix = resolveSkillPrefix(entries, slug);
  if (prefix === null) {
    throw new Error(`skill package missing ${slug}/SKILL.md (no SKILL.md found at zip root or under any top-level dir — malformed package)`);
  }

  // Clean up any prior install — both the slug dir and any previously mapped dir.
  const destRoot = path.join(targetSkillsDir, slug);
  await remove(destRoot);
  const oldMap = await readSlugMap(targetSkillsDir);
  if (oldMap[slug] && oldMap[slug] !== slug) {
    await remove(path.join(targetSkillsDir, oldMap[slug]));
  }

  await ensureDir(destRoot);

  const resolvedRoot = path.resolve(destRoot);
  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (prefix && !entryPath.startsWith(prefix)) continue;
    if (entryPath.endsWith('/')) continue;

    const rel = prefix ? entryPath.slice(prefix.length) : entryPath;
    if (!rel) continue;
    const outPath = path.resolve(destRoot, rel);
    if (outPath !== resolvedRoot && !outPath.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`path traversal detected in skill package: ${entryPath}`);
    }
    await ensureDir(path.dirname(outPath));
    await writeFile(outPath, Buffer.from(bytes).toString('utf-8'));
  }

  // Rename directory to match SKILL.md name when it differs from the slug.
  const skillName = await readSkillNameFromExtracted(destRoot);
  let actualDir = slug;

  if (skillName && skillName !== slug) {
    try {
      assertSafeResourceName(skillName);
      const finalDest = path.join(targetSkillsDir, skillName);
      await remove(finalDest);
      await fs.rename(destRoot, finalDest);
      actualDir = skillName;
      log.debug(`[skill-command] renamed ${slug}/ → ${skillName}/ (SKILL.md name)`);
    } catch {
      log.debug(`[skill-command] keeping slug "${slug}" as dir name (SKILL.md name "${skillName}" failed safety check or rename)`);
    }
  }

  await writeSlugMapEntry(targetSkillsDir, slug, actualDir);
  return actualDir;
}

/**
 * Execute one skill command against a target skills directory.
 *
 * - install_skill / update_skill: download zip → unzip → install to `<slug>/`.
 * - uninstall_skill: remove `<slug>/` (missing dir ⇒ idempotent success).
 *
 * Throws on failure so the caller can ack(failed, error). Never retries.
 */
export async function executeSkillCommand(cmd: SkillCommand, targetSkillsDir: string): Promise<void> {
  assertSafeResourceName(cmd.skill_slug);

  switch (cmd.type) {
    case 'install_skill':
    case 'update_skill': {
      if (!cmd.download_url) {
        throw new Error(`${cmd.type} requires download_url`);
      }
      const zip = await downloadZip(cmd.download_url);
      const actualDir = await installSkillZip(zip, cmd.skill_slug, targetSkillsDir);
      log.debug(`[skill-command] ${cmd.type} ${cmd.skill_slug}@${cmd.skill_version ?? '?'} → ${targetSkillsDir}/${actualDir}`);
      return;
    }
    case 'uninstall_skill': {
      const dir = path.join(targetSkillsDir, cmd.skill_slug);
      if (await pathExists(dir)) {
        await remove(dir);
      } else {
        const map = await readSlugMap(targetSkillsDir);
        const mapped = map[cmd.skill_slug];
        if (mapped && mapped !== cmd.skill_slug) {
          const mappedDir = path.join(targetSkillsDir, mapped);
          if (await pathExists(mappedDir)) {
            await remove(mappedDir);
          }
        }
      }
      await removeSlugMapEntry(targetSkillsDir, cmd.skill_slug);
      log.debug(`[skill-command] uninstall_skill ${cmd.skill_slug} (from ${targetSkillsDir})`);
      return;
    }
    default:
      throw new Error(`unknown skill command type: ${(cmd as SkillCommand).type}`);
  }
}
