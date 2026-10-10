import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MCP_EXCLUDE_END,
  MCP_EXCLUDE_START,
  type GitExcludeFileRecord,
  type GitExcludeOwner,
  encodeOwnerSegment,
  ensure,
  gitUntracked,
  remove,
  report,
  stateHomeRecord,
  sync,
} from '../git-exclude.js';
import { acquireLock, releaseLock } from '../update.js';

// The module's public interface against real temporary repositories (spec § Testing Decisions).

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
const status = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall');
const commit = (cwd: string, ...files: string[]): void => {
  git(cwd, 'add', '--', ...files);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'team');
};
const ignored = (cwd: string, rel: string): boolean => {
  try {
    git(cwd, 'check-ignore', '-q', '--', rel);
    return true;
  } catch {
    return false;
  }
};

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

describe('git exclude blocks (#915)', () => {
  let tmp: string;
  let repo: string;
  let excludeFile: string;
  const read = (file = excludeFile): Promise<string> => fse.readFile(file, 'utf8');
  const inRepo = (...parts: string[]): string => path.join(repo, ...parts);
  const newRepo = async (name: string): Promise<string> => {
    const dir = path.join(tmp, name);
    await fse.ensureDir(dir);
    git(dir, 'init', '-q');
    return dir;
  };

  beforeEach(async () => {
    tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-git-exclude-')));
    repo = await newRepo('repo');
    excludeFile = inRepo('.git', 'info', 'exclude');
  });

  afterEach(async () => {
    await fse.remove(tmp);
  });

  describe('sync', () => {
    it('lists each delivered file under the owner\'s markers, a skill\'s files one by one, leaving the member\'s files visible', async () => {
      await fse.outputFile(inRepo('.claude', 'rules', 'team.md'), 'rule\n');
      await fse.outputFile(inRepo('.claude', 'skills', 'deploy', 'SKILL.md'), 'skill\n');
      await fse.outputFile(inRepo('.claude', 'skills', 'deploy', 'refs', 'guide.md'), 'guide\n');
      await fse.outputFile(inRepo('.claude', 'skills', 'deploy', 'mine.md'), 'mine\n');
      await fse.outputFile(inRepo('.claude', 'rules', 'mine.md'), 'mine\n');

      await sync(memoryOwner('local-agent'), [
        inRepo('.claude', 'rules', 'team.md'), inRepo('.claude', 'skills', 'deploy', 'SKILL.md'), inRepo('.claude', 'skills', 'deploy', 'refs', 'guide.md'),
      ]);

      expect(await read()).toContain('# [teamai:local-agent:start]\n/.claude/rules/team.md\n/.claude/skills/deploy/SKILL.md\n'
        + '/.claude/skills/deploy/refs/guide.md\n# [teamai:local-agent:end]\n');
      expect(status(repo)).toBe('?? .claude/rules/mine.md\n?? .claude/skills/deploy/mine.md\n');
      expect(await read()).not.toMatch(/\/\*?$/m);
    });

    it('lists no directory: a path that is one is refused, naming it, and git still sees what it holds', async () => {
      await fse.outputFile(inRepo('.claude', 'skills', 'deploy', 'SKILL.md'), 'skill\n');
      await fse.outputFile(inRepo('a.md'), 'a\n');

      const result = await sync(memoryOwner('delivered'), [inRepo('.claude', 'skills', 'deploy'), inRepo('a.md')]);

      expect(result.refused).toEqual([{
        path: inRepo('.claude', 'skills', 'deploy'), problem: 'directory', message: expect.stringContaining(JSON.stringify(inRepo('.claude', 'skills', 'deploy'))),
      }]);
      expect(await read()).toContain('# [teamai:delivered:start]\n/a.md\n# [teamai:delivered:end]\n');
      expect(status(repo)).toBe('?? .claude/skills/deploy/SKILL.md\n');
    });

    it('replaces the block: a path no longer given loses its line and shows again', async () => {
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.outputFile(inRepo('b.md'), 'b\n');
      const owner = memoryOwner('local-agent');
      await sync(owner, [inRepo('a.md')]);

      const result = await sync(owner, [inRepo('b.md')]);

      expect(result.files).toMatchObject([{ excludeFile, write: { kind: 'written' }, added: ['/b.md'], dropped: ['/a.md'] }]);
      expect(status(repo)).toBe('?? a.md\n');
    });

    it('empties the owner\'s block in a recorded exclude file that receives no path, and forgets the file', async () => {
      const other = await newRepo('other');
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.outputFile(path.join(other, 'b.md'), 'b\n');
      const owner = memoryOwner('local-agent');
      await sync(owner, [inRepo('a.md'), path.join(other, 'b.md')]);
      expect(owner.files.sort()).toEqual([excludeFile, path.join(other, '.git', 'info', 'exclude')].sort());

      await sync(owner, [inRepo('a.md')]);

      expect(await read(path.join(other, '.git', 'info', 'exclude'))).not.toContain('teamai');
      expect(status(other)).toBe('?? b.md\n');
      expect(owner.files).toEqual([excludeFile]);
    });

    it('drops no line while git cannot place a path, says so, and replaces normally once it can', async () => {
      const other = await newRepo('other');
      const otherExclude = path.join(other, '.git', 'info', 'exclude');
      for (const file of [inRepo('a.md'), inRepo('b.md'), path.join(other, 'c.md')]) await fse.outputFile(file, 'x\n');
      const owner = memoryOwner('local-agent');
      await sync(owner, [inRepo('a.md'), path.join(other, 'c.md')]);
      const otherBefore = await read(otherExclude);
      const head = await read(path.join(other, '.git', 'HEAD'));
      await fse.writeFile(path.join(other, '.git', 'HEAD'), 'not a ref\n');

      const result = await sync(owner, [inRepo('b.md'), path.join(other, 'c.md')]);

      expect(result.gitFailed).toMatchObject([{ path: path.join(other, 'c.md') }]);
      expect(await read(otherExclude)).toBe(otherBefore);
      expect(owner.files.sort()).toEqual([excludeFile, otherExclude].sort());
      // Which file the unplaced path belongs to is unknown, so no block loses a line in this run; new paths are still listed.
      expect(ignored(repo, 'a.md')).toBe(true);
      expect(ignored(repo, 'b.md')).toBe(true);

      await fse.writeFile(path.join(other, '.git', 'HEAD'), head);
      const after = await sync(owner, [inRepo('b.md')]);

      expect(after.gitFailed).toEqual([]);
      expect(status(repo)).toBe('?? a.md\n');
      expect(status(other)).toBe('?? c.md\n');
      expect(owner.files).toEqual([excludeFile]);
    });

    it('lists a path git already ignores, so a later .gitignore change cannot expose it', async () => {
      await fse.outputFile(inRepo('.gitignore'), '*.md\n');
      await fse.outputFile(inRepo('a.md'), 'a\n');

      await sync(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(await read()).toMatch(/^\/a\.md$/m);
    });

    describe('routing', () => {
      it('lists a path inside a nested clone in that clone\'s exclude file, from its toplevel', async () => {
        const nested = inRepo('.claude');
        await fse.ensureDir(nested);
        git(nested, 'init', '-q');
        await fse.outputFile(path.join(nested, 'skills', 'x', 'SKILL.md'), 'x\n');

        await sync(memoryOwner('delivered'), [path.join(nested, 'skills', 'x', 'SKILL.md')]);

        expect(await read(path.join(nested, '.git', 'info', 'exclude'))).toMatch(/^\/skills\/x\/SKILL\.md$/m);
        expect(status(nested)).toBe('');
        expect(await fse.pathExists(excludeFile) ? await read() : '').not.toContain('teamai');
      });

      it('lists a path inside a submodule in the submodule\'s exclude file, so the superproject stops showing it modified', async () => {
        const origin = await newRepo('tool-config');
        await fse.outputFile(path.join(origin, 'README.md'), 'tool\n');
        commit(origin, 'README.md');
        git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, '.claude');
        commit(repo, '.gitmodules', '.claude');
        await fse.outputFile(inRepo('.claude', 'skills', 'x', 'SKILL.md'), 'x\n');
        expect(status(repo)).toBe(' M .claude\n');

        await sync(memoryOwner('delivered'), [inRepo('.claude', 'skills', 'x', 'SKILL.md')]);

        expect(await read(inRepo('.git', 'modules', '.claude', 'info', 'exclude'))).toMatch(/^\/skills\/x\/SKILL\.md$/m);
        expect(status(repo)).toBe('');
      });

      it('lists a path under a symlinked directory in the repository the link leads into', async () => {
        const other = await newRepo('other');
        await fse.outputFile(path.join(other, 'cfg', 'rule.md'), 'r\n');
        await fse.symlink(path.join(other, 'cfg'), inRepo('.tool'), 'dir');

        await sync(memoryOwner('delivered'), [inRepo('.tool', 'rule.md')]);

        expect(await read(path.join(other, '.git', 'info', 'exclude'))).toMatch(/^\/cfg\/rule\.md$/m);
        expect(status(other)).toBe('');
      });

      it('lists a path of a --separate-git-dir repository in the exclude file of its git directory', async () => {
        const work = path.join(tmp, 'work');
        const gitDir = path.join(tmp, 'work.git');
        await fse.ensureDir(work);
        git(work, 'init', '-q', '--separate-git-dir', gitDir);
        await fse.outputFile(path.join(work, 'a.md'), 'a\n');

        await sync(memoryOwner('delivered'), [path.join(work, 'a.md')]);

        expect(await read(path.join(gitDir, 'info', 'exclude'))).toMatch(/^\/a\.md$/m);
        expect(status(work)).toBe('');
      });

      it('reports a path outside any repository and lists nothing for it', async () => {
        const outside = path.join(tmp, 'plain', 'a.md');
        await fse.outputFile(outside, 'a\n');

        const result = await sync(memoryOwner('delivered'), [outside]);

        expect(result.outsideRepo).toEqual([outside]);
        expect(result.files).toEqual([]);
      });

      it('runs git where the path is, not where an exported GIT_DIR points', async () => {
        const other = await newRepo('other');
        await fse.outputFile(inRepo('a.md'), 'a\n');
        const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
        process.env.GIT_DIR = path.join(other, '.git');
        process.env.GIT_WORK_TREE = other;
        try {
          await sync(memoryOwner('delivered'), [inRepo('a.md')]);
        } finally {
          for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }

        expect(await read()).toMatch(/^\/a\.md$/m);
        expect(await fse.pathExists(path.join(other, '.git', 'info', 'exclude')) ? await read(path.join(other, '.git', 'info', 'exclude')) : '').not.toContain('teamai');
      });
    });

    describe('line rules', () => {
      it('escapes glob characters, so each line hides its path and nothing else', async () => {
        const names = ['!bang.md', 'ha#sh.md', 'st*ar.md', 'q?m.md', 'br[ack]et.md', 'back\\slash.md'];
        for (const name of [...names, 'stXar.md', 'qXm.md', 'brcet.md']) await fse.outputFile(inRepo(name), 'x\n');

        const result = await sync(memoryOwner('delivered'), names.map((name) => inRepo(name)));

        expect(result.refused).toEqual([]);
        expect(await read()).toContain('/\\!bang.md\n/back\\\\slash.md\n/br\\[ack\\]et.md\n/ha\\#sh.md\n/q\\?m.md\n/st\\*ar.md\n');
        expect(status(repo).split('\n').filter(Boolean).sort()).toEqual(['?? brcet.md', '?? qXm.md', '?? stXar.md']);
      });

      it('refuses a path with a line break or ending in a space, naming it, and lists the rest', async () => {
        await fse.outputFile(inRepo('ok.md'), 'x\n');
        await fse.outputFile(inRepo('new\nline.md'), 'x\n');
        await fse.outputFile(inRepo('trailing.md '), 'x\n');

        const result = await sync(memoryOwner('delivered'), [inRepo('ok.md'), inRepo('new\nline.md'), inRepo('trailing.md ')]);

        expect(result.refused).toEqual([
          { path: inRepo('new\nline.md'), problem: 'newline', message: expect.stringContaining(JSON.stringify(inRepo('new\nline.md'))) },
          { path: inRepo('trailing.md '), problem: 'trailingSpace', message: expect.stringContaining(JSON.stringify(inRepo('trailing.md '))) },
        ]);
        expect(await read()).toContain('# [teamai:delivered:start]\n/ok.md\n# [teamai:delivered:end]\n');
      });

      it('writes the line from where the write lands and its real path, not the path given through a symlink', async () => {
        await fse.outputFile(inRepo('config', 'rule.md'), 'r\n');
        await fse.symlink('config', inRepo('.cursor'), 'dir');
        commit(repo, '.cursor', 'config/rule.md');
        await fse.outputFile(inRepo('config', 'new.md'), 'n\n');

        await sync(memoryOwner('delivered'), [inRepo('.cursor', 'new.md')]);

        expect(await read()).toMatch(/^\/config\/new\.md$/m);
        expect(status(repo)).toBe('');
      });

      it.runIf(process.platform === 'darwin').each([
        ['true', 'NFC', 'café'],
        ['false', 'the on-disk bytes', 'café'],
      ])('with core.precomposeunicode %s, writes %s for a name stored decomposed', async (precompose, _label, expected) => {
        git(repo, 'config', 'core.precomposeunicode', precompose);
        const skill = inRepo('.claude', 'skills', 'café');
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

    describe('tracked paths', () => {
      it('lists no line for a file git tracks, and reports it for its checkout', async () => {
        await fse.outputFile(inRepo('team.md'), 't\n');
        commit(repo, 'team.md');

        const result = await sync(memoryOwner('delivered'), [inRepo('team.md')]);

        expect(result.files[0].tracked).toEqual([{ path: inRepo('team.md'), checkout: repo }]);
        expect(await fse.pathExists(excludeFile) ? await read() : '').not.toContain('/team.md');
      });

      it('in a skill, reports the tracked file and lists the others: its changes stay visible, a new delivered file does not', async () => {
        const skill = inRepo('.claude', 'skills', 'x');
        await fse.outputFile(path.join(skill, 'SKILL.md'), 'v1\n');
        commit(repo, '.claude/skills/x/SKILL.md');
        await fse.outputFile(path.join(skill, 'SKILL.md'), 'v2\n');
        await fse.outputFile(path.join(skill, 'new.md'), 'n\n');

        const result = await sync(memoryOwner('delivered'), [path.join(skill, 'SKILL.md'), path.join(skill, 'new.md')]);

        expect(result.files[0].tracked).toEqual([{ path: path.join(skill, 'SKILL.md'), checkout: repo }]);
        expect(result.files[0].lines).toEqual(['/.claude/skills/x/new.md']);
        expect(status(repo)).toBe(' M .claude/skills/x/SKILL.md\n');
      });

      it('lists a file tracked in one worktree and untracked in another, reporting it for the tracking worktree', async () => {
        await fse.outputFile(inRepo('README.md'), 'r\n');
        commit(repo, 'README.md');
        const worktree = path.join(tmp, 'wt');
        git(repo, 'worktree', 'add', '-q', worktree, '-b', 'wt');
        await fse.outputFile(path.join(worktree, 'team.md'), 't\n');
        commit(worktree, 'team.md');
        await fse.outputFile(inRepo('team.md'), 't\n');

        const result = await sync(memoryOwner('delivered'), [inRepo('team.md'), path.join(worktree, 'team.md')]);

        expect(result.files).toHaveLength(1);
        expect(result.files[0].lines).toEqual(['/team.md']);
        expect(result.files[0].tracked).toEqual([{ path: path.join(worktree, 'team.md'), checkout: worktree }]);
        expect(status(repo)).toBe('');
        await fse.appendFile(path.join(worktree, 'team.md'), 'edit\n');
        expect(status(worktree)).toBe(' M team.md\n');
      });
    });

    it('still lists a path when git cannot say what the checkout tracks, and says so', async () => {
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.writeFile(inRepo('.git', 'index'), 'not an index');

      const result = await sync(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(result.files[0]).toMatchObject({ lines: ['/a.md'], checkFailed: [{ checkout: repo, error: expect.stringMatching(/index/) }] });
      expect(await read()).toMatch(/^\/a\.md$/m);
    });

    it('reports a listed path a rule of the member\'s re-includes, naming the rule', async () => {
      await fse.outputFile(inRepo('.claude', '.gitignore'), '!rules/*.md\n');
      await fse.outputFile(inRepo('.claude', 'rules', 'team.md'), 't\n');

      const result = await sync(memoryOwner('delivered'), [inRepo('.claude', 'rules', 'team.md')]);

      expect(result.files[0].reincluded).toEqual([{
        path: inRepo('.claude', 'rules', 'team.md'),
        rule: { source: inRepo('.claude', '.gitignore'), line: '1', pattern: '!rules/*.md' },
      }]);
    });

    describe('the member\'s lines', () => {
      it('keeps them and their CRLF line ends byte for byte, writing the block with the file\'s line ends', async () => {
        const mine = 'scratch/\r\n# my notes\r\n*.log\r\n';
        await fse.outputFile(excludeFile, mine);
        await fse.outputFile(inRepo('a.md'), 'a\n');
        const owner = memoryOwner('delivered');

        await sync(owner, [inRepo('a.md')]);

        expect(await read()).toBe(`${mine}# [teamai:delivered:start]\r\n/a.md\r\n# [teamai:delivered:end]\r\n`);
        expect(ignored(repo, 'a.md')).toBe(true);
        await sync(owner, []);
        expect(await read()).toBe(mine);
      });

      it('leaves a start marker that lost its end, and the lines after it, to the member, reporting it', async () => {
        const damaged = '# [teamai:delivered:start]\n/old.md\nscratch/\n';
        await fse.outputFile(excludeFile, damaged);
        await fse.outputFile(inRepo('a.md'), 'a\n');

        const result = await sync(memoryOwner('delivered'), [inRepo('a.md')]);

        expect(result.files[0].damaged).toEqual([{ owner: 'delivered', line: 1, problem: 'unclosed' }]);
        expect(await read()).toBe(`${damaged}# [teamai:delivered:start]\n/a.md\n# [teamai:delivered:end]\n`);
      });

      it('reports a duplicated block and merges it into one, inside teamai\'s markers only', async () => {
        await fse.outputFile(excludeFile, 'mine/\n# [teamai:delivered:start]\n/a.md\n# [teamai:delivered:end]\nmore/\n# [teamai:delivered:start]\n/b.md\n# [teamai:delivered:end]\n');
        await fse.outputFile(inRepo('a.md'), 'a\n');

        const result = await sync(memoryOwner('delivered'), [inRepo('a.md')]);

        expect(result.files[0].damaged).toEqual([{ owner: 'delivered', line: 6, problem: 'duplicate' }]);
        expect(await read()).toBe('mine/\n# [teamai:delivered:start]\n/a.md\n# [teamai:delivered:end]\nmore/\n');
      });
    });

    it('in a dry run, says what it would change and writes nothing: no info/, no lock file', async () => {
      await fse.remove(inRepo('.git', 'info'));
      await fse.outputFile(inRepo('a.md'), 'a\n');
      const owner = memoryOwner('delivered');

      const result = await sync(owner, [inRepo('a.md')], { dryRun: true });

      expect(result.files).toMatchObject([{ excludeFile, write: { kind: 'pending' }, added: ['/a.md'], dropped: [] }]);
      expect(await fse.pathExists(inRepo('.git', 'info'))).toBe(false);
      expect(owner.files).toEqual([]);
    });

    it('creates a missing info/ and lists the path', async () => {
      await fse.remove(inRepo('.git', 'info'));
      await fse.outputFile(inRepo('a.md'), 'a\n');

      await sync(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(status(repo)).toBe('');
    });

    it('names .git/info as not writable when it is a regular file', async () => {
      await fse.remove(inRepo('.git', 'info'));
      await fse.writeFile(inRepo('.git', 'info'), 'not a directory\n');
      await fse.outputFile(inRepo('a.md'), 'a\n');

      const result = await sync(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(result.files[0].write).toEqual({
        kind: 'notWritable',
        path: inRepo('.git', 'info'),
        message: `${excludeFile} is not writable, as ${inRepo('.git', 'info')} is not a directory`,
      });
    });

    describe('while another command holds the exclude file\'s lock', () => {
      beforeEach(async () => {
        await fse.outputFile(excludeFile, 'mine/\n');
        expect(await acquireLock(`${excludeFile}.teamai-lock`)).toBe(true);
      });

      afterEach(async () => {
        await releaseLock(`${excludeFile}.teamai-lock`);
      });

      it('writes nothing and says the file is locked', async () => {
        await fse.outputFile(inRepo('a.md'), 'a\n');
        const owner = memoryOwner('delivered');

        const result = await sync(owner, [inRepo('a.md')]);

        expect(result.files[0].write).toEqual({ kind: 'locked' });
        expect(await read()).toBe('mine/\n');
        expect(owner.files).toEqual([]);
      });
    });
  });

  // A write-only file passes the writability check, so only the read can tell it is there.
  describe.skipIf(process.getuid?.() === 0)('an exclude file that exists but cannot be read', () => {
    const member = 'mine/\n# [teamai:delivered:start]\n/old.md\n# [teamai:delivered:end]\n';

    beforeEach(async () => {
      await fse.outputFile(excludeFile, member);
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.chmod(excludeFile, 0o200);
    });

    afterEach(async () => {
      await fse.chmod(excludeFile, 0o644);
    });

    it('fails ensure explicitly and leaves the member\'s lines in place', async () => {
      const owner = memoryOwner('credentials');

      const [{ result }] = await ensure(owner, [inRepo('models.json')]);

      expect(result).toMatchObject({
        kind: 'notReadable',
        path: excludeFile,
        reason: expect.stringContaining(`${excludeFile} cannot be read`),
        fix: `Make ${excludeFile} readable, then run \`teamai pull\` again.`,
      });
      expect(owner.files).toEqual([]);
      await fse.chmod(excludeFile, 0o644);
      expect(await read()).toBe(member);
    });

    it('fails a dry-run ensure the same way', async () => {
      const [{ result }] = await ensure({ name: 'credentials' }, [inRepo('models.json')], { dryRun: true });

      expect(result).toMatchObject({ kind: 'notReadable', path: excludeFile });
    });

    it('syncs nothing into it, says why, and keeps it recorded', async () => {
      const owner = memoryOwner('delivered', [excludeFile]);

      const result = await sync(owner, [inRepo('a.md')]);

      expect(result.files[0].write).toEqual({ kind: 'notReadable', path: excludeFile, message: expect.stringContaining(`${excludeFile} cannot be read`) });
      expect(owner.files).toEqual([excludeFile]);
      await fse.chmod(excludeFile, 0o644);
      expect(await read()).toBe(member);
    });

    it('removes nothing from it, and does not take it for a missing file', async () => {
      const owner = memoryOwner('delivered', [excludeFile]);

      const [removal] = await remove(owner);

      expect(removal.write).toMatchObject({ kind: 'notReadable', path: excludeFile });
      expect(owner.files).toEqual([excludeFile]);
      await fse.chmod(excludeFile, 0o644);
      expect(await read()).toBe(member);
    });

    it('reports it as not readable, not every path as missing', async () => {
      const result = await report(memoryOwner('delivered', [excludeFile]), [inRepo('a.md')]);

      expect(result.files).toMatchObject([{
        excludeFile,
        notReadable: expect.stringContaining(`${excludeFile} cannot be read`),
        listed: [],
        missing: [],
        stale: [],
        visible: [inRepo('a.md')],
      }]);
    });
  });

  describe('two owners in one exclude file', () => {
    const provider = `providers/http/${encodeOwnerSegment('x')}`;

    it('keeps each owner\'s lines when the other syncs or is removed', async () => {
      await fse.outputFile(excludeFile, '');
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.outputFile(inRepo('b.md'), 'b\n');
      const agent = memoryOwner('local-agent');
      const http = memoryOwner(provider);

      await sync(agent, [inRepo('a.md')]);
      await sync(http, [inRepo('b.md')]);
      await sync(agent, [inRepo('a.md')]);
      expect(await read()).toBe('# [teamai:local-agent:start]\n/a.md\n# [teamai:local-agent:end]\n# [teamai:providers/http/x:start]\n/b.md\n# [teamai:providers/http/x:end]\n');

      await remove(agent);
      expect(await read()).toBe('# [teamai:providers/http/x:start]\n/b.md\n# [teamai:providers/http/x:end]\n');
      expect(status(repo)).toBe('?? a.md\n');
    });

    it('records each owner\'s files in its own state home, and removing one owner leaves the other\'s block and record', async () => {
      await fse.outputFile(excludeFile, '');
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.outputFile(inRepo('b.md'), 'b\n');
      const agentHome = path.join(tmp, 'state', 'local-agent');
      const providerHome = path.join(tmp, 'state', 'providers', 'http', 'x');
      const agent: GitExcludeOwner = { name: 'local-agent', record: stateHomeRecord(agentHome, 'local-agent') };
      const http: GitExcludeOwner = { name: provider, record: stateHomeRecord(providerHome, provider) };

      await sync(agent, [inRepo('a.md')]);
      await sync(http, [inRepo('b.md')]);

      expect(await fse.readJson(path.join(agentHome, 'git-exclude.json'))).toEqual({ 'local-agent': [excludeFile] });
      expect(await fse.readJson(path.join(providerHome, 'git-exclude.json'))).toEqual({ [provider]: [excludeFile] });

      await remove(agent);
      expect(await read()).toBe('# [teamai:providers/http/x:start]\n/b.md\n# [teamai:providers/http/x:end]\n');
      expect(await fse.readJson(path.join(providerHome, 'git-exclude.json'))).toEqual({ [provider]: [excludeFile] });
      expect(await fse.readJson(path.join(agentHome, 'git-exclude.json'))).toEqual({});
      expect(status(repo)).toBe('?? a.md\n');
    });

    it('encodes every byte of a provider name outside [a-z0-9_-] as % and two lowercase hex digits', () => {
      expect(encodeOwnerSegment('My Prov/é.x%')).toBe('%4dy%20%50rov%2f%c3%a9%2ex%25');
    });

    it('refuses an owner name outside [a-z0-9/_%-]', async () => {
      await expect(sync({ name: 'Local Agent' }, [])).rejects.toThrow('Invalid git exclude owner "Local Agent"');
    });
  });

  describe('ensure', () => {
    const credentials = (stateHome: string): GitExcludeOwner => ({ name: 'credentials', record: stateHomeRecord(stateHome, 'credentials') });

    it('adds the path, never removing a line, and records the exclude file in the state home', async () => {
      const stateHome = path.join(tmp, 'state');
      await fse.outputFile(excludeFile, '# [teamai:credentials:start]\n/old.json\n# [teamai:credentials:end]\n');
      const file = inRepo('.codebuddy', 'models.json');

      expect(await ensure(credentials(stateHome), [file])).toEqual([{ path: file, result: { kind: 'excluded', added: true } }]);
      expect(await ensure(credentials(stateHome), [file])).toEqual([{ path: file, result: { kind: 'excluded', added: false } }]);

      expect(await read()).toBe('# [teamai:credentials:start]\n/old.json\n/.codebuddy/models.json\n# [teamai:credentials:end]\n');
      expect(await fse.readJson(path.join(stateHome, 'git-exclude.json'))).toEqual({ credentials: [excludeFile] });
    });

    it('lists a path git already ignores (only mcp-exclude adds no line for one)', async () => {
      await fse.outputFile(inRepo('.codebuddy', '.gitignore'), 'models.json\n');

      const [{ result }] = await ensure({ name: 'credentials' }, [inRepo('.codebuddy', 'models.json')]);

      expect(result).toEqual({ kind: 'excluded', added: true });
      expect(await read()).toMatch(/^\/\.codebuddy\/models\.json$/m);
    });

    it('adds no mcp-exclude line for a file git already ignores, as #886 does', async () => {
      await fse.outputFile(inRepo('.gitignore'), '.mcp.json\n');

      const [{ result }] = await ensure({ name: 'mcp-exclude' }, [inRepo('.mcp.json')]);

      expect(result).toEqual({ kind: 'excluded', added: false });
      expect(await read()).not.toContain(MCP_EXCLUDE_START);
    });

    it.each(['delivered', 'local-agent'])('a secret owner lists a file only teamai\'s %s block ignores, so the file stays ignored once that block drops it', async (other) => {
      const config = inRepo('.cursor', 'mcp.json');
      const models = inRepo('.codebuddy', 'models.json');
      await fse.outputFile(config, '{}\n');
      await fse.outputFile(models, '{}\n');
      await fse.outputFile(excludeFile, `# [teamai:${other}:start]\n/.codebuddy/models.json\n/.cursor/mcp.json\n# [teamai:${other}:end]\n`);
      expect(status(repo)).toBe('');

      const [{ result: mcp }] = await ensure({ name: 'mcp-exclude' }, [config]);
      const [{ result: key }] = await ensure({ name: 'credentials' }, [models]);
      await sync(memoryOwner(other, [excludeFile]), []);

      expect(mcp).toEqual({ kind: 'excluded', added: true });
      expect(key).toEqual({ kind: 'excluded', added: true });
      expect(await read()).not.toContain(`# [teamai:${other}:start]`);
      expect(status(repo)).toBe('');
    });

    it('adds no mcp-exclude line for a file a line of the member\'s in .git/info/exclude ignores, beside teamai\'s blocks', async () => {
      await fse.outputFile(excludeFile, '# [teamai:delivered:start]\n/a.md\n# [teamai:delivered:end]\n/.mcp.json\n');

      const [{ result }] = await ensure({ name: 'mcp-exclude' }, [inRepo('.mcp.json')]);

      expect(result).toEqual({ kind: 'excluded', added: false });
      expect(await read()).not.toContain(MCP_EXCLUDE_START);
    });

    it('fails for a tracked file before writing anything, with #886\'s text', async () => {
      const file = inRepo('models.json');
      await fse.outputFile(file, '{}\n');
      commit(repo, 'models.json');

      const [{ result }] = await ensure({ name: 'credentials' }, [file], { rerun: 'apply the model config again' });

      expect(result).toEqual({
        kind: 'tracked',
        reason: `git already tracks ${file}`,
        fix: `Run \`git rm --cached ${file}\` (rotate any value a commit of it holds), then apply the model config again.`,
      });
      expect(await fse.pathExists(excludeFile) ? await read() : '').not.toContain('teamai');
    });

    it('names the rule that re-includes the path, in the directory that holds it', async () => {
      await fse.outputFile(inRepo('.codebuddy', '.gitignore'), '!models.json\n');
      const file = inRepo('.codebuddy', 'models.json');

      const [{ result }] = await ensure({ name: 'credentials' }, [file]);

      expect(result).toEqual({
        kind: 'reincluded',
        rule: { source: inRepo('.codebuddy', '.gitignore'), line: '1', pattern: '!models.json' },
        reason: `a rule in your git ignore files re-includes ${file}: \`!models.json\` (${inRepo('.codebuddy', '.gitignore')}:1)`,
        fix: `Remove \`!models.json\` from ${inRepo('.codebuddy', '.gitignore')}, then run \`teamai pull\` again.`,
      });
    });

    it('says which path is not writable', async () => {
      await fse.remove(inRepo('.git', 'info'));
      await fse.writeFile(inRepo('.git', 'info'), 'x\n');

      const [{ result }] = await ensure({ name: 'credentials' }, [inRepo('models.json')]);

      expect(result).toMatchObject({ kind: 'notWritable', path: inRepo('.git', 'info') });
    });

    it('passes git\'s error on when git cannot answer', async () => {
      await fse.writeFile(inRepo('.git', 'config'), '[core\nbroken\n');

      const [{ result }] = await ensure({ name: 'credentials' }, [inRepo('models.json')]);

      expect(result).toMatchObject({ kind: 'gitFailed', error: expect.stringMatching(/config/) });
    });

    it('fails when git cannot confirm it ignores the path after listing it', async () => {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const bin = path.join(tmp, 'bin');
      await fse.outputFile(
        path.join(bin, 'git'),
        `#!/bin/sh\nif [ "$1" = check-ignore ]; then echo 'fatal: cannot check' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`,
        { mode: 0o755 },
      );
      const pathBefore = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${pathBefore ?? ''}`;
      let results: Awaited<ReturnType<typeof ensure>>;
      try {
        results = await ensure({ name: 'credentials' }, [inRepo('models.json')]);
      } finally {
        process.env.PATH = pathBefore;
      }

      expect(results[0].result).toEqual({
        kind: 'gitFailed',
        error: 'fatal: cannot check',
        reason: `git could not confirm that it ignores ${inRepo('models.json')}: "fatal: cannot check"`,
        fix: `Check that \`git check-ignore -v ${inRepo('models.json')}\` works in that repository, then run \`teamai pull\` again.`,
      });
    });

    it('says a path outside any repository is outside', async () => {
      const [{ result }] = await ensure({ name: 'credentials' }, [path.join(tmp, 'plain', 'models.json')]);

      expect(result).toEqual({ kind: 'outsideRepo' });
    });

    it('in a dry run, writes nothing and records nothing', async () => {
      const stateHome = path.join(tmp, 'state');
      await fse.remove(inRepo('.git', 'info'));

      const [{ result }] = await ensure(credentials(stateHome), [inRepo('models.json')], { dryRun: true });

      expect(result).toEqual({ kind: 'pending' });
      expect(await fse.pathExists(inRepo('.git', 'info'))).toBe(false);
      expect(await fse.pathExists(stateHome)).toBe(false);
    });

    it('writes nothing and says so while another command holds the lock', async () => {
      await fse.outputFile(excludeFile, 'mine/\n');
      expect(await acquireLock(`${excludeFile}.teamai-lock`)).toBe(true);
      try {
        const [{ result }] = await ensure({ name: 'credentials' }, [inRepo('models.json')]);

        expect(result).toEqual({
          kind: 'locked',
          reason: `another teamai command held ${excludeFile} past the wait`,
          fix: 'Run `teamai pull` again.',
        });
        expect(await read()).toBe('mine/\n');
      } finally {
        await releaseLock(`${excludeFile}.teamai-lock`);
      }
    });
  });

  describe('remove', () => {
    it('visits every recorded exclude file, keeps the lines `keep` asks for, and forgets the files left without a block', async () => {
      const other = await newRepo('other');
      const otherExclude = path.join(other, '.git', 'info', 'exclude');
      const stateHome = path.join(tmp, 'state');
      const owner = { name: 'credentials', record: stateHomeRecord(stateHome, 'credentials') };
      await fse.outputFile(excludeFile, '');
      await ensure(owner, [inRepo('models.json'), path.join(other, 'models.json')]);
      await fse.outputFile(path.join(other, 'models.json'), '{"key":"secret"}\n');

      const removal = await remove(owner, { keep: ({ excludeFile: file }) => file === otherExclude });

      expect(removal.sort((a, b) => (a.excludeFile === excludeFile ? -1 : 1) - (b.excludeFile === excludeFile ? -1 : 1))).toMatchObject([
        { excludeFile, write: { kind: 'written' }, removed: [{ owner: 'credentials', lines: ['/models.json'] }], kept: [] },
        { excludeFile: otherExclude, write: { kind: 'unchanged' }, removed: [{ owner: 'credentials', lines: [] }], kept: [{ owner: 'credentials', lines: ['/models.json'] }] },
      ]);
      expect(await read()).toBe('');
      expect(ignored(other, 'models.json')).toBe(true);
      expect(await fse.readJson(path.join(stateHome, 'git-exclude.json'))).toEqual({ credentials: [otherExclude] });
    });

    it('removes every teamai block for `all`, found by its prefix, and leaves the member\'s lines and a damaged marker', async () => {
      await fse.outputFile(excludeFile, [
        'mine/',
        MCP_EXCLUDE_START, '/.mcp.json', MCP_EXCLUDE_END,
        '# [teamai:delivered:start]', '/a.md', '# [teamai:delivered:end]',
        '# [teamai:providers/http/x:start]', '/b.md', '# [teamai:providers/http/x:end]',
        '# [teamai:local-agent:start]', 'kept/',
        '',
      ].join('\n'));

      const [removal] = await remove('all', { files: [excludeFile] });

      expect(removal.removed.map((r) => r.owner)).toEqual(['mcp-exclude', 'delivered', 'providers/http/x']);
      expect(removal.damaged).toEqual([{ owner: 'local-agent', line: 11, problem: 'unclosed' }]);
      expect(await read()).toBe('mine/\n# [teamai:local-agent:start]\nkept/\n');
    });

    it('skips an exclude file that is gone with its repository, creating nothing', async () => {
      const gone = path.join(tmp, 'gone', '.git', 'info', 'exclude');

      expect(await remove(memoryOwner('local-agent', [gone]))).toEqual([{ excludeFile: gone, write: { kind: 'missing' }, removed: [], kept: [], damaged: [] }]);
      expect(await fse.pathExists(path.join(tmp, 'gone'))).toBe(false);
    });

    it('in a dry run, lists what it would remove and writes nothing', async () => {
      const content = '# [teamai:local-agent:start]\n/a.md\n# [teamai:local-agent:end]\n';
      await fse.outputFile(excludeFile, content);
      const owner = memoryOwner('local-agent', [excludeFile]);

      expect(await remove(owner, { dryRun: true })).toMatchObject([{ write: { kind: 'pending' }, removed: [{ owner: 'local-agent', lines: ['/a.md'] }] }]);
      expect(await read()).toBe(content);
      expect(owner.files).toEqual([excludeFile]);
    });
  });

  describe('report', () => {
    it('says per exclude file which paths are listed, missing, tracked, re-included and which lines are stale, writing nothing', async () => {
      const other = await newRepo('other');
      const otherExclude = path.join(other, '.git', 'info', 'exclude');
      await fse.outputFile(inRepo('listed.md'), 'l\n');
      await fse.outputFile(inRepo('missing.md'), 'm\n');
      await fse.outputFile(inRepo('tracked.md'), 't\n');
      await fse.outputFile(inRepo('.claude', 'rules', 'back.md'), 'b\n');
      await fse.outputFile(inRepo('.claude', '.gitignore'), '!rules/*.md\n');
      commit(repo, 'tracked.md');
      await fse.outputFile(excludeFile, 'mine/\n# [teamai:delivered:start]\n/listed.md\n/.claude/rules/back.md\n/stale.md\n# [teamai:delivered:end]\n# [teamai:delivered:end]\n');
      await fse.outputFile(otherExclude, '# [teamai:delivered:start]\n/gone.md\n# [teamai:delivered:end]\n');
      const before = await read();

      const result = await report(memoryOwner('delivered', [otherExclude]), [
        inRepo('listed.md'), inRepo('missing.md'), inRepo('tracked.md'), inRepo('.claude', 'rules', 'back.md'),
      ]);

      expect(result.files).toEqual([
        {
          excludeFile,
          listed: [inRepo('listed.md'), inRepo('.claude', 'rules', 'back.md')],
          missing: [inRepo('missing.md')],
          tracked: [{ path: inRepo('tracked.md'), checkout: repo }],
          reincluded: [{ path: inRepo('.claude', 'rules', 'back.md'), rule: { source: inRepo('.claude', '.gitignore'), line: '1', pattern: '!rules/*.md' } }],
          stale: ['/stale.md'],
          damaged: [{ owner: 'delivered', line: 7, problem: 'unopened' }],
          checkFailed: [],
          visible: [inRepo('missing.md'), inRepo('.claude', 'rules', 'back.md')],
        },
        { excludeFile: otherExclude, listed: [], missing: [], tracked: [], reincluded: [], stale: ['/gone.md'], damaged: [], checkFailed: [], visible: [] },
      ]);
      expect(await read()).toBe(before);
      expect(await fse.pathExists(`${excludeFile}.teamai-lock`)).toBe(false);
    });

    it('reads block lines as git does, stripping only \\r: a line with a leading space lists nothing', async () => {
      await fse.outputFile(inRepo('a.md'), 'a\n');
      await fse.outputFile(excludeFile, '# [teamai:delivered:start]\r\n  /a.md\r\n# [teamai:delivered:end]\r\n');

      const result = await report(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(ignored(repo, 'a.md')).toBe(false);
      expect(result.files).toMatchObject([{ listed: [], missing: [inRepo('a.md')], stale: ['  /a.md'] }]);
    });

    it('asks git a fixed number of times per exclude file, however many paths and directories it checks', async () => {
      const paths: string[] = [];
      for (const dir of ['.claude/skills', '.claude/rules/fe', '.cursor/rules', '.codex/agents', '.github/instructions', '.opencode']) {
        for (const name of ['a', 'b', 'c']) {
          paths.push(inRepo(...dir.split('/'), `${name}.md`));
          await fse.outputFile(paths[paths.length - 1], `${name}\n`);
        }
      }
      await fse.outputFile(inRepo('.claude', '.gitignore'), '!rules/fe/a.md\n');
      await fse.outputFile(excludeFile, ['# [teamai:delivered:start]', ...paths.map((p) => `/${path.relative(repo, p)}`), '# [teamai:delivered:end]', ''].join('\n'));
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const bin = path.join(tmp, 'bin');
      const log = path.join(tmp, 'git-calls.log');
      await fse.outputFile(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const pathBefore = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${pathBefore ?? ''}`;
      let result: Awaited<ReturnType<typeof report>>;
      try {
        result = await report(memoryOwner('delivered'), paths);
      } finally {
        process.env.PATH = pathBefore;
      }
      const calls = (await read(log)).split('\n').filter(Boolean);

      expect(result.files).toMatchObject([{ missing: [], reincluded: [{ path: inRepo('.claude', 'rules', 'fe', 'a.md') }] }]);
      expect(calls.filter((c) => /\bls-files\b.*--others/.test(c))).toHaveLength(1);
      expect(calls.filter((c) => /\bcheck-ignore\b/.test(c))).toHaveLength(1);
      // Where the file is, what it tracks, what git still offers, the one re-included path, and git for macOS' precompose setting.
      expect(calls.length).toBeLessThanOrEqual(5);
    });

    it('creates no info/ in a repository without one', async () => {
      await fse.remove(inRepo('.git', 'info'));
      await fse.outputFile(inRepo('a.md'), 'a\n');

      const result = await report(memoryOwner('delivered'), [inRepo('a.md')]);

      expect(result.files).toMatchObject([{ excludeFile, missing: [inRepo('a.md')] }]);
      expect(await fse.pathExists(inRepo('.git', 'info'))).toBe(false);
    });
  });

  describe('gitUntracked', () => {
    it('is true only for a file git says it does not track, or one in no repository', async () => {
      await fse.outputFile(inRepo('tracked.md'), 'x\n');
      await fse.outputFile(inRepo('loose.md'), 'x\n');
      commit(repo, 'tracked.md');
      const outside = path.join(tmp, 'plain', 'file.md');
      await fse.outputFile(outside, 'x\n');

      expect(await gitUntracked(inRepo('tracked.md'))).toBe(false);
      expect(await gitUntracked(inRepo('loose.md'))).toBe(true);
      expect(await gitUntracked(outside)).toBe(true);
    });

    it('is false in a repository git cannot read, so nothing there is deleted on a guess', async () => {
      await fse.outputFile(inRepo('tracked.md'), 'x\n');
      commit(repo, 'tracked.md');
      await fse.writeFile(inRepo('.git', 'HEAD'), 'not a ref\n');

      expect(await gitUntracked(inRepo('tracked.md'))).toBe(false);
    });
  });
});
