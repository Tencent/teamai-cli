import path from 'node:path';
import { ensureDir, writeFile, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { ResourceHandler } from './resources/base.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { resolveBaseDir } from './types.js';
import fs from 'node:fs/promises';

// ─── Built-in rules deployment ──────────────────────────
//
//  CLI ships with built-in rules that guide AI tool behavior.
//  Unlike team repo rules (managed by users), these are
//  maintained alongside the CLI code and deployed automatically
//  on each `teamai pull`.
//
//  Currently no built-in rules are deployed — auto-recall hooks
//  replaced the old teamai-recall.md rule. The infrastructure
//  is kept for future built-in rules.
//
//  Legacy cleanup: removes old teamai-recall.md files on pull.
//

/** Names of CLI built-in rules. Used by push to exclude them from team repo push. */
export const BUILTIN_RULE_NAMES = new Set<string>();

/** Names of previously deployed rules that should be cleaned up. */
export const LEGACY_RULE_NAMES = ['teamai-recall'];

/**
 * Names that scanLocalForPush and stale-cleanup should skip.
 * Includes both current built-in rules and legacy rules (being cleaned up).
 */
export const EXCLUDED_RULE_NAMES = new Set<string>([
    ...BUILTIN_RULE_NAMES,
    ...LEGACY_RULE_NAMES,
]);

/**
 * Deploy CLI built-in rules to all configured AI tool rules directories.
 *
 * Also cleans up legacy built-in rules that are no longer deployed.
 *
 * @returns Number of tool directories that received built-in rules.
 */
export async function deployBuiltinRules(teamConfig: TeamaiConfig, localConfig?: LocalConfig): Promise<number> {
    const baseDir = localConfig ? resolveBaseDir(localConfig) : (process.env.HOME ?? '');
    let deployed = 0;

    // No built-in rules to deploy currently
    const builtinRules: Array<{ name: string; content: string }> = [];

    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
        if (!toolPath.rules) continue;

        // Skip tools that are not installed
        if (!await ResourceHandler.isToolInstalled(toolPath.rules, baseDir)) {
            log.debug(`Skipping built-in rules for ${tool}: tool not installed`);
            continue;
        }

        const rulesDir = path.join(baseDir, toolPath.rules);
        if (!await pathExists(rulesDir)) continue;

        try {
            await ensureDir(rulesDir);

            // Deploy current built-in rules
            for (const rule of builtinRules) {
                const destFile = path.join(rulesDir, `${rule.name}.md`);
                await writeFile(destFile, rule.content);
                log.debug(`Deployed built-in rule ${rule.name} → ${tool}`);
            }

            // Clean up legacy rules no longer deployed
            for (const legacyName of LEGACY_RULE_NAMES) {
                const legacyFile = path.join(rulesDir, `${legacyName}.md`);
                try {
                    await fs.unlink(legacyFile);
                    log.debug(`Removed legacy built-in rule ${legacyName} from ${tool}`);
                } catch {
                    // File doesn't exist — that's fine
                }
            }

            deployed++;
        } catch (e) {
            log.error(`Failed to deploy built-in rules to ${tool}: ${(e as Error).message}`);
        }
    }

    return deployed;
}
