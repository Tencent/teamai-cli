import path from 'node:path';
import { requireInit } from './config.js';
import { writeFile, ensureDir } from './utils/fs.js';
import { autoPushTeamRepo } from './utils/git.js';
import { log } from './utils/logger.js';

export async function contributeFromMcp(opts: {
  title: string;
  content: string;
  tags?: string[];
}): Promise<string> {
  const { localConfig } = await requireInit();
  const repoPath = localConfig.repo.localPath;
  const learningsDir = path.join(repoPath, 'learnings');
  await ensureDir(learningsDir);

  const slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${slug}-${date}.md`;

  const frontmatter = [
    '---',
    `title: "${opts.title}"`,
    `author: ${localConfig.username}`,
    `date: ${date}`,
    opts.tags && opts.tags.length > 0 ? `tags: [${opts.tags.join(', ')}]` : null,
    '---',
  ].filter(Boolean).join('\n');

  const fileContent = `${frontmatter}\n\n${opts.content}\n`;
  const filePath = path.join(learningsDir, filename);
  await writeFile(filePath, fileContent);

  try {
    await autoPushTeamRepo(repoPath, `[teamai] contribute: ${opts.title}`);
    return `Learning "${opts.title}" contributed and pushed to team repo (${filename}).`;
  } catch (e) {
    log.debug(`MCP contribute push failed: ${(e as Error).message}`);
    return `Learning saved locally (${filename}) but push failed: ${(e as Error).message}`;
  }
}
