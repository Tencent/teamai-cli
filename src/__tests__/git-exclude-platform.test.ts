import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { type GitExcludeFileRecord, type GitExcludeOwner, sync } from '../git-exclude.js';

// The cases Linux skips. Git honours `core.precomposeunicode` only on macOS,
// and the on-disk spelling only shows up on a case-insensitive volume. The
// rest of the block is `git-exclude.test.ts`, which CI runs on Linux.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
const status = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall');

/** An owner whose recorded exclude files live in memory, as a caller's state would keep them. */
function memoryOwner(name: string, files: string[] = []): GitExcludeOwner & { files: string[] } {
  const owner = { name, files, record: undefined as unknown as GitExcludeFileRecord };
  owner.record = {
    files: async () => [...owner.files],
    update: async ({ add, drop }) => {
      owner.files = [...new Set([...owner.files, ...add])].filter((f) => !drop.includes(f));
    },
  };
  return owner;
}

/** Whether names differing only in case are one file in `dir`. */
async function caseInsensitive(dir: string): Promise<boolean> {
  const probe = path.join(dir, 'CaseProbe');
  await fse.writeFile(probe, '');
  const result = await fse.pathExists(path.join(dir, 'caseprobe'));
  await fse.remove(probe);
  return result;
}

describe('git exclude names the machine stores (#915)', () => {
  let tmp: string;
  let repo: string;
  let excludeFile: string;
  const read = (): Promise<string> => fse.readFile(excludeFile, 'utf8');
  const inRepo = (...parts: string[]): string => path.join(repo, ...parts);

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-git-exclude-')));
    repo = path.join(tmp, 'repo');
    await fse.ensureDir(repo);
    git(repo, 'init', '-q');
    excludeFile = inRepo('.git', 'info', 'exclude');
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  it.runIf(process.platform === 'darwin').each([
    ['true', 'NFC', 'caf\u00e9'],
    ['false', 'the on-disk bytes', 'cafe\u0301'],
  ])('with core.precomposeunicode %s, writes %s for a name stored decomposed', async (precompose, _label, expected) => {
    git(repo, 'config', 'core.precomposeunicode', precompose);
    const skill = inRepo('.claude', 'skills', 'cafe\u0301');
    await fse.outputFile(path.join(skill, 'SKILL.md'), 'x\n');

    await sync(memoryOwner('delivered'), [path.join(skill, 'SKILL.md')]);

    expect(await read()).toContain(`/.claude/skills/${expected}/SKILL.md\n`);
    expect(status(repo)).toBe('');
  });

  it('spells the line as the name is on disk, on a case-insensitive filesystem', async (ctx) => {
    if (!await caseInsensitive(tmp)) ctx.skip();
    await fse.outputFile(inRepo('.claude', 'skills', 'Deploy', 'SKILL.md'), 'x\n');
    await fse.outputFile(inRepo('.claude', 'rules', 'Team.md'), 'x\n');

    await sync(memoryOwner('delivered'), [
      inRepo('.CLAUDE', 'Skills', 'deploy', 'skill.md'),
      inRepo('.claude', 'skills', 'Deploy', 'SKILL.md'),
      inRepo('.claude', 'rules', 'team.md'),
    ]);

    expect(await read()).toContain('# [teamai:delivered:start]\n/.claude/rules/Team.md\n/.claude/skills/Deploy/SKILL.md\n# [teamai:delivered:end]\n');
    expect(status(repo)).toBe('');
  });
});
