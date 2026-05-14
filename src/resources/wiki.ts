import path from 'node:path';
import { ResourceHandler } from './base.js';
import type { ResourceItem, ResourceItemStatus, TeamaiConfig, LocalConfig } from '../types.js';
import { resolveBaseDir, getTeamaiHome } from '../types.js';
import {
    listFilesRecursive,
    pathExists,
    copyFile,
    remove,
    ensureDir,
    readFileSafe,
    fileContentEqual,
} from '../utils/fs.js';
import { log } from '../utils/logger.js';


/**
 * Wiki resource handler.
 *
 * Wiki pages are now stored in a centralized shared location:
 * - User scope  → ~/.teamai/wiki/
 * - Project scope → <projectRoot>/.teamai/wiki/
 *
 * Individual pages are stored as .md files in category subdirectories
 * (entities/, concepts/, etc.). The handler treats the entire wiki/ tree
 * as flat files keyed by their relative path within wiki/.
 *
 * _metadata.json is NOT synced via push/pull — it is rebuilt locally
 * by the /wiki skill after each pull.
 *
 * BREAKING CHANGE: Wiki is no longer distributed to individual tool
 * directories (e.g., ~/.claude/wiki/, ~/.cursor/wiki/). All tools now
 * reference the single shared wiki at ~/.teamai/wiki/.
 */
export class WikiHandler extends ResourceHandler {
    readonly type = 'wiki' as const;

    /**
     * Files that should not be pushed/pulled as individual resource items.
     * These are either auto-generated or local-only.
     */
    private static readonly EXCLUDED_FILES = new Set([
        '_metadata.json',
        '.removed',
    ]);

    /** Check if a file should be treated as a wiki page. */
    private static isWikiPage(relativePath: string): boolean {
        if (!relativePath.endsWith('.md')) return false;
        const basename = path.basename(relativePath);
        if (WikiHandler.EXCLUDED_FILES.has(basename)) return false;
        return true;
    }

    /**
     * Derive a resource name from a relative path within wiki/.
     * e.g. "entities/message-builder.md" → "entities/message-builder"
     */
    private static pathToName(relativePath: string): string {
        return relativePath.replace(/\.md$/, '');
    }

    /**
     * Get the shared wiki directory for the current scope.
     * - User scope  → ~/.teamai/wiki/
     * - Project scope → <projectRoot>/.teamai/wiki/
     */
    private static getSharedWikiDir(localConfig: LocalConfig): string {
        const teamaiHome = getTeamaiHome(localConfig.scope, localConfig.projectRoot);
        return path.join(teamaiHome, 'wiki');
    }

    /**
     * Scan the shared wiki directory for pages that are new or modified
     * compared to the team repo.
     */
    async scanLocalForPush(
        teamConfig: TeamaiConfig,
        localConfig: LocalConfig,
    ): Promise<ResourceItem[]> {
        const teamWikiDir = path.join(localConfig.repo.localPath, 'wiki');
        const teamPages = new Map<string, string>();

        // Collect all team wiki pages for comparison
        if (await pathExists(teamWikiDir)) {
            const files = await listFilesRecursive(teamWikiDir);
            for (const file of files) {
                if (WikiHandler.isWikiPage(file)) {
                    const name = WikiHandler.pathToName(file);
                    teamPages.set(name, path.join(teamWikiDir, file));
                }
            }
        }

        const sharedWikiDir = WikiHandler.getSharedWikiDir(localConfig);
        if (!await pathExists(sharedWikiDir)) return [];

        const tombstones = await this.readTombstones(localConfig);
        const items: ResourceItem[] = [];

        const files = await listFilesRecursive(sharedWikiDir);
        for (const file of files) {
            if (!WikiHandler.isWikiPage(file)) continue;

            const name = WikiHandler.pathToName(file);
            if (tombstones.has(name)) continue;

            const localFilePath = path.join(sharedWikiDir, file);

            if (teamPages.has(name)) {
                const teamFilePath = teamPages.get(name)!;
                const equal = await fileContentEqual(localFilePath, teamFilePath);
                if (equal) continue;

                items.push({
                    name,
                    type: 'wiki',
                    sourcePath: localFilePath,
                    relativePath: `wiki/${name}.md`,
                    status: 'modified',
                });
            } else {
                items.push({
                    name,
                    type: 'wiki',
                    sourcePath: localFilePath,
                    relativePath: `wiki/${name}.md`,
                    status: 'new',
                });
            }
        }

        return items;
    }

    /**
     * Scan team repo for wiki pages to pull.
     */
    async scanTeamForPull(
        _teamConfig: TeamaiConfig,
        localConfig: LocalConfig,
    ): Promise<ResourceItem[]> {
        const wikiDir = path.join(localConfig.repo.localPath, 'wiki');
        if (!await pathExists(wikiDir)) return [];

        const files = await listFilesRecursive(wikiDir);
        return files
            .filter((f) => WikiHandler.isWikiPage(f))
            .map((f) => ({
                name: WikiHandler.pathToName(f),
                type: 'wiki' as const,
                sourcePath: path.join(wikiDir, f),
                relativePath: `wiki/${f}`,
            }));
    }

    /**
     * Copy a local wiki page to the team repo.
     */
    async pushItem(
        item: ResourceItem,
        _teamConfig: TeamaiConfig,
        localConfig: LocalConfig,
    ): Promise<void> {
        const dest = path.join(localConfig.repo.localPath, `wiki/${item.name}.md`);
        await ensureDir(path.dirname(dest));
        await copyFile(item.sourcePath, dest);
        log.debug(`Copied wiki page ${item.name} → team repo`);
    }

    /**
     * Pull a wiki page from team repo to the shared wiki directory.
     */
    async pullItem(
        item: ResourceItem,
        _teamConfig: TeamaiConfig,
        localConfig: LocalConfig,
    ): Promise<void> {
        const sharedWikiDir = WikiHandler.getSharedWikiDir(localConfig);
        const dest = path.join(sharedWikiDir, `${item.name}.md`);
        await ensureDir(path.dirname(dest));
        try {
            await copyFile(item.sourcePath, dest);
            log.debug(`Synced wiki page ${item.name} → shared wiki`);
        } catch (e) {
            log.warn(
                `Failed to sync wiki page ${item.name}: ${(e as Error).message}`,
            );
        }
    }

    /**
     * Remove a wiki page from the team repo and the shared wiki directory.
     */
    async removeItem(
        name: string,
        _teamConfig: TeamaiConfig,
        localConfig: LocalConfig,
    ): Promise<string[]> {
        const removed: string[] = [];

        // Remove from team repo
        const teamFile = path.join(localConfig.repo.localPath, 'wiki', `${name}.md`);
        if (await pathExists(teamFile)) {
            await remove(teamFile);
            removed.push(teamFile);
        }

        await this.addTombstone(name, localConfig);

        // Remove from shared wiki directory
        const sharedWikiDir = WikiHandler.getSharedWikiDir(localConfig);
        const sharedFile = path.join(sharedWikiDir, `${name}.md`);
        if (await pathExists(sharedFile)) {
            await remove(sharedFile);
            removed.push(sharedFile);
            log.debug(`Removed wiki page ${name} from shared wiki`);
        }

        return removed;
    }

    /**
     * Rebuild _metadata.json from wiki pages in the shared wiki directory.
     * Called after pull to reconstruct local metadata.
     */
    static async rebuildMetadata(localConfig: LocalConfig): Promise<void> {
        const wikiDir = WikiHandler.getSharedWikiDir(localConfig);
        if (!await pathExists(wikiDir)) return;

        const files = await listFilesRecursive(wikiDir);
        const pages: Record<string, unknown> = {};
        let totalLinks = 0;

        for (const file of files) {
            if (!WikiHandler.isWikiPage(file)) continue;

            const content = await readFileSafe(path.join(wikiDir, file));
            if (!content) continue;

            const name = WikiHandler.pathToName(file);
            const outLinks = extractWikiLinks(content);
            totalLinks += outLinks.length;

            // Extract frontmatter fields
            const fm = parseFrontmatter(content);

            pages[file] = {
                title: fm.title ?? name,
                category: fm.category ?? path.dirname(file),
                tags: fm.tags ?? [],
                outLinks,
                inLinks: [],
                updatedAt: fm.updated ?? new Date().toISOString(),
            };
        }

        // Compute inLinks from outLinks
        for (const [pagePath, meta] of Object.entries(pages)) {
            const pageMeta = meta as { outLinks: string[]; inLinks: string[] };
            for (const link of pageMeta.outLinks) {
                // Find the page that matches this link name
                for (const [otherPath, otherMeta] of Object.entries(pages)) {
                    if (otherPath === pagePath) continue;
                    const otherName = WikiHandler.pathToName(otherPath);
                    const basename = path.basename(otherName);
                    if (basename === link || otherName === link) {
                        (otherMeta as { inLinks: string[] }).inLinks.push(
                            path.basename(WikiHandler.pathToName(pagePath)),
                        );
                    }
                }
            }
        }

        const metadata = {
            version: 1,
            wikiDir,
            updatedAt: new Date().toISOString(),
            sources: {},
            pages,
            stats: {
                totalPages: Object.keys(pages).length,
                totalSources: 0,
                totalLinks,
                lastIngest: null,
                lastLint: null,
            },
        };

        const metadataPath = path.join(wikiDir, '_metadata.json');
        const { writeJson } = await import('../utils/fs.js');
        await writeJson(metadataPath, metadata);
        log.debug(`Rebuilt wiki metadata: ${Object.keys(pages).length} pages, ${totalLinks} links`);
    }
}


/**
 * Extract [[wiki link]] targets from markdown content.
 */
function extractWikiLinks(content: string): string[] {
    const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        links.push(match[1].trim());
    }
    return [...new Set(links)];
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns an object with extracted fields, or empty object if no frontmatter.
 */
function parseFrontmatter(
    content: string,
): { title?: string; category?: string; tags?: string[]; updated?: string } {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fmText = fmMatch[1];
    const result: { title?: string; category?: string; tags?: string[]; updated?: string } = {};

    const titleMatch = fmText.match(/^title:\s*(.+)$/m);
    if (titleMatch) {
        result.title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    const categoryMatch = fmText.match(/^category:\s*(.+)$/m);
    if (categoryMatch) {
        result.category = categoryMatch[1].trim();
    }

    const tagsMatch = fmText.match(/^tags:\s*\[([^\]]*)\]$/m);
    if (tagsMatch) {
        result.tags = tagsMatch[1].split(',').map((t) => t.trim()).filter(Boolean);
    }

    const updatedMatch = fmText.match(/^updated:\s*(.+)$/m);
    if (updatedMatch) {
        result.updated = updatedMatch[1].trim();
    }

    return result;
}
