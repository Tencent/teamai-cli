import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { DocsHandler } from '../resources/docs.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

describe('DocsHandler nested documents', () => {
  const handler = new DocsHandler();
  let tmpDir: string;
  let docsDir: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-docs-'));
    vi.stubEnv('HOME', tmpDir);
    docsDir = path.join(tmpDir, 'repo', 'docs');
    localConfig = LocalConfigSchema.parse({
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'local/docs-test' },
      username: 'test', scope: 'user',
    });
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'local/docs-test', provider: 'git' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('discovers and syncs documents when all visible files are nested', async () => {
    const visible = ['ai/setup.md', 'ai/reference/api.pdf'];
    const hidden = ['.gitkeep', 'ai/.draft.md', 'ai/.private/note.md'];
    for (const docPath of [...visible, ...hidden]) {
      await fse.outputFile(path.join(docsDir, docPath), `Content: ${docPath}\n`);
    }
    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    expect(items).toHaveLength(1);
    expect(await handler.countDocFiles(docsDir)).toBe(2);

    await handler.pullItem(items[0], teamConfig, localConfig);

    for (const docPath of visible) {
      expect(await fse.readFile(path.join(tmpDir, '.teamai', 'docs', docPath), 'utf8')).toBe(`Content: ${docPath}\n`);
    }
    for (const docPath of hidden) {
      expect(await fse.pathExists(path.join(tmpDir, '.teamai', 'docs', docPath))).toBe(false);
    }
  });

  it('does not offer a docs bundle for missing, empty, or hidden-only trees', async () => {
    expect(await handler.countDocFiles(docsDir)).toBe(0);
    expect(await handler.scanTeamForPull(teamConfig, localConfig)).toEqual([]);

    await fse.ensureDir(path.join(docsDir, 'empty'));
    await fse.outputFile(path.join(docsDir, 'ai', '.gitkeep'), '');
    await fse.outputFile(path.join(docsDir, '.private', 'note.md'), 'Hidden\n');
    expect(await handler.countDocFiles(docsDir)).toBe(0);
    expect(await handler.scanTeamForPull(teamConfig, localConfig)).toEqual([]);
  });
});
