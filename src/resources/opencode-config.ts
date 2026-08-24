import path from 'node:path';
import { readFileSafe, writeJsonAtomic, pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';

// ─── OpenCode config activation ──────────────────────────────
//
//  Unlike every other tool teamai targets, OpenCode does not auto-scan a rules
//  directory. Rule .md files copied into `.opencode/rules/` are inert until they
//  are referenced from the `instructions` array in `opencode.json`. This module
//  maintains exactly one teamai-managed glob in that array by key-level surgery:
//  it reads the JSON, adds or removes only our glob, and writes every other
//  top-level key (including `mcp`, which the MCP reconcile engine owns) back
//  untouched. It never rewrites the user's own `instructions` entries.
//
//  The same opencode.json is shared with the MCP `mcp` key, so both writers must
//  be surgical — a regenerate-from-scratch here would clobber injected servers.

/**
 * The glob OpenCode should use to load teamai-managed rules, expressed relative
 * to the directory that holds opencode.json.
 *
 * OpenCode resolves relative `instructions` paths against the config file's own
 * directory. In project scope, opencode.json sits at the repo root and rules at
 * `<root>/.opencode/rules`, giving `.opencode/rules/*.md` (the same shape as the
 * documented `.cursor/rules/*.md` example). In user scope, both live under
 * `~/.config/opencode/`, giving a clean `rules/*.md`.
 */
export function opencodeRulesGlob(configFileAbs: string, rulesDirAbs: string): string {
  const rel = path.relative(path.dirname(configFileAbs), rulesDirAbs);
  // Always use forward slashes: opencode.json globs are POSIX-style.
  const relPosix = rel.split(path.sep).join('/');
  return `${relPosix}/*.md`;
}

/**
 * Ensure `opencode.json` references (or stops referencing) the teamai rules glob.
 *
 * @param configFileAbs Absolute path to the opencode.json to edit.
 * @param glob          The instructions glob to add/remove (see opencodeRulesGlob).
 * @param present       true = the glob should be in `instructions`; false = removed.
 * @returns true if the file was written.
 *
 * When `present` is true and the file does not exist, it is created with just the
 * `instructions` array — teamai owns nothing else in it. When `present` is false
 * and the file does not exist, nothing happens. A file that exists but cannot be
 * parsed as a JSON object is left strictly alone (it may hold config we do not
 * understand), and the function returns false.
 */
export async function reconcileOpencodeInstructions(
  configFileAbs: string,
  glob: string,
  present: boolean,
): Promise<boolean> {
  const exists = await pathExists(configFileAbs);

  if (!exists) {
    if (!present) return false;
    await writeJsonAtomic(configFileAbs, { instructions: [glob] });
    log.debug(`Created ${configFileAbs} with teamai rules instructions glob`);
    return true;
  }

  const raw = await readFileSafe(configFileAbs);
  if (raw === null) return false;

  let data: Record<string, unknown>;
  if (raw.trim() === '') {
    data = {};
  } else {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log.warn(`Could not parse ${configFileAbs} as a JSON object — skipping OpenCode rules activation`);
        return false;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      log.warn(`Could not parse ${configFileAbs} — skipping OpenCode rules activation`);
      return false;
    }
  }

  // Operate on the array in place so the relative order of the user's own
  // entries — string globs and any non-string entries alike — is preserved.
  // (OpenCode may treat instruction order as precedence, so reordering the
  // user's entries on every pull would silently change their config.)
  const original = Array.isArray(data.instructions) ? [...(data.instructions as unknown[])] : [];
  const has = original.includes(glob);

  if (present && has) return false;
  if (!present && !has) return false;

  const next = present
    ? [...original, glob]           // append our glob without touching existing order
    : original.filter((g) => g !== glob); // remove only our glob, everything else stays put

  // Key-level surgery: drop `instructions` entirely when it would be empty,
  // otherwise write the reconciled array back.
  if (next.length === 0) {
    delete data.instructions;
  } else {
    data.instructions = next;
  }

  await writeJsonAtomic(configFileAbs, data);
  log.debug(`${present ? 'Added' : 'Removed'} teamai rules glob in ${configFileAbs}`);
  return true;
}
