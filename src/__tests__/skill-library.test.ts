import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { SkillsHandler, listDeployedSkillNames } from '../resources/skills.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

const SKILL_MD = '---\nname: team-skill\ndescription: Team skill\n---\n# Team skill\n';

describe.skipIf(process.platform === 'win32')('SkillsHandler.pullItem with skillLibrary', () => {
  let tmpDir: string;
  let homeDir: string;
  let sourcePath: string;
  let libraryPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const pull = () => new SkillsHandler().pullItem(
    { name: 'team-skill', type: 'skills', sourcePath, relativePath: 'skills/team-skill' },
    teamConfig,
    localConfig,
  );
  const toolDir = (tool: string) => path.join(homeDir, `.${tool}`, 'skills', 'team-skill');

  beforeEach(async () => {
    vi.mocked(log.warn).mockClear();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-library-'));
    homeDir = path.join(tmpDir, 'home');
    vi.stubEnv('HOME', homeDir);
    sourcePath = path.join(tmpDir, 'team-repo', 'skills', 'team-skill');
    libraryPath = path.join(homeDir, '.agents', 'skills', 'team-skill');
    await fse.outputFile(path.join(sourcePath, 'SKILL.md'), SKILL_MD);
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.ensureDir(path.join(homeDir, '.codex'));

    teamConfig = {
      team: 'test', description: '', repo: 'https://example.test/team.git', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    } as TeamaiConfig;
    localConfig = {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'https://example.test/team.git' },
      username: 'testuser', updatePolicy: 'auto', additionalRoles: [], scope: 'user', skillLibrary: true,
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('installs the skill once into the library and links other tools to it', async () => {
    await pull();

    expect(await fse.readFile(path.join(libraryPath, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect((await fse.lstat(toolDir('claude'))).isSymbolicLink()).toBe(true);
    expect(await fse.realpath(toolDir('claude'))).toBe(await fse.realpath(libraryPath));
    // Codex reads .agents/skills itself: a copy or link would list it twice.
    expect(await fse.pathExists(toolDir('codex'))).toBe(false);
  });

  it('updates through the link on the next pull instead of replacing it', async () => {
    await pull();
    await fse.outputFile(path.join(sourcePath, 'SKILL.md'), `${SKILL_MD}Updated\n`);
    await pull();

    expect((await fse.lstat(toolDir('claude'))).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(toolDir('claude'), 'SKILL.md'), 'utf8')).toContain('Updated');
    expect(await fse.readdir(path.dirname(libraryPath))).toEqual(['team-skill']);
  });

  it('turns an earlier per-tool TeamAI copy into a link, even when the team skill changed', async () => {
    // What a pull before the switch left: the same copy in every tool.
    await fse.outputFile(path.join(toolDir('claude'), 'SKILL.md'), SKILL_MD);
    await fse.outputFile(path.join(toolDir('codex'), 'SKILL.md'), SKILL_MD);
    await fse.outputFile(path.join(libraryPath, 'SKILL.md'), SKILL_MD);
    await fse.outputFile(path.join(sourcePath, 'SKILL.md'), `${SKILL_MD}Updated\n`);

    await pull();

    expect((await fse.lstat(toolDir('claude'))).isSymbolicLink()).toBe(true);
    expect(await fse.pathExists(toolDir('codex'))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps a tool copy with local edits and warns', async () => {
    await fse.outputFile(path.join(toolDir('claude'), 'SKILL.md'), `${SKILL_MD}My edit\n`);

    await pull();

    expect((await fse.lstat(toolDir('claude'))).isDirectory()).toBe(true);
    expect(await fse.readFile(path.join(toolDir('claude'), 'SKILL.md'), 'utf8')).toContain('My edit');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('may hold your changes'));
  });

  it('keeps a link that points somewhere else', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fse.outputFile(path.join(elsewhere, 'SKILL.md'), 'mine');
    await fse.ensureDir(path.dirname(toolDir('claude')));
    await fse.symlink(elsewhere, toolDir('claude'));

    await pull();

    expect(await fse.readlink(toolDir('claude'))).toBe(elsewhere);
    expect(await fse.readFile(path.join(elsewhere, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not the skill library'));
  });

  it('does not write through a symlinked library entry', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    await fse.outputFile(path.join(elsewhere, 'SKILL.md'), 'mine');
    await fse.ensureDir(path.dirname(libraryPath));
    await fse.symlink(elsewhere, libraryPath);

    await pull();

    expect(await fse.readFile(path.join(elsewhere, 'SKILL.md'), 'utf8')).toBe('mine');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('does not write through one'));
  });

  it('replaces a dangling link into the library', async () => {
    await fse.ensureDir(path.dirname(toolDir('claude')));
    await fse.symlink(libraryPath, toolDir('claude'));

    await pull();

    expect(await fse.readFile(path.join(toolDir('claude'), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });

  it('lists links into the library as deployed skills', async () => {
    await pull();
    const skillsDir = path.dirname(toolDir('claude'));

    expect(await listDeployedSkillNames(skillsDir, localConfig)).toEqual(['team-skill']);
    expect(await listDeployedSkillNames(skillsDir, { ...localConfig, skillLibrary: undefined })).toEqual([]);
  });

  it('keeps copying into each tool when skillLibrary is off', async () => {
    localConfig = { ...localConfig, skillLibrary: undefined };

    await pull();

    expect((await fse.lstat(toolDir('claude'))).isDirectory()).toBe(true);
    expect((await fse.lstat(toolDir('codex'))).isDirectory()).toBe(true);
    expect(await fse.pathExists(libraryPath)).toBe(false);
  });
});
