import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureDir, writeFile, pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { renderRuleForTool, ruleFileExtensionForTool } from './resources/rule-format.js';
import type { TeamaiConfig, LocalConfig } from './types.js';
import { installOf, locate, ownOf, writable, type Install } from './locate.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { DeliveryRecorder } from './git-exclude-delivered.js';
import { recordDelivered, type DeliveryLedger } from './resources/delivered-copies.js';
import { RESOURCE_LAYOUTS, Resources, type ShippedFile, type TeamaiLayer } from './resources/resolver.js';
import { RuleFolders } from './resources/rule-folders.js';
import { warnOnce } from './utils/warn-once.js';

// ─── Built-in rules deployment ──────────────────────────
//
//  CLI ships with built-in rules that guide AI tool behavior, deployed
//  automatically on each `teamai pull`.
//
//  The recall rule is the folder rules/teamai-recall/ in the package
//  (#1787), which a team replaces with its own at the root of the team
//  repo. It instructs the AI to proactively search the team
//  knowledge base (via the `teamai-recall` subagent or `teamai recall`)
//  before starting a task — this replaced the old passive auto-recall
//  PostToolUse hook, which fired implicitly on every Bash/Grep/WebSearch/
//  WebFetch call but added noise without the benefit of the subagent's
//  codebase-graph drill-down and compact structured output.
//

/** Names of CLI built-in rules. Used by push to exclude them from team repo push. */
export const BUILTIN_RULE_NAMES = new Set<string>(['teamai-recall']);

/** Names of previously deployed rules that should be cleaned up. */
export const LEGACY_RULE_NAMES: string[] = [];

/**
 * The rule file a pull writes the culture, claudemd and recall blocks into
 * for tools whose rules directory is their instruction target (#945).
 */
export const TEAMAI_CONTEXT_RULE_NAME = 'teamai-context';

/**
 * Names that scanLocalForPush and stale-cleanup should skip.
 * Includes both current built-in rules and legacy rules (being cleaned up).
 */
export const EXCLUDED_RULE_NAMES = new Set<string>([
    ...BUILTIN_RULE_NAMES,
    ...LEGACY_RULE_NAMES,
    TEAMAI_CONTEXT_RULE_NAME,
]);

/**
 * Deploy CLI built-in rules to all configured AI tool rules directories.
 *
 * Also cleans up legacy built-in rules that are no longer deployed.
 *
 * @returns Number of tool directories that received built-in rules.
 */
export async function deployBuiltinRules(
    teamConfig: TeamaiConfig,
    localConfig?: LocalConfig,
    options?: {
        skipRecall?: boolean; recorder?: DeliveryRecorder; dryRun?: boolean;
        /** Gets each tool that did not take every built-in rule (`DeliveryLedger.toolsMissingRules`). */
        toolsMissingRules?: Set<string>;
        /** Records each copy of a team's replacement (#1787); teamai's own copies are known by `isDeployedRecallRule`. */
        ledger?: DeliveryLedger;
    },
): Promise<number> {
    const install: Install = localConfig === undefined
        ? { toolPaths: teamConfig.toolPaths, agents: {}, toolRoots: {}, gitExclude: false, scope: 'user' }
        : installOf(teamConfig, localConfig);

    let deployed = 0;

    const recall = options?.skipRecall ? null : await recallTexts(teamConfig.language, localConfig?.repo.localPath);

    const builtinRules: Array<{ name: string; content: string; replaced: boolean }> = recall === null ? [] : [
        { name: RECALL_RULE_NAME, content: recall.rule, replaced: recall.replaced },
    ];

    for (const tool of Object.keys(install.toolPaths)) {
        const location = await locate(tool, 'rules', install);

        if (ownOf(location)?.kind !== 'dir') continue;
        const own = writable(location);

        if (own === null) {
            log.debug(`Skipping built-in rules for ${tool}: tool not installed`);
            continue;
        }

        const rulesDir = own.path;

        if (!await pathExists(rulesDir)) continue;

        // A dry run writes nothing: it reports where each rule would land (#915).
        if (options?.dryRun) {
            const ext = ruleFileExtensionForTool(tool);

            for (const rule of builtinRules) options.recorder?.report('builtin', path.join(rulesDir, `${rule.name}${ext}`));
            deployed++;
            continue;
        }

        try {
            await ensureDir(rulesDir);

            // Deploy current built-in rules in each tool's own rules format
            // (`.mdc` for Cursor, Kiro's and Qoder's frontmatter, …); a tool
            // without one gets the canonical `.md`.
            const ext = ruleFileExtensionForTool(tool);

            for (const rule of builtinRules) {
                const destFile = path.join(rulesDir, `${rule.name}${ext}`);
                const content = renderRuleForTool(tool, rule.content);
                await writeFile(destFile, content);
                options?.recorder?.report('builtin', destFile);

                if (rule.replaced && options?.ledger) await recordDelivered(options.ledger.hashes, destFile);
                log.debug(`Deployed built-in rule ${rule.name} → ${tool}`);

                // Drop the `.md` copy an older layout left in an `.mdc` rules dir.
                if (ext !== '.md') {
                    try {
                        await fs.unlink(path.join(rulesDir, `${rule.name}.md`));
                        log.debug(`Removed legacy .md built-in rule ${rule.name} from ${tool}`);
                    } catch {
                        // File doesn't exist — that's fine
                    }
                }
            }

            // Clean up legacy rules no longer deployed (both extensions)
            for (const legacyName of LEGACY_RULE_NAMES) {
                for (const legacyExt of new Set<string>([ext, '.md'])) {
                    const legacyFile = path.join(rulesDir, `${legacyName}${legacyExt}`);

                    try {
                        await fs.unlink(legacyFile);
                        log.debug(`Removed legacy built-in rule ${legacyName} from ${tool}`);
                    } catch {
                        // File doesn't exist — that's fine
                    }
                }
            }

            deployed++;
        } catch (e) {
            options?.recorder?.failed('builtin');
            options?.toolsMissingRules?.add(tool);
            log.error(`Failed to deploy built-in rules to ${tool}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return deployed;
}

// ─── Rule content ──────────────────────────────────────

/**
 * SHA-256 of every `teamai-recall` rule body a teamai version deployed, newest
 * first (from `git log origin/main -- src/builtin-rules.ts
 * rules/teamai-recall/`). teamai's bodies are not in the delivery ledger, so
 * these hashes are what proves a copy in a Codex legacy rules dir unedited.
 * Add the new hash when either deployed body changes (`RULE.md`, the
 * historical bilingual text, or `RULE.en.md`, #1014): a team `toolPaths` that
 * still names such a dir keeps receiving the current body. A team
 * replacement's copies are recognised through the delivery ledger instead.
 */
const DEPLOYED_RECALL_RULE_HASHES = new Set<string>([
    '37d1a34f733bfb15e291b08bd17951f2764b91047117d1b2c396e7d01c67c038',
    '9fbe3cc0b5bd39b9418ab2672a38cac831f2d4a3ab31ad539ce4de51d0bcab7f',
    '564b9e8369fbc0009580f0174af119144da6b07ee4e1030f75bc5a03e9c60015',
    '11698b506859049b7dc7ceb7ea149c371ae42dfc0db9a512763d9295f4af480e',
    '37af125211b657cb81d5d3b11ef1c3a1daaa38d3f3323255258033c18ebd03d8',
    '6ef190b7ac41d95357dc3de82791c4cea97203409972a53f6cbae21fe23b4f33',
    'c15adbb1b6d9a96ebe71eed179edbe150ea840505169068af8ae3b79429a83f6',
    '0c9fc1c9c026f5625f42062e8116bc6f8985a6177ecc5ed7328a74159b2ba525',
    '168278feb1a0b5d936497bc8e29cc5652dc472b69ddaba3ee9737fff90bb2c91',
    '1929d8f639410e94315450548ab4a063cce0ace9415e48f0444666d8bc33c680',
    'ed52f7cd1c2baa891e83b285bd5dd1347a2e7b31b613b1b2843fdaea6ff0d140',
]);

/**
 * True when `content` is the `teamai-recall` rule exactly as some teamai
 * version deployed it. A member's edit since the last pull that wrote the
 * file makes it false, so the copy is kept.
 */
export function isDeployedRecallRule(content: string): boolean {
    return DEPLOYED_RECALL_RULE_HASHES.has(crypto.createHash('sha256').update(content).digest('hex'));
}

/** teamai's recall rule, which a team replaces with a folder of this name at the root of `rules/` (#1787). */
export const RECALL_RULE_NAME = 'teamai-recall';

/** The package root, holding `rules/`. This file sits one level below it, in src/ and in the bundle in dist/ alike. */
function packageRoot(): string {
    const modulePath = fileURLToPath(import.meta.url);
    let moduleDir: string;

    try {
        moduleDir = path.dirname(realpathSync(modulePath));
    } catch {
        moduleDir = path.dirname(modulePath);
    }

    return path.join(moduleDir, '..');
}

/** teamai's rules, the bottom layer of the rules resolver: its package's `rules/teamai-recall/` (#1787). */
const TEAMAI_RULES: TeamaiLayer<ShippedFile> = { root: packageRoot(), read: (file) => file };

/** The recall rule and blocks for one language, as pull writes them: the rule ending in one newline, each block's body without its markers. */
export interface RecallTexts {
    readonly rule: string;
    readonly block: string;
    readonly directBlock: string;
    /** The team's replacement, not teamai's folder. */
    readonly replaced: boolean;
}

/**
 * What a recall folder holds, text by text: the base file, which a team replacement must have, and the lines every
 * language of it must keep, because recall's own output and doctor point at them (#1787).
 */
const RECALL_FILES = [
    { stem: 'RULE', lines: ['Nothing was searched:', 'Recall skips the older index'] },
    { stem: 'block', lines: [] },
    { stem: 'block-direct', lines: ['Nothing was searched:'] },
] as const;

/** The recall folder that applies with the team repo at `repoPath`: the team's `rules/teamai-recall/` folder at its root, else teamai's. */
async function recallFolder(repoPath: string | undefined): Promise<{ readonly dir: string; readonly path: string; readonly team: boolean }> {
    const tree = { team: repoPath === undefined ? undefined : { root: repoPath, namespaces: async () => [] }, teamai: TEAMAI_RULES };
    const resolution = await Resources.resolve(RESOURCE_LAYOUTS.rules, RECALL_RULE_NAME, tree);
    const item = resolution.kind === 'resolved' ? resolution.item : null;
    const teamai = { dir: path.join(TEAMAI_RULES.root, 'rules', RECALL_RULE_NAME), path: `rules/${RECALL_RULE_NAME}/`, team: false };

    // Only a folder replaces it; a rules/teamai-recall.md is a rule like any other.
    return item !== null && item.layer !== 'teamai' && item.source.kind === 'folder' ? { dir: item.source.full, path: item.source.path, team: true } : teamai;
}

/** Why the recall folder at `dir` (shown as `shown`) breaks the contract (`RECALL_FILES`), or null when it keeps it. */
async function recallFolderProblem(dir: string, shown: string): Promise<string | null> {
    const names = await fs.readdir(dir).catch((): string[] => []);

    for (const { stem, lines } of RECALL_FILES) {
        if (!names.includes(`${stem}.md`)) return `${shown}${stem}.md is missing`;

        for (const name of names.filter((found) => new RegExp(`^${stem}(\\.[a-z]+)?\\.md$`).test(found))) {
            const content = await RuleFolders.readTextFile(path.join(dir, name));

            if (content === null) return `${shown}${name} cannot be read`;
            const missing = lines.find((line) => !content.includes(line));

            if (missing !== undefined) return `${shown}${name} does not contain "${missing}"`;
        }
    }

    return null;
}

/** The recall texts of the folder at `dir` for `language`, each language falling back to the folder's own base file; null when one cannot be read. */
async function readRecallTexts(folder: { readonly dir: string; readonly path: string; readonly team: boolean }, language: TeamaiConfig['language']): Promise<RecallTexts | null> {
    const read = async (stem: string): Promise<string | null> => RuleFolders.readTextFile(path.join(folder.dir, await RuleFolders.languageFile(folder.dir, stem, language)));
    const rule = await RuleFolders.text({ name: RECALL_RULE_NAME, type: 'rules', sourcePath: path.join(folder.dir, 'RULE.md'), relativePath: `${folder.path}RULE.md`, folder: true }, language);
    const [block, directBlock] = [await read('block'), await read('block-direct')];

    return rule === null || block === null || directBlock === null ? null : { rule, block, directBlock, replaced: folder.team };
}

/**
 * The recall rule and blocks for `language` with the team repo at `repoPath` (#1787): its `rules/teamai-recall/`
 * folder when it keeps the contract (`RECALL_FILES`), else teamai's, which the team's refusal names once.
 */
export async function recallTexts(language: TeamaiConfig['language'], repoPath?: string): Promise<RecallTexts> {
    const folder = await recallFolder(repoPath);

    if (folder.team) {
        const problem = await recallFolderProblem(folder.dir, folder.path);
        const texts = problem === null ? await readRecallTexts(folder, language) : null;

        if (texts !== null) return texts;
        warnOnce(`${folder.path} is not used, so teamai's recall rule stays in force: ${problem ?? `${folder.path} cannot be read`}. Fix the folder in the team repo.`);
    }

    const texts = await readRecallTexts({ dir: path.join(TEAMAI_RULES.root, 'rules', RECALL_RULE_NAME), path: `rules/${RECALL_RULE_NAME}/`, team: false }, language);

    if (texts === null) throw new Error(`teamai's ${RECALL_RULE_NAME} folder cannot be read in ${TEAMAI_RULES.root}; reinstall teamai.`);

    return texts;
}
