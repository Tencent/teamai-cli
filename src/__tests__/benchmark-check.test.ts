import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVerdict } from '../benchmark/check.js';
import { restoreProtected } from '../benchmark/trial.js';
import type { CommandExit } from '../workflow/shell-command.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkVerdict', () => {
  it.each<[string, CommandExit, NodeJS.Platform, ReturnType<typeof checkVerdict>]>([
    ['exit 0', { kind: 'exited', code: 0 }, 'linux', { verdict: 'passed' }],
    ['exit 1', { kind: 'exited', code: 1 }, 'linux', { verdict: 'failed', exitCode: 1 }],
    ['exit 2', { kind: 'exited', code: 2 }, 'linux', { verdict: 'failed', exitCode: 2 }],
    ['exit 126', { kind: 'exited', code: 126 }, 'linux', { verdict: 'could_not_run', cause: 'not_executable' }],
    ['exit 127', { kind: 'exited', code: 127 }, 'linux', { verdict: 'could_not_run', cause: 'not_found' }],
    ['exit 9009 on win32', { kind: 'exited', code: 9009 }, 'win32', { verdict: 'could_not_run', cause: 'not_found' }],
    ['exit 9009 elsewhere', { kind: 'exited', code: 9009 }, 'linux', { verdict: 'failed', exitCode: 9009 }],
    ['a signal', { kind: 'signal', signal: 'SIGKILL' }, 'linux', { verdict: 'could_not_run', cause: 'signal', detail: 'SIGKILL' }],
    ['exit 128', { kind: 'exited', code: 128 }, 'linux', { verdict: 'failed', exitCode: 128 }],
    ['exit 137, a shell reporting a SIGKILL', { kind: 'exited', code: 137 }, 'linux', { verdict: 'could_not_run', cause: 'signal', detail: 'exit 137' }],
    ['exit 192, a shell reporting signal 64', { kind: 'exited', code: 192 }, 'darwin', { verdict: 'could_not_run', cause: 'signal', detail: 'exit 192' }],
    ['exit 193', { kind: 'exited', code: 193 }, 'linux', { verdict: 'failed', exitCode: 193 }],
    ['exit 137 on win32', { kind: 'exited', code: 137 }, 'win32', { verdict: 'failed', exitCode: 137 }],
    ['a timeout', { kind: 'timeout' }, 'linux', { verdict: 'could_not_run', cause: 'timeout' }],
    ['a spawn failure', { kind: 'spawn_failed', message: 'spawn EACCES' }, 'linux', { verdict: 'could_not_run', cause: 'spawn_failed', detail: 'spawn EACCES' }],
  ])('classifies %s', (_, exit, platform, verdict) => {
    expect(checkVerdict(exit, platform)).toEqual(verdict);
  });
});

describe('restoreProtected', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  }

  function write(repo: string, file: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }

  function read(repo: string, file: string): string | undefined {
    const at = path.join(repo, file);
    return fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : undefined;
  }

  /** A repo at its starting commit, with protected tests, a config and a fixture whose path holds spaces. */
  function startingRepo(): { repo: string; start: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-check-'));
    dirs.push(repo);
    git(repo, ['init', '-q']);
    write(repo, 'vitest.config.ts', 'export default {};\n');
    write(repo, 'test/answer.test.js', 'expect(answer()).toBe(42);\n');
    write(repo, 'fixtures dir/the input.txt', 'input\n');
    write(repo, 'src/answer.js', 'export const answer = () => 0;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'start']);
    return { repo, start: git(repo, ['rev-parse', 'HEAD']).trim() };
  }

  it('puts back every protected path as the starting commit has it, whether changed, committed, added or removed, and keeps the rest', async () => {
    const { repo, start } = startingRepo();
    write(repo, 'test/answer.test.js', 'it.skip("answer");\n');
    write(repo, 'test/helper.js', 'export const helper = 1;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'skip the test']);
    write(repo, 'vitest.config.ts', 'export default { test: { exclude: ["test/**"] } };\n');
    write(repo, 'test/untracked.js', 'untracked\n');
    fs.rmSync(path.join(repo, 'fixtures dir/the input.txt'));
    write(repo, 'src/answer.js', 'export const answer = () => 42;\n');

    const failure = await restoreProtected({ clone: repo, startingCommit: start, protect: ['vitest.config.ts', 'test/**', 'fixtures dir/*.txt'], sources: [repo], env: process.env });

    expect(failure).toBeUndefined();
    expect(read(repo, 'vitest.config.ts')).toBe('export default {};\n');
    expect(read(repo, 'test/answer.test.js')).toBe('expect(answer()).toBe(42);\n');
    expect(read(repo, 'test/helper.js')).toBeUndefined();
    expect(read(repo, 'test/untracked.js')).toBeUndefined();
    expect(read(repo, 'fixtures dir/the input.txt')).toBe('input\n');
    expect(read(repo, 'src/answer.js')).toBe('export const answer = () => 42;\n');
    const protectedPaths = ['vitest.config.ts', 'test', 'fixtures dir'];
    expect(git(repo, ['diff', '--name-only', start, '--', ...protectedPaths])).toBe('');
    expect(git(repo, ['diff', '--cached', '--name-only', start, '--', ...protectedPaths])).toBe('');
    expect(git(repo, ['ls-files', '--others', '--', ...protectedPaths])).toBe('');
  });

  it.each([
    ['left untracked', false],
    ['committed into the clone', true],
  ])('removes a git repository the agent made under a protected path, %s', async (_, committed) => {
    const { repo, start } = startingRepo();
    const nested = path.join(repo, 'test/helpers');
    fs.mkdirSync(nested);
    git(nested, ['init', '-q']);
    write(nested, 'pass.setup.js', 'require("node:assert").strictEqual = () => {};\n');
    git(nested, ['add', '-A']);
    git(nested, ['commit', '-q', '-m', 'helper']);
    if (committed) {
      git(repo, ['add', 'test/helpers']);
      git(repo, ['commit', '-q', '-m', 'add the helper repository']);
    }

    const failure = await restoreProtected({ clone: repo, startingCommit: start, protect: ['test/**'], sources: [repo], env: process.env });

    expect(failure).toBeUndefined();
    expect(fs.existsSync(nested)).toBe(false);
    expect(git(repo, ['diff', '--name-only', start, '--', 'test'])).toBe('');
    expect(git(repo, ['ls-files', '--others', '--', 'test'])).toBe('');
  });

  it.each([['tests'], ['tests/**'], ['**/*.js']])('fails when protected path %s reaches into a submodule, whose files git does not put back', async (spec) => {
    const { repo, start: first } = startingRepo();
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${first},tests`]);
    git(repo, ['commit', '-q', '-m', 'tests submodule']);
    const start = git(repo, ['rev-parse', 'HEAD']).trim();
    write(repo, 'tests/check.js', REPLACED_TEST);

    const failure = await restoreProtected({ clone: repo, startingCommit: start, protect: [spec], sources: [repo], env: process.env });

    expect(failure).toMatchObject({ code: 'trial_prepare_failed', message: expect.stringContaining(`"${spec}" reaches into submodule tests`) });
  });

  it('restores a protected path beside a submodule it does not reach', async () => {
    const { repo, start: first } = startingRepo();
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${first},tests`]);
    git(repo, ['commit', '-q', '-m', 'tests submodule']);
    const start = git(repo, ['rev-parse', 'HEAD']).trim();
    write(repo, TEST, REPLACED_TEST);

    const failure = await restoreProtected({ clone: repo, startingCommit: start, protect: ['test/**'], sources: [repo], env: process.env });

    expect(failure).toBeUndefined();
    expect(read(repo, TEST)).toBe(STARTING_TEST);
  });

  it('changes nothing when no protected path differs from the starting commit', async () => {
    const { repo, start } = startingRepo();
    write(repo, 'src/answer.js', 'export const answer = () => 42;\n');

    const failure = await restoreProtected({ clone: repo, startingCommit: start, protect: ['test/**', 'missing/**'], sources: [repo], env: process.env });

    expect(failure).toBeUndefined();
    expect(git(repo, ['status', '--porcelain'])).toBe(' M src/answer.js\n');
  });

  const TEST = 'test/answer.test.js';
  const STARTING_TEST = 'expect(answer()).toBe(42);\n';
  const REPLACED_TEST = 'process.exit(0);\n';

  /** A trial's clone of `repo` at `start`, made as a trial's is, with every object it fetched loose. */
  function trialClone(repo: string, start: string): string {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-clone-'));
    dirs.push(clone);
    git(clone, ['init', '-q']);
    git(clone, ['-c', 'fetch.unpackLimit=1000', 'fetch', '-q', '--no-tags', repo, start]);
    git(clone, ['checkout', '-q', '--detach', start]);
    return clone;
  }

  /** Writes `body` over the loose object `oid` of `clone`, as an agent that edits `.git/objects` would. */
  function forgeObject(clone: string, oid: string, kind: 'blob' | 'tree', body: Buffer): void {
    const file = path.join(clone, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body])));
  }

  function restoreClone(clone: string, repo: string, start: string): ReturnType<typeof restoreProtected> {
    return restoreProtected({ clone, startingCommit: start, protect: ['test/**'], sources: [repo], env: process.env });
  }

  it.each(['--assume-unchanged', '--skip-worktree'])('puts back a protected file the agent replaced and marked %s in the index', async (flag) => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    git(clone, ['update-index', flag, TEST]);
    write(clone, TEST, REPLACED_TEST);

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toBeUndefined();
    expect(read(clone, TEST)).toBe(STARTING_TEST);
  });

  it('puts back a protected file the agent replaced and hid behind a clean filter that hands git the original', async () => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    fs.copyFileSync(path.join(clone, TEST), path.join(clone, '.git', 'pristine'));
    git(clone, ['config', 'filter.hide.clean', 'cat .git/pristine']);
    write(clone, '.git/info/attributes', `${TEST} filter=hide\n`);
    write(clone, TEST, REPLACED_TEST);

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toBeUndefined();
    expect(read(clone, TEST)).toBe(STARTING_TEST);
  });

  it('fails when a filter of the agent writes a file under a protected path while the restore runs, and adds it to the index git gave it', async () => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    git(clone, ['config', 'filter.agent.smudge', 'cat; echo helper > test/pass.setup.js; git update-index --add test/pass.setup.js']);
    write(clone, '.git/info/attributes', `${TEST} filter=agent\n`);
    write(clone, TEST, REPLACED_TEST);

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toMatchObject({ code: 'trial_prepare_failed', message: expect.stringContaining('test/pass.setup.js') });
  });

  it.each<[string, (clone: string, start: string) => void]>([
    ['the starting commit', (clone, start) => {
      git(clone, ['add', '-A']);
      git(clone, ['commit', '-q', '-m', 'substitute']);
      git(clone, ['replace', start, 'HEAD']);
    }],
    ['a protected file of it', (clone, start) => {
      git(clone, ['replace', git(clone, ['rev-parse', `${start}:${TEST}`]).trim(), git(clone, ['hash-object', '-w', TEST]).trim()]);
    }],
  ])('puts back what the starting commit itself holds when the agent replaced %s with git replace', async (_, replace) => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    write(clone, TEST, REPLACED_TEST);
    replace(clone, start);

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toBeUndefined();
    expect(read(clone, TEST)).toBe(STARTING_TEST);
  });

  it("puts back a protected file when the agent rewrote the starting commit's tree in the clone's object store", async () => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    write(clone, TEST, REPLACED_TEST);
    const replaced = git(clone, ['hash-object', '-w', TEST]).trim();
    forgeObject(clone, git(clone, ['rev-parse', `${start}:test`]).trim(), 'tree', Buffer.concat([Buffer.from('100644 answer.test.js\0'), Buffer.from(replaced, 'hex')]));

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toBeUndefined();
    expect(read(clone, TEST)).toBe(STARTING_TEST);
  });

  it("fails when the clone's object store gives a protected file other bytes than the starting commit names", async () => {
    const { repo, start } = startingRepo();
    const clone = trialClone(repo, start);
    forgeObject(clone, git(clone, ['rev-parse', `${start}:${TEST}`]).trim(), 'blob', Buffer.from(REPLACED_TEST));
    write(clone, TEST, REPLACED_TEST);

    const failure = await restoreClone(clone, repo, start);

    expect(failure).toMatchObject({ code: 'trial_prepare_failed', message: expect.stringContaining(TEST) });
  });
});
