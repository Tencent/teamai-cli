import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { log } from '../utils/logger.js';
import { buildIndex, loadIndex, type BuildIndexOptions } from '../utils/search-index.js';

/**
 * The index follows what the member receives, however much smaller that is.
 * Only files the build was given and could not read keep their previous
 * entries (#1006).
 */
describe('buildIndex when the indexed set shrinks (#1006)', () => {
  let tmpDir: string;
  let indexPath: string;
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

  const writeSkills = async (count: number): Promise<string[]> => {
    const dirs: string[] = [];
    for (let i = 1; i <= count; i++) {
      const dir = path.join(tmpDir, 'skills', 'ns', `zqx-skill-${i}`);
      await fse.outputFile(path.join(dir, 'SKILL.md'), `---\nname: zqx-skill-${i}\ndescription: zqx skill ${i}\n---\nbody`);
      dirs.push(dir);
    }
    return dirs;
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-unreadable-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('writes an empty index when the member no longer receives anything', async () => {
    await buildIndex({ skills: { kind: 'dirs', dirs: await writeSkills(7) }, indexPath });
    expect((await loadIndex(indexPath))?.entries).toHaveLength(7);

    await buildIndex({ skills: { kind: 'dirs', dirs: [] }, indexPath });

    expect((await loadIndex(indexPath))?.entries).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('keeps the previous entries of the files it was given and could not read', async () => {
    const dirs = await writeSkills(7);
    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });
    for (const dir of dirs) await fse.remove(path.join(dir, 'SKILL.md'));

    await buildIndex({ skills: { kind: 'dirs', dirs }, indexPath });

    expect((await loadIndex(indexPath))?.entries).toHaveLength(7);
    expect(warnings()).toEqual([
      expect.stringMatching(/^Search index could not read 7 path\(s\) \(.*zqx-skill-1[\\/]SKILL\.md: ENOENT, .*, and 4 more\); recall keeps what the previous index held for them\./),
    ]);
  });

  it('writes what it could read and names the files it could not', async () => {
    const docsDir = path.join(tmpDir, 'docs');
    await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
    await fse.outputFile(path.join(docsDir, 'b.md'), '---\ntitle: b\n---\nbody');
    await buildIndex({ skills: { kind: 'dirs', dirs: await writeSkills(7) }, indexPath });

    await buildIndex({ docsDir, docFiles: ['a.md', 'b.md', 'gone.md'], indexPath });

    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.filename).sort()).toEqual(['a.md', 'b.md']);
    expect(warnings()).toEqual([
      `Search index could not read 1 path(s) (${path.join(docsDir, 'gone.md')}: ENOENT); recall keeps what the previous index held for them. `
        + 'Fix them and run `teamai pull` to index them again.',
    ]);
  });

  // Every combination of what a rebuild can be handed. The result is what it
  // read, the skills keep-indexed retains, and the previous entries of the files
  // it was given and could not read; nothing else of the previous index stays.
  // The previous index holds docs A (`a.md`) and B (`b.md`) and one skill; the
  // rebuild is given A, unreadable or not, and never B.
  const cases = [false, true].flatMap((keepIndexed) => [0, 1].flatMap((readable) =>
    [false, true].flatMap((unreadable) => [false, true].map((existing) => ({
      name: `keep-indexed=${keepIndexed} readable=${readable} a-unreadable=${unreadable} index=${existing}`
        + (!keepIndexed && readable === 0 && unreadable && existing ? ' (A unreadable, B no longer delivered)' : ''),
      keepIndexed, readable, unreadable, existing,
    })))));

  it.each(cases.map((row) => [row.name, row] as const))(
    '%s',
    async (_name, { keepIndexed, readable, unreadable, existing }) => {
      const docsDir = path.join(tmpDir, 'docs');
      if (existing) {
        await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
        await fse.outputFile(path.join(docsDir, 'b.md'), '---\ntitle: b\n---\nbody');
        await buildIndex({ docsDir, docFiles: ['a.md', 'b.md'], skills: { kind: 'dirs', dirs: await writeSkills(1) }, indexPath });
        await fse.remove(path.join(docsDir, 'b.md'));
      }
      if (unreadable) await fse.remove(path.join(docsDir, 'a.md'));
      else await fse.outputFile(path.join(docsDir, 'a.md'), '---\ntitle: a\n---\nbody');
      const docFiles = ['a.md'];
      for (let i = 0; i < readable; i++) {
        await fse.outputFile(path.join(docsDir, `read-${i}.md`), `---\ntitle: read ${i}\n---\nbody`);
        docFiles.push(`read-${i}.md`);
      }

      await buildIndex({
        docsDir,
        docFiles,
        skills: keepIndexed ? { kind: 'keep-indexed', reason: 'test' } : { kind: 'dirs', dirs: [] },
        indexPath,
      });

      const entries = (await loadIndex(indexPath))?.entries.map((entry) => `${entry.type}:${entry.filename}`).sort();
      const read = docFiles.filter((file) => file !== 'a.md' || !unreadable).map((file) => `docs:${file}`);
      const retainedSkills = keepIndexed && existing ? ['skills:zqx-skill-1.md'] : [];
      const unreadableKept = unreadable && existing ? ['docs:a.md'] : [];
      expect(entries).toEqual([...read, ...retainedSkills, ...unreadableKept].sort());
      expect(warnings()).toEqual(unreadable
        ? [expect.stringMatching(/^Search index could not read 1 path\(s\) \(.*a\.md: ENOENT\); recall keeps what the previous index held for them\./)]
        : []);
    },
  );
});

/**
 * A root the build cannot list counts as given and unreadable as a whole: the
 * previous entries of the files under it stay, the warning names it, and the
 * rest of the index is still rebuilt (#1006).
 */
describe('buildIndex when a root cannot be listed (#1006)', () => {
  let tmpDir: string;
  let indexPath: string;
  let locked: string[];
  const warnings = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
  const doc = (title: string): string => `---\ntitle: ${title}\n---\nbody`;
  // chmod 0o000 has no effect when running as root (CI), nor on Windows.
  const chmodApplies = process.platform !== 'win32' && process.getuid?.() !== 0;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-unlistable-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    locked = [];
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    for (const dir of locked) await fse.chmod(dir, 0o755);
    await fse.remove(tmpDir);
  });

  type Failure = 'removed' | 'chmod 000' | 'parent chmod 000' | 'replaced by a file';
  const breakPath = async (target: string, failure: Failure): Promise<void> => {
    if (failure === 'removed') {
      await fse.remove(target);
      return;
    }
    if (failure === 'replaced by a file') {
      await fse.remove(target);
      await fse.outputFile(target, 'not a directory');
      return;
    }
    const dir = failure === 'chmod 000' ? target : path.dirname(target);
    await fse.chmod(dir, 0o000);
    locked.push(dir);
  };

  // Each directory a collector lists, the entry the previous index holds for
  // the file under it, and whether a walk found it (`found`) rather than being
  // given it. A removed directory is gone, not unreadable, and so is what was
  // under a found directory a file replaced: there is no directory to list.
  const roots = [
    { name: 'learnings root', file: 'learnings/root/x.md', broken: 'learnings/root', id: 'learnings:x.md', found: false },
    { name: 'learnings namespace', file: 'learnings/root/ns/x.md', broken: 'learnings/root/ns', id: 'learnings:ns/x.md', found: false },
    { name: 'walked docs root', file: 'docs/root/sub/x.md', broken: 'docs/root', id: 'docs:sub/x.md', found: false },
    { name: 'walked docs subdirectory', file: 'docs/root/sub/x.md', broken: 'docs/root/sub', id: 'docs:sub/x.md', found: true },
    { name: 'walked rules root', file: 'rules/root/sub/x.md', broken: 'rules/root', id: 'rules:sub/x.md', found: false },
    { name: 'skills root', file: 'skills/root/ns/x/SKILL.md', broken: 'skills/root', id: 'skills:x.md', found: false },
    { name: 'skills namespace', file: 'skills/root/ns/x/SKILL.md', broken: 'skills/root/ns', id: 'skills:x.md', found: true },
    { name: 'codebase root', file: 'codebase/root/sub/x.md', broken: 'codebase/root', id: 'docs:sub/x.md', found: false },
  ] as const;
  const failures: readonly Failure[] = ['removed', 'chmod 000', 'parent chmod 000', 'replaced by a file'];
  const cases = roots.flatMap((root) => failures.map((failure) => ({ ...root, failure })));

  it.each(cases.map((row) => [`${row.name}, ${row.failure}`, row] as const))('%s', async (_name, row) => {
    if (row.failure.includes('chmod') && !chmodApplies) return;
    const other = path.join(tmpDir, 'other');
    const w = (rel: string): string => path.join(tmpDir, rel);
    const opts = {
      learningsDirs: [w('learnings/root'), other],
      learningsNamespaces: ['ns'],
      docsDir: w('docs/root'),
      rulesDir: w('rules/root'),
      skillsDir: w('skills/root'),
      codebaseDir: w('codebase/root'),
      indexPath,
    };
    await fse.outputFile(path.join(tmpDir, row.file), doc('x'));
    await fse.outputFile(path.join(other, 'b.md'), doc('b'));
    await buildIndex(opts);
    await fse.remove(path.join(other, 'b.md'));
    await fse.outputFile(path.join(other, 'r.md'), doc('r'));
    const broken = path.join(tmpDir, row.broken);
    await breakPath(broken, row.failure);

    await buildIndex(opts);

    const entries = (await loadIndex(indexPath))?.entries.map((entry) => `${entry.type}:${entry.filename}`).sort();
    if (row.failure === 'removed' || (row.found && row.failure === 'replaced by a file')) {
      expect(entries).toEqual(['learnings:r.md']);
      expect(warnings()).toEqual([]);
      return;
    }
    expect(entries).toEqual([row.id, 'learnings:r.md'].sort());
    // With its parent locked, a found directory cannot be seen, so the parent is what is named.
    const named = row.found && row.failure === 'parent chmod 000' ? path.dirname(broken) : broken;
    const reason = row.failure === 'replaced by a file' ? 'ENOTDIR' : 'EACCES';
    expect(warnings()).toEqual([expect.stringMatching(/^Search index could not read \d+ path\(s\) \(/)]);
    expect(warnings()[0]).toContain(`${named}: ${reason}`);
  });

  it.skipIf(!chmodApplies)('rebuilds without vote counts when the votes cannot be listed', async () => {
    const learnings = path.join(tmpDir, 'learnings');
    const votesDir = path.join(tmpDir, 'votes');
    await fse.outputFile(path.join(learnings, 'b.md'), doc('b'));
    await fse.outputFile(path.join(votesDir, 'alice.yaml'), 'version: 2\nvotes:\n  b:\n    recalled_count: 0\n    upvoted_count: 2\n    last_recalled_at: ""\n');
    await buildIndex({ learningsDirs: [learnings], votesDir, indexPath });
    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.votes)).toEqual([2]);
    await fse.remove(path.join(learnings, 'b.md'));
    await fse.outputFile(path.join(learnings, 'r.md'), doc('r'));
    await breakPath(votesDir, 'chmod 000');

    await buildIndex({ learningsDirs: [learnings], votesDir, indexPath });

    expect((await loadIndex(indexPath))?.entries.map((entry) => entry.filename)).toEqual(['r.md']);
    expect(warnings()).toEqual([
      `Search index could not read the votes in ${votesDir} (EACCES); it ranks without them until the next rebuild.`,
    ]);
  });
});

/**
 * A previous entry is put back only where a fresh read would put it: its path
 * is still selected (root-level learnings and active namespaces, delivered
 * docs, rules and skills), and it takes the precedence slot of its source,
 * not whichever copy was collected first (#1006).
 */
describe('buildIndex puts a previous entry back only where a fresh read would (#1006)', () => {
  let tmpDir: string;
  let indexPath: string;
  let locked: string[];
  const doc = (title: string): string => `---\ntitle: ${title}\n---\nbody`;
  const skill = (name: string): string => `---\nname: ${name}\ndescription: ${name}\n---\nbody`;
  const chmodApplies = process.platform !== 'win32' && process.getuid?.() !== 0;
  const w = (rel: string): string => path.join(tmpDir, rel);
  const lock = async (rel: string): Promise<void> => {
    await fse.chmod(w(rel), 0o000);
    locked.push(w(rel));
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-index-kept-'));
    indexPath = path.join(tmpDir, 'search-index.json');
    locked = [];
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    for (const p of locked.reverse()) await fse.chmod(p, 0o755);
    await fse.remove(tmpDir);
  });

  interface Row {
    readonly name: string;
    readonly chmod?: boolean;
    readonly symlink?: boolean;
    readonly files: Record<string, string>;
    readonly first: () => BuildIndexOptions;
    readonly change: () => Promise<void>;
    readonly second: () => BuildIndexOptions;
    /** `type:filename@path relative to the test directory`. */
    readonly expected: readonly string[];
  }
  const rows: readonly Row[] = [
    {
      name: 'selection: learnings root unlistable, namespace A no longer active',
      chmod: true,
      files: { 'pub/root.md': doc('root'), 'pub/A/secret.md': doc('secret'), 'pub/B/b.md': doc('b') },
      first: () => ({ learningsDirs: [w('pub')], learningsNamespaces: ['A', 'B'], indexPath }),
      change: () => lock('pub'),
      second: () => ({ learningsDirs: [w('pub')], learningsNamespaces: ['B'], indexPath }),
      expected: ['learnings:root.md@pub/root.md', 'learnings:B/b.md@pub/B/b.md'],
    },
    {
      name: 'selection: learnings root given unreadable, namespace A no longer active',
      files: { 'pub/root.md': doc('root'), 'pub/A/secret.md': doc('secret'), 'pub/B/b.md': doc('b') },
      first: () => ({ learningsDirs: [w('pub')], learningsNamespaces: ['A', 'B'], indexPath }),
      change: () => fse.outputFile(w('pub/new.md'), doc('new')),
      second: () => ({
        learningsDirs: [w('pub')], learningsNamespaces: ['B'], indexPath,
        unreadable: [{ path: w('pub'), reason: 'owner unknown' }],
      }),
      expected: ['learnings:root.md@pub/root.md', 'learnings:B/b.md@pub/B/b.md'],
    },
    {
      name: 'selection: listed docs unreadable, b.md no longer delivered',
      files: { 'docs/a.md': doc('a'), 'docs/b.md': doc('b') },
      first: () => ({ docsDir: w('docs'), docFiles: ['a.md', 'b.md'], indexPath }),
      change: async () => { await fse.remove(w('docs/a.md')); await fse.remove(w('docs/b.md')); },
      second: () => ({ docsDir: w('docs'), docFiles: ['a.md'], indexPath }),
      expected: ['docs:a.md@docs/a.md'],
    },
    {
      name: 'selection: docs given unreadable, nothing under them read',
      files: { 'docs/a.md': doc('a') },
      first: () => ({ docsDir: w('docs'), docFiles: ['a.md'], indexPath }),
      change: () => fse.outputFile(w('docs/new.md'), doc('new')),
      second: () => ({ docsDir: w('docs'), indexPath, unreadable: [{ path: w('docs'), reason: 'manifest' }] }),
      expected: ['docs:a.md@docs/a.md'],
    },
    {
      name: 'selection: listed rules unreadable, b.md no longer delivered',
      files: { 'rules/a.md': doc('a'), 'rules/b.md': doc('b') },
      first: () => ({ rulesDir: w('rules'), ruleFiles: ['a.md', 'b.md'], indexPath }),
      change: async () => { await fse.remove(w('rules/a.md')); await fse.remove(w('rules/b.md')); },
      second: () => ({ rulesDir: w('rules'), ruleFiles: ['a.md'], indexPath }),
      expected: ['rules:a.md@rules/a.md'],
    },
    {
      name: 'selection: delivered skills unreadable, y no longer delivered',
      files: { 'skills/x/SKILL.md': skill('x'), 'skills/y/SKILL.md': skill('y') },
      first: () => ({ skills: { kind: 'dirs', dirs: [w('skills/x'), w('skills/y')] }, indexPath }),
      change: async () => { await fse.remove(w('skills/x/SKILL.md')); await fse.remove(w('skills/y/SKILL.md')); },
      second: () => ({ skills: { kind: 'dirs', dirs: [w('skills/x')] }, indexPath }),
      expected: ['skills:x.md@skills/x/SKILL.md'],
    },
    {
      name: 'selection: walked SKILL.md a dangling symlink',
      symlink: true,
      files: { 'skills/ns/x/SKILL.md': skill('x') },
      first: () => ({ skillsDir: w('skills'), indexPath }),
      change: async () => {
        await fse.remove(w('skills/ns/x/SKILL.md'));
        await fse.symlink(w('skills/ns/x/missing.md'), w('skills/ns/x/SKILL.md'));
      },
      second: () => ({ skillsDir: w('skills'), indexPath }),
      expected: ['skills:x.md@skills/ns/x/SKILL.md'],
    },
    {
      name: 'precedence: queued learning unreadable over a readable published copy',
      chmod: true,
      files: { 'queue/note.md': doc('queued'), 'pub/note.md': doc('published') },
      first: () => ({ learningsDirs: [w('queue'), w('pub')], indexPath }),
      change: () => lock('queue/note.md'),
      second: () => ({ learningsDirs: [w('queue'), w('pub')], indexPath }),
      expected: ['learnings:note.md@queue/note.md'],
    },
    {
      name: 'precedence: queue unlistable over a readable published copy',
      chmod: true,
      files: { 'queue/note.md': doc('queued'), 'pub/note.md': doc('published') },
      first: () => ({ learningsDirs: [w('queue'), w('pub')], indexPath }),
      change: () => lock('queue'),
      second: () => ({ learningsDirs: [w('queue'), w('pub')], indexPath }),
      expected: ['learnings:note.md@queue/note.md'],
    },
    {
      name: 'precedence: first of two same-named skills unreadable',
      files: { 'skills/a/foo/SKILL.md': skill('foo'), 'skills/b/foo/SKILL.md': skill('foo') },
      first: () => ({ skills: { kind: 'dirs', dirs: [w('skills/a/foo'), w('skills/b/foo')] }, indexPath }),
      change: () => fse.remove(w('skills/a/foo/SKILL.md')),
      second: () => ({ skills: { kind: 'dirs', dirs: [w('skills/a/foo'), w('skills/b/foo')] }, indexPath }),
      expected: ['skills:foo.md@skills/a/foo/SKILL.md', 'skills:foo.md@skills/b/foo/SKILL.md'],
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    if (row.chmod && !chmodApplies) return;
    if (row.symlink && process.platform === 'win32') return;
    for (const [rel, content] of Object.entries(row.files)) await fse.outputFile(w(rel), content);
    await buildIndex(row.first());
    await row.change();

    await buildIndex(row.second());

    const posix = (p: string): string => p.replaceAll(path.sep, '/');
    const entries = (await loadIndex(indexPath))?.entries
      .map((entry) => `${entry.type}:${posix(entry.filename)}@${posix(path.relative(tmpDir, entry.path ?? ''))}`).sort();
    expect(entries).toEqual([...row.expected].sort());
  });
});
