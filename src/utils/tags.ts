import path from 'node:path';
import YAML from 'yaml';
import { parseYaml } from './yaml.js';
import { z } from 'zod';
import type { TagsConfig, ResourceItem } from '../types.js';
import { readFileSafe, writeFile } from './fs.js';
import { log } from './logger.js';

const TAGS_FILE = 'tags.yaml';

/** Resource name → tags. A table that is neither a mapping nor a list is empty, and an entry that is not a list is skipped. */
const TagTableSchema = z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .catch({})
    .transform((table) => {
        const tags: Record<string, string[]> = {};

        for (const [name, list] of Object.entries(table)) {
            if (Array.isArray(list)) {
                tags[name] = list.map(String);
            }
        }

        return tags;
    });

/** tags.yaml: a mapping, or a list (no tables); a scalar document is no config at all. */
const TagsFileSchema = z.union([
    z.object({ skills: TagTableSchema, rules: TagTableSchema }),
    z.array(z.unknown()).transform((): TagsConfig => ({ skills: {}, rules: {} })),
]);

/** The items filterByTags keeps and the ones it leaves out. */
export interface TagFilterResult {
    included: ResourceItem[];
    skipped: ResourceItem[];
}

/**
 * Load the tags config (tags.yaml) from the team repo.
 *
 * Returns null when:
 *   - File is missing (backward compat: pull everything)
 *   - YAML is malformed (warn + pull everything)
 */
export async function loadTagsConfig(repoPath: string): Promise<TagsConfig | null> {
    const content = await readFileSafe(path.join(repoPath, TAGS_FILE));

    if (!content) {
        return null;
    }

    try {
        return TagsFileSchema.safeParse(parseYaml(content)).data ?? null;
    } catch (e) {
        log.warn(`Failed to parse ${TAGS_FILE}: ${e instanceof Error ? e.message : String(e)}`);

        return null;
    }
}

/**
 * Filter resource items by tags.
 *
 * Inclusion rules (any match = include):
 *   1. tagsConfig is null → include all (no tags.yaml)
 *   2. subscribedTags is undefined/empty → include all (user hasn't subscribed)
 *   3. Item not in tagsConfig → include (untagged = universal)
 *   4. Item has at least one tag matching subscribedTags → include
 *   5. Otherwise → exclude
 */
export function filterByTags(
    items: ResourceItem[],
    tagsConfig: TagsConfig | null,
    subscribedTags: string[] | undefined,
    resourceType: 'skills' | 'rules',
): TagFilterResult {
    // No tags.yaml or no subscriptions → include all
    if (!tagsConfig || !subscribedTags || subscribedTags.length === 0) {
        return { included: items, skipped: [] };
    }

    const tagMap = resourceType === 'skills' ? tagsConfig.skills : tagsConfig.rules;
    const subscribedSet = new Set(subscribedTags);
    const included: ResourceItem[] = [];
    const skipped: ResourceItem[] = [];

    for (const item of items) {
        const itemTags = tagMap[item.name];

        // Untagged items are always included
        if (!itemTags || itemTags.length === 0) {
            included.push(item);
            continue;
        }

        // Check if any item tag matches subscribed tags
        const hasMatch = itemTags.some((tag) => subscribedSet.has(tag));

        if (hasMatch) {
            included.push(item);
        } else {
            skipped.push(item);
        }
    }

    return { included, skipped };
}

/**
 * Save tags config to tags.yaml in the team repo.
 */
export async function saveTagsConfig(repoPath: string, config: TagsConfig): Promise<void> {
    const filePath = path.join(repoPath, TAGS_FILE);

    const content = YAML.stringify({
        skills: config.skills,
        rules: config.rules,
    });

    await writeFile(filePath, content);
}

/**
 * Collect all unique tags from a TagsConfig, with counts of resources per tag.
 */
export function collectTagStats(
    tagsConfig: TagsConfig,
): Map<string, { skills: number; rules: number }> {
    const stats = new Map<string, { skills: number; rules: number }>();

    for (const tags of Object.values(tagsConfig.skills)) {
        for (const tag of tags) {
            const entry = stats.get(tag) ?? { skills: 0, rules: 0 };
            entry.skills += 1;
            stats.set(tag, entry);
        }
    }

    for (const tags of Object.values(tagsConfig.rules)) {
        for (const tag of tags) {
            const entry = stats.get(tag) ?? { skills: 0, rules: 0 };
            entry.rules += 1;
            stats.set(tag, entry);
        }
    }

    return stats;
}
