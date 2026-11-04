/**
 * The shared-instruction SOURCE directory: `claudemd/` or `agentsmd/` (#1682).
 *
 * The directory is the repo's convention, not the resource's identity: the
 * collection rules (knowledge-namespace layout, per-tool delivery, file
 * format) are the same under either name, and a repo that keeps both
 * delivers one copy of each file rather than two.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { collectClaudemdFiles, type RolePullContext } from '../resources/desired.js';
import {
  existingSharedInstructionDirs,
  shadowedSharedInstructionFiles,
} from '../shared-instruction-source.js';
import type { LocalConfig } from '../types.js';

let repoPath: string;

beforeEach(async () => {
  repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'shared-instruction-'));
});

afterEach(async () => {
  await fse.remove(repoPath);
});

async function teamFile(relative: string, content: string): Promise<void> {
  const target = path.join(repoPath, relative);
  await fse.ensureDir(path.dirname(target));
  await fse.writeFile(target, content);
}

/** A local config pointed at the temp repo; no roles manifest, so the legacy path. */
function config(): LocalConfig {
  return {
    repo: { localPath: repoPath },
    username: 'member',
    scope: 'project',
  } as unknown as LocalConfig;
}

describe('shared-instruction source directory', () => {
  it('reads `claudemd/` as before', async () => {
    await teamFile('claudemd/common.md', 'ROOT NOTES\n');
    await teamFile('claudemd/backend/conventions.md', 'BACKEND NOTES\n');

    const { contents } = await collectClaudemdFiles(config(), null);

    expect(contents.join('\n')).toContain('ROOT NOTES');
    expect(contents.join('\n')).toContain('BACKEND NOTES');
  });

  it('reads `agentsmd/` with the same rules', async () => {
    await teamFile('agentsmd/common.md', 'AGENTS ROOT NOTES\n');
    await teamFile('agentsmd/backend/conventions.md', 'AGENTS BACKEND NOTES\n');

    const { contents } = await collectClaudemdFiles(config(), null);

    expect(contents.join('\n')).toContain('AGENTS ROOT NOTES');
    expect(contents.join('\n')).toContain('AGENTS BACKEND NOTES');
  });

  it('delivers one copy of a same-named file when both directories exist', async () => {
    await teamFile('claudemd/common.md', 'FROM CLAUDEMD\n');
    await teamFile('agentsmd/common.md', 'FROM AGENTSMD\n');

    const { contents } = await collectClaudemdFiles(config(), null);
    const text = contents.join('\n');

    expect(text).toContain('FROM AGENTSMD');
    expect(text).not.toContain('FROM CLAUDEMD');
  });

  it('keeps files whose names differ across the two directories', async () => {
    await teamFile('claudemd/legacy.md', 'ONLY CLAUDEMD\n');
    await teamFile('agentsmd/modern.md', 'ONLY AGENTSMD\n');

    const { contents } = await collectClaudemdFiles(config(), null);
    const text = contents.join('\n');

    expect(text).toContain('ONLY CLAUDEMD');
    expect(text).toContain('ONLY AGENTSMD');
  });

  it('collects only the namespaces the member receives', async () => {
    await teamFile('claudemd/backend/note.md', 'BACKEND NOTE\n');
    await teamFile('agentsmd/backend/note.md', 'AGENTS BACKEND NOTE\n');
    await teamFile('agentsmd/frontend/note.md', 'AGENTS FRONTEND NOTE\n');

    // The member's role carries `frontend`, not `backend`.
    const roleContext = {
      activeNamespaces: { knowledge: ['frontend'] },
    } as unknown as RolePullContext;

    const { contents, paths } = await collectClaudemdFiles(config(), roleContext);
    const text = contents.join('\n');

    expect(text).toContain('AGENTS FRONTEND NOTE');
    expect(text).not.toContain('AGENTS BACKEND NOTE');
    expect(text).not.toContain('BACKEND NOTE');
    // The path of the file the block carries, so a caller can tell which
    // copy a conflict is about.
    expect(paths).toEqual(['agentsmd/frontend/note.md']);
  });

  it('lists the directories a repo actually has, preferred first', async () => {
    expect(await existingSharedInstructionDirs(repoPath)).toEqual([]);

    await teamFile('claudemd/a.md', 'A\n');
    expect(await existingSharedInstructionDirs(repoPath)).toEqual(['claudemd']);

    await teamFile('agentsmd/b.md', 'B\n');
    expect(await existingSharedInstructionDirs(repoPath)).toEqual(['agentsmd', 'claudemd']);
  });

  it('raises the failure of a source directory that is not a directory', async () => {
    await teamFile('claudemd', 'not a directory\n');

    // The caller (pull) reports this as a skipped sync, as it did before.
    await expect(existingSharedInstructionDirs(repoPath)).rejects.toThrow(/ENOTDIR/);
  });

  it('names the copy pull delivers and the copies it leaves out', async () => {
    await teamFile('claudemd/common.md', 'FROM CLAUDEMD\n');
    await teamFile('agentsmd/common.md', 'FROM AGENTSMD\n');

    const shadowed = await shadowedSharedInstructionFiles(repoPath);

    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].path).toBe('common.md');
    expect(shadowed[0].deliveredPath).toBe('agentsmd/common.md');
    expect(shadowed[0].deliveredFrom).toBe('agentsmd');
    expect(shadowed[0].shadowedIn).toEqual(['claudemd']);
  });

  it('sees a conflict under a knowledge namespace too', async () => {
    await teamFile('claudemd/backend/conventions.md', 'FROM CLAUDEMD\n');
    await teamFile('agentsmd/backend/conventions.md', 'FROM AGENTSMD\n');

    const shadowed = await shadowedSharedInstructionFiles(repoPath);

    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].path).toBe('backend/conventions.md');
    expect(shadowed[0].deliveredPath).toBe('agentsmd/backend/conventions.md');
    expect(shadowed[0].deliveredFrom).toBe('agentsmd');
    expect(shadowed[0].shadowedIn).toEqual(['claudemd']);
  });

  it('keeps a root file and a namespace file of one name apart', async () => {
    await teamFile('claudemd/common.md', 'ROOT\n');
    await teamFile('agentsmd/backend/common.md', 'BACKEND\n');

    // Different relative paths, so different files — no conflict.
    expect(await shadowedSharedInstructionFiles(repoPath)).toEqual([]);
  });

  it('reports no shadowed name when the directories hold different files', async () => {
    await teamFile('claudemd/legacy.md', 'A\n');
    await teamFile('agentsmd/modern.md', 'B\n');

    expect(await shadowedSharedInstructionFiles(repoPath)).toEqual([]);
  });
});
