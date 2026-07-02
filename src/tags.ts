import path from 'node:path';
import YAML from 'yaml';
import { requireInit, saveLocalConfig, saveLocalConfigForScope, detectProjectConfig } from './config.js';
import { loadTagsConfig, collectTagStats, saveTagsConfig } from './utils/tags.js';
import { log } from './utils/logger.js';
import { readFileSafe } from './utils/fs.js';
import type { GlobalOptions, LocalConfig, TagsConfig } from './types.js';

/**
 * Resolve the active scope for tag operations: project scope when the cwd has
 * a project-scope install, otherwise user scope. Mirrors recall.ts/contribute.ts
 * so `tags list/subscribe/unsubscribe` agree with what `recall` actually queries
 * instead of always reading/writing ~/.teamai/config.yaml (#85).
 */
async function resolveTagsScope(): Promise<LocalConfig> {
    const projectConfig = await detectProjectConfig();
    return projectConfig ?? (await requireInit()).localConfig;
}

/**
 * Persist a LocalConfig back to whichever scope it was loaded from.
 */
async function saveTagsScopeConfig(localConfig: LocalConfig): Promise<void> {
    if (localConfig.scope === 'project') {
        await saveLocalConfigForScope(localConfig, 'project', localConfig.projectRoot);
    } else {
        await saveLocalConfig(localConfig);
    }
}

/**
 * List all available tags from the team repo's tags.yaml.
 * Shows tag name, skill count, and rule count.
 */
export async function tagsList(options: GlobalOptions): Promise<void> {
    const localConfig = await resolveTagsScope();
    const tagsConfig = await loadTagsConfig(localConfig.repo.localPath);

    if (!tagsConfig) {
        log.info('No tags.yaml found in team repo. Tags are not configured yet.');
        return;
    }

    const stats = collectTagStats(tagsConfig);

    if (stats.size === 0) {
        log.info('tags.yaml exists but contains no tags.');
        return;
    }

    // Show current subscriptions
    const subscribed = new Set(localConfig.subscribedTags ?? []);
    if (subscribed.size > 0) {
        log.info(`Your subscriptions: ${[...subscribed].join(', ')}`);
    } else {
        log.info('You have no tag subscriptions (pulling all resources).');
    }
    console.log('');

    // Display tag table
    console.log('  Tag'.padEnd(22) + 'Skills'.padEnd(10) + 'Rules'.padEnd(10) + 'Subscribed');
    console.log('  ' + '─'.repeat(50));

    const sortedTags = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [tag, count] of sortedTags) {
        const sub = subscribed.has(tag) ? '  ✓' : '';
        console.log(
            `  ${tag.padEnd(20)}${String(count.skills).padEnd(10)}${String(count.rules).padEnd(10)}${sub}`,
        );
    }

    const totalSkills = Object.keys(tagsConfig.skills).length;
    const totalRules = Object.keys(tagsConfig.rules).length;
    const allTeamSkills = await getTeamSkillCount(localConfig.repo.localPath);
    const untaggedSkills = allTeamSkills - totalSkills;

    console.log('');
    if (untaggedSkills > 0) {
        log.dim(`  ${untaggedSkills} skill(s) have no tags and are always synced.`);
    }
}

/**
 * Subscribe to one or more tags.
 */
export async function tagsSubscribe(tags: string[], options: GlobalOptions): Promise<void> {
    if (tags.length === 0) {
        log.error('Please specify at least one tag. Example: teamai tags subscribe hai gpu');
        return;
    }

    const localConfig = await resolveTagsScope();
    const existing = new Set(localConfig.subscribedTags ?? []);

    const newTags: string[] = [];
    for (const tag of tags) {
        if (!existing.has(tag)) {
            existing.add(tag);
            newTags.push(tag);
        }
    }

    if (newTags.length === 0) {
        log.info('Already subscribed to all specified tags.');
        return;
    }

    const updatedConfig = {
        ...localConfig,
        subscribedTags: [...existing].sort(),
    };
    await saveTagsScopeConfig(updatedConfig);
    log.success(`Subscribed to: ${newTags.join(', ')}`);
    log.dim('Run `teamai pull` to sync matching resources.');
}

/**
 * Unsubscribe from one or more tags.
 */
export async function tagsUnsubscribe(tags: string[], options: GlobalOptions): Promise<void> {
    if (tags.length === 0) {
        log.error('Please specify at least one tag. Example: teamai tags unsubscribe hai');
        return;
    }

    const localConfig = await resolveTagsScope();
    const existing = new Set(localConfig.subscribedTags ?? []);

    const removed: string[] = [];
    for (const tag of tags) {
        if (existing.has(tag)) {
            existing.delete(tag);
            removed.push(tag);
        }
    }

    if (removed.length === 0) {
        log.info('Not subscribed to any of the specified tags.');
        return;
    }

    const updatedConfig = {
        ...localConfig,
        subscribedTags: existing.size > 0 ? [...existing].sort() : undefined,
    };
    await saveTagsScopeConfig(updatedConfig);
    log.success(`Unsubscribed from: ${removed.join(', ')}`);
    log.dim('Run `teamai pull` to clean up filtered-out resources.');
}

/**
 * Add tags to a skill or rule in tags.yaml (admin operation).
 * Creates tags.yaml if it doesn't exist.
 */
export async function tagsAdd(
    resourceType: 'skills' | 'rules',
    name: string,
    tags: string[],
    options: GlobalOptions,
): Promise<void> {
    if (tags.length === 0) {
        log.error('Please specify at least one tag. Example: teamai tags add skills hai-deploy hai infra');
        return;
    }

    const localConfig = await resolveTagsScope();
    const repoPath = localConfig.repo.localPath;

    let tagsConfig = await loadTagsConfig(repoPath);
    if (!tagsConfig) {
        tagsConfig = { skills: {}, rules: {} };
    }

    const map = resourceType === 'skills' ? tagsConfig.skills : tagsConfig.rules;
    const existing = new Set(map[name] ?? []);
    for (const tag of tags) {
        existing.add(tag);
    }
    map[name] = [...existing].sort();

    if (options.dryRun) {
        log.info(`[dry-run] Would set ${resourceType}/${name} tags to: ${map[name].join(', ')}`);
        return;
    }

    await saveTagsConfig(repoPath, tagsConfig);
    log.success(`Set ${resourceType}/${name} tags: ${map[name].join(', ')}`);
    log.dim('Commit and push the team repo to share with the team.');
}

/**
 * Remove tags from a skill or rule in tags.yaml.
 */
export async function tagsRemove(
    resourceType: 'skills' | 'rules',
    name: string,
    tags: string[],
    options: GlobalOptions,
): Promise<void> {
    if (tags.length === 0) {
        log.error('Please specify at least one tag to remove.');
        return;
    }

    const localConfig = await resolveTagsScope();
    const repoPath = localConfig.repo.localPath;

    const tagsConfig = await loadTagsConfig(repoPath);
    if (!tagsConfig) {
        log.error('No tags.yaml found in team repo.');
        return;
    }

    const map = resourceType === 'skills' ? tagsConfig.skills : tagsConfig.rules;
    const existing = map[name];
    if (!existing || existing.length === 0) {
        log.info(`${resourceType}/${name} has no tags.`);
        return;
    }

    const toRemove = new Set(tags);
    const remaining = existing.filter((t) => !toRemove.has(t));

    if (remaining.length === existing.length) {
        log.info(`None of the specified tags were found on ${resourceType}/${name}.`);
        return;
    }

    if (remaining.length === 0) {
        delete map[name];
    } else {
        map[name] = remaining;
    }

    if (options.dryRun) {
        log.info(`[dry-run] Would update ${resourceType}/${name} tags to: ${remaining.join(', ') || '(none)'}`);
        return;
    }

    await saveTagsConfig(repoPath, tagsConfig);
    log.success(`Updated ${resourceType}/${name} tags: ${remaining.join(', ') || '(removed all)'}`);
}

/**
 * Count total team skills by listing skill directories.
 */
async function getTeamSkillCount(repoPath: string): Promise<number> {
    try {
        const { listDirs } = await import('./utils/fs.js');
        const skillsDir = path.join(repoPath, 'skills');
        const dirs = await listDirs(skillsDir);
        return dirs.length;
    } catch {
        return 0;
    }
}
