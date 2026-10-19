import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

import { buildHandlerRegistry } from '../hook-handlers.js';
import type { LocalConfig } from '../types.js';

describe('Cursor gets the user-scope rules from its session-start hook in a workspace outside the home directory (#1197)', () => {
  let tmpDir: string;
  let home: string;
  let userRepo: string;
  let userConfig: LocalConfig;

  const context = async (cwd: string, tool = 'cursor', config: LocalConfig | null = userConfig): Promise<string | null> => {
    const registration = buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'cursor-user-rules');
    const output = await registration!.handler.execute({ hook_event_name: 'SessionStart', cwd }, tool, config);
    if (output === null) return null;
    const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    return parsed.hookSpecificOutput.additionalContext;
  };

  beforeEach(async () => {
    tmpDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-cursor-user-rules-')));
    home = path.join(tmpDir, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    userRepo = path.join(tmpDir, 'user-team-repo');
    await fse.outputFile(path.join(userRepo, 'teamai.yaml'), 'team: test\nrepo: https://example.invalid/x/team.git\n');
    await fse.outputFile(path.join(userRepo, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.outputFile(path.join(userRepo, 'rules', 'scoped.md'), '---\npaths:\n  - "src/**"\n---\nPrefer named exports.\n');
    await fse.outputFile(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${userRepo}\n  remote: https://example.invalid/x/team.git\nusername: u\n`,
    );
    await fse.ensureDir(path.join(home, '.cursor', 'rules'));
    userConfig = {
      repo: { localPath: userRepo, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'user',
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('adds the user rules when the workspace is outside the home directory, a path-scoped rule after its globs', async () => {
    const workspace = path.join(tmpDir, 'work', 'project');
    await fse.ensureDir(workspace);

    const text = await context(workspace);

    expect(text).toContain('The team codeword is PELICAN-42.');
    expect(text).toContain('Applies to files matching: src/**\nPrefer named exports.');
    expect(text).not.toContain('paths:');
  });

  it('adds the user-scope culture and shared instructions, which ~/.cursor/rules also holds', async () => {
    await fse.outputFile(path.join(userRepo, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.outputFile(path.join(userRepo, 'claudemd', 'shared.md'), 'Shared team instructions.\n');

    const text = (await context(path.join(tmpDir, 'work')))!;

    expect(text).toContain('Be kind to teammates.');
    expect(text).toContain('Shared team instructions.');
    expect(text).toContain('PELICAN-42');
    expect(text).not.toContain('<!--');
  });

  it('adds nothing under the home directory, where Cursor loads ~/.cursor/rules itself', async () => {
    const workspace = path.join(home, 'src', 'project');
    await fse.ensureDir(workspace);

    expect(await context(workspace)).toBeNull();
  });

  it('adds nothing when a link on the walk already points at ~/.cursor/rules', async () => {
    const workspace = path.join(tmpDir, 'work', 'project');
    await fse.ensureDir(path.join(tmpDir, 'work', '.cursor'));
    await fse.symlink(path.join(home, '.cursor', 'rules'), path.join(tmpDir, 'work', '.cursor', 'rules'), 'junction');
    await fse.ensureDir(workspace);

    expect(await context(workspace)).toBeNull();
  });

  it('adds the user rules, not the project\'s, in a teamai project outside the home directory', async () => {
    const projectRepo = path.join(tmpDir, 'project-team-repo');
    await fse.outputFile(path.join(projectRepo, 'teamai.yaml'), 'team: proj\nrepo: https://example.invalid/x/proj.git\n');
    await fse.outputFile(path.join(projectRepo, 'rules', 'project.md'), 'The project codeword is HERON-7.\n');
    const projectRoot = path.join(tmpDir, 'work', 'project');
    await fse.ensureDir(projectRoot);
    const projectConfig = {
      repo: { localPath: projectRepo, remote: 'https://example.invalid/x/proj.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
    } as unknown as LocalConfig;

    const text = await context(projectRoot, 'cursor', projectConfig);

    expect(text).toContain('PELICAN-42');
    expect(text).not.toContain('HERON-7');
  });

  it('adds nothing for a tool other than Cursor, or when Cursor is excluded from the user scope', async () => {
    const workspace = path.join(tmpDir, 'work');
    await fse.ensureDir(workspace);

    expect(await context(workspace, 'claude')).toBeNull();
    expect(await context(workspace, 'cursor', { ...userConfig, disabledAgents: ['cursor'] } as LocalConfig)).toBeNull();
  });

  it('adds nothing when the text is over Cursor\'s limit, which would drop the whole hook reply', async () => {
    await fse.outputFile(path.join(userRepo, 'rules', 'long.md'), `${'x'.repeat(10_000)}\n`);
    const workspace = path.join(tmpDir, 'work');
    await fse.ensureDir(workspace);

    expect(await context(workspace)).toBeNull();
  });
});
