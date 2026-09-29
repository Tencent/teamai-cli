import {
    requireInit,
    saveLocalConfig,
    saveLocalConfigForScope,
    detectProjectConfig,
    loadStateForScope,
    saveStateForScope,
    loadTeamConfig,
} from './config.js';
import { buildRolePullContext, resolveDesiredSkills } from './resources/desired.js';
import { loadTagsConfig, collectTagStats, saveTagsConfig } from './utils/tags.js';
import { log } from './utils/logger.js';
import type { GlobalOptions, LocalConfig, TagsConfig } from './types.js';

/**
 * Resolve the active scope for tag operations: project scope when the cwd has
 * a project-scope install, otherwise user scope. Mirrors recall.ts/contribute.ts
 * so `tags list/subscribe/unsubscribe` agree with what `recall` actually queries
 * instead of always reading/writing ~/.teamai/config.yaml (#85).
 */
async function resolveTagsScope(options: GlobalOptions = {}): Promise<LocalConfig> {
    const projectConfig = await detectProjectConfig(undefined, undefined, options);
    return projectConfig ?? (await requireInit(options)).localConfig;
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

    // Changed subscriptions must bypass pull's unchanged-revision fast path so
    // newly matched resources are installed and filtered-out ones removed.
    try {
        const state = await loadStateForScope(localConfig);
        state.lastPullRev = null;
        await saveStateForScope(state, localConfig);
    } catch {
        // Missing/corrupt state is non-critical: the next pull performs a full sync.
    }
}

/**
 * List all available tags from the team repo's tags.yaml.
 * Shows tag name, skill count, and rule count.
 */
export async function tagsList(): Promise<void> {
    // Read-only: the load never persists a migration (#893).
    const localConfig = await resolveTagsScope({ dryRun: true });
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

    const untaggedSkills = await countUntaggedDeliveredSkills(localConfig, tagsConfig);

    console.log('');
    if (untaggedSkills !== null && untaggedSkills > 0) {
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

    const localConfig = await resolveTagsScope(options);
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

    if (options.dryRun) {
        log.info(`[dry-run] Would subscribe to: ${newTags.join(', ')}`);
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

    const localConfig = await resolveTagsScope(options);
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

    if (options.dryRun) {
        log.info(`[dry-run] Would unsubscribe from: ${removed.join(', ')}`);
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

    const localConfig = await resolveTagsScope(options);
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

    const localConfig = await resolveTagsScope(options);
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
 * How many untagged skills pull delivers. Pull delivers every skill in the
 * member's namespaces (all of them without roles) whatever its tags; tags only
 * add skills from elsewhere. So an untagged skill is synced exactly when pull
 * delivers it, and asking pull's own resolver keeps roles, exclusions and
 * same-name skills counted the way pull counts them. Null when pull would stop
 * on a delivery conflict, the team config is missing, or the resolver fails
 * (for example on a malformed manifest), so there is no count to show. The
 * count is only a hint, so a resolver failure warns instead of aborting the
 * listing that is already on screen.
 */
async function countUntaggedDeliveredSkills(localConfig: LocalConfig, tagsConfig: TagsConfig): Promise<number | null> {
    const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
    if (!teamConfig) return null;
    try {
        const desired = await resolveDesiredSkills(teamConfig, localConfig, await buildRolePullContext(localConfig));
        if (desired.kind !== 'resolved') return null;
        return desired.items.filter((item) => !tagsConfig.skills[item.name]?.length).length;
    } catch (e) {
        log.warn(`Could not count untagged skills: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
