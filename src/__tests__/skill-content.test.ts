import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILL_DIR_PLACEHOLDER,
  listServableSkills,
  packagedSkillRoots,
  renderSkill,
  resolveServableSkill,
  skillCatalog,
  skillGet,
  skillPath,
  type PackagedSkill,
  type PackagedSkillRoots,
} from '../skill-content.js';
import { readSkillDescription } from '../agent-skills.js';
import { listFilesRecursive } from '../utils/fs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build a throwaway package layout: <tmp>/skills and <tmp>/skill-data. */
function makeRoots(): { tmp: string; deployRoot: string; dataRoot: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-content-'));
  return {
    tmp,
    deployRoot: path.join(tmp, 'skills'),
    dataRoot: path.join(tmp, 'skill-data'),
  };
}

function writeSkill(root: string, name: string, body: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

/** Resolve or fail the test, so the assertions below need no non-null operator. */
async function mustResolve(name: string, roots: PackagedSkillRoots): Promise<PackagedSkill> {
  const resolved = await resolveServableSkill(name, roots);
  if (resolved.kind !== 'found') throw new Error(`fixture skill not found: ${name} (${resolved.kind})`);
  return resolved.skill;
}

/** The name a resolution lands on, or null: what the alias assertions compare. */
async function resolvedName(name: string, roots: PackagedSkillRoots): Promise<string | null> {
  const resolved = await resolveServableSkill(name, roots);
  if (resolved.kind === 'not-found') return null;
  return resolved.kind === 'found' ? resolved.skill.name : resolved.name;
}

describe('packaged skill discovery', () => {
  let roots: ReturnType<typeof makeRoots>;

  beforeEach(() => {
    roots = makeRoots();
  });

  afterEach(() => {
    fs.rmSync(roots.tmp, { recursive: true, force: true });
  });

  it('serves skill-data/ when it exists', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# stub\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n');

    const servable = await listServableSkills(roots);
    expect(servable.map((s) => s.name)).toEqual(['core', 'wiki']);
    expect(servable.every((s) => s.deployed)).toBe(false);
  });

  it('serves nothing when only the deployed stub is packaged', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# hub\n');

    // A package without skill-data is broken, not a fallback to serving stubs:
    // `skill get` reports it and says to reinstall.
    expect(await listServableSkills(roots)).toEqual([]);
  });

  it('keeps the deployed stub reachable by its exact name', async () => {
    writeSkill(roots.deployRoot, 'teamai', '# stub\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');

    const stub = await mustResolve('teamai', roots);
    expect(stub.dir).toBe(path.join(roots.deployRoot, 'teamai'));
    expect(stub?.deployed).toBe(true);
  });

  it('resolves legacy directory names as aliases', async () => {
    writeSkill(roots.dataRoot, 'core', '# core\n');
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n');
    writeSkill(roots.dataRoot, 'share', '# share\n');

    for (const alias of ['wiki', 'codebase', 'team-wiki-codebase']) {
      expect(await resolvedName(alias, roots), alias).toBe('wiki');
    }
    for (const alias of ['share', 'learning', 'learnings', 'teamai-share-learnings']) {
      expect(await resolvedName(alias, roots), alias).toBe('share');
    }
    expect(await resolvedName('default', roots)).toBe('core');
    expect(await resolvedName('nope', roots)).toBeNull();
  });

  it('ignores directories without SKILL.md and dotfiles', async () => {
    fs.mkdirSync(path.join(roots.dataRoot, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(roots.dataRoot, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(roots.dataRoot, '.hidden', 'SKILL.md'), '# no\n');
    writeSkill(roots.dataRoot, 'core', '# core\n');

    expect((await listServableSkills(roots)).map((s) => s.name)).toEqual(['core']);
  });
});

describe('renderSkill', () => {
  let roots: ReturnType<typeof makeRoots>;

  beforeEach(() => {
    roots = makeRoots();
  });

  afterEach(() => {
    fs.rmSync(roots.tmp, { recursive: true, force: true });
  });

  it('prints SKILL.md unchanged, frontmatter included', async () => {
    const body = '---\nname: core\ndescription: d\n---\n\n# core\n\nbody text\n';
    writeSkill(roots.dataRoot, 'core', body);

    const skill = await mustResolve('core', roots);
    expect(await renderSkill(skill)).toBe(body);
  });

  it('appends references/ then templates/, recursively, sorted by relative path', async () => {
    writeSkill(roots.dataRoot, 'wiki', '# wiki\n', {
      'references/methodology/phase1.md': 'phase one\n',
      'references/methodology/phase0.md': 'phase zero\n',
      'references/agents/kb.md': 'kb agent\n',
      'templates/report.md': 'report\n',
    });

    const skill = await mustResolve('wiki', roots);
    const out = await renderSkill(skill, { full: true });

    expect(out).toBe(
      '# wiki\n' +
        '\n--- references/agents/kb.md ---\n\nkb agent\n' +
        '\n--- references/methodology/phase0.md ---\n\nphase zero\n' +
        '\n--- references/methodology/phase1.md ---\n\nphase one\n' +
        '\n--- templates/report.md ---\n\nreport\n',
    );
  });

  it('resolves {SKILL_DIR} to the packaged directory, in the body and in references', async () => {
    writeSkill(roots.dataRoot, 'wiki', `run python3 ${SKILL_DIR_PLACEHOLDER}/scripts/scan_repo.py\n`, {
      'references/howto.md': `see ${SKILL_DIR_PLACEHOLDER}/scripts/\n`,
    });

    const skill = await mustResolve('wiki', roots);
    const out = await renderSkill(skill, { full: true });

    expect(out).not.toContain(SKILL_DIR_PLACEHOLDER);
    expect(out).toContain(`python3 ${skill.dir}/scripts/scan_repo.py`);
    expect(out).toContain(`see ${skill.dir}/scripts/`);
  });

  it('adds a trailing newline to files that lack one', async () => {
    writeSkill(roots.dataRoot, 'core', '# core');
    const skill = await mustResolve('core', roots);
    expect(await renderSkill(skill)).toBe('# core\n');
  });
});

describe('skillCatalog', () => {
  it('reports name, description and path for each served skill', async () => {
    const roots = makeRoots();
    try {
      writeSkill(roots.dataRoot, 'core', '---\nname: core\ndescription: Daily sync\n---\n\n# core\n');
      const catalog = await skillCatalog(roots);
      expect(catalog).toEqual([
        { name: 'core', description: 'Daily sync', path: path.join(roots.dataRoot, 'core'), deployed: false, blockedBy: null },
      ]);
    } finally {
      fs.rmSync(roots.tmp, { recursive: true, force: true });
    }
  });
});

describe('teamai skill get / path against the shipped package', () => {
  let stdout: string;
  let stderr: string;
  const restore: Array<() => void> = [];

  beforeEach(() => {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.join(' ') + '\n';
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.join(' ') + '\n';
    });
    restore.push(() => writeSpy.mockRestore(), () => logSpy.mockRestore(), () => errorSpy.mockRestore());
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    process.exitCode = undefined;
  });

  it('resolves its roots inside the package', () => {
    const roots = packagedSkillRoots();
    expect(roots.deployRoot).toBe(path.join(ROOT, 'skills'));
    expect(roots.dataRoot).toBe(path.join(ROOT, 'skill-data'));
  });

  it('prints a shipped skill byte for byte, bar the resolved {SKILL_DIR}', async () => {
    const [first] = await listServableSkills();
    await skillGet([first.name]);

    const raw = fs.readFileSync(path.join(first.dir, 'SKILL.md'), 'utf8');
    expect(process.exitCode).toBeUndefined();
    expect(stderr).toBe('');
    expect(stdout).toBe(raw.split(SKILL_DIR_PLACEHOLDER).join(first.dir));
  });

  it('fails on an unknown name without writing to stdout', async () => {
    await skillGet(['no-such-skill']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Skill not found: no-such-skill');
    expect(stderr).toContain('Available:');
  });

  it('warns about an unknown flag and still serves the skill', async () => {
    const [first] = await listServableSkills();
    await skillGet(['--bogus', first.name]);

    expect(process.exitCode).toBeUndefined();
    expect(stderr).toContain('Unknown flag ignored: --bogus');
    expect(stdout).toBe(await renderSkill(first));
  });

  it('fails when no name is left after dropping flags', async () => {
    await skillGet(['--full']);

    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('No skill name provided');
  });

  it('separates multiple skills and serves them all with --all', async () => {
    // The recall gate applies to --all too (covered in skill-recall-gate.test);
    // this run's team config decides whether share is in the dump.
    const servable: PackagedSkill[] = [];
    for (const skill of await listServableSkills()) {
      const resolved = await resolveServableSkill(skill.name);
      if (resolved.kind === 'found') servable.push(resolved.skill);
    }
    await skillGet([], { all: true });

    const expected = (await Promise.all(servable.map((skill) => renderSkill(skill)))).join('\n---\n\n');
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toBe(expected);
  });

  it('prints the packaged directory of the named skill', async () => {
    const [first] = await listServableSkills();
    await skillPath(first.name);
    expect(stdout.trim()).toBe(first.dir);
    expect(fs.existsSync(path.join(stdout.trim(), 'SKILL.md'))).toBe(true);
  });

  it('fails on an unknown name for path too', async () => {
    await skillPath('no-such-skill');
    expect(process.exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Skill not found: no-such-skill');
  });
});

describe('the shipped skill-data content', () => {
  it('names every skill after its directory, and promises no permissions it cannot grant', async () => {
    for (const skill of await listServableSkills()) {
      const text = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
      // A frontmatter name that disagrees with the directory makes the skill
      // undiscoverable for the agent and unresolvable for `skill get`.
      expect(text, skill.name).toMatch(new RegExp(`^name: ${skill.name}$`, 'm'));
      // `skill get` prints this frontmatter as command output; the agent never
      // processes it as skill metadata, so an `allowed-tools` line here would
      // claim grants that do not happen. Only the deployed stub's counts.
      expect(text, skill.name).not.toMatch(/^allowed-tools:/m);
    }
  });

  it('keeps the deployed stub declaring its own name and tools', () => {
    const stub = fs.readFileSync(path.join(ROOT, 'skills/teamai/SKILL.md'), 'utf8');
    expect(stub).toMatch(/^name: teamai$/m);
    // The stub is the always-loaded unit, so it pre-approves only the read-only
    // `teamai skill …` commands it asks for. Everything else a served workflow
    // runs goes through the agent's own permission prompt.
    expect(stub).toMatch(/^allowed-tools: Bash\(teamai skill:\*\), Bash\(npx teamai-cli skill:\*\)$/m);
  });

  it('quotes {SKILL_DIR} and $(teamai skill path …) in every command it tells the agent to run', async () => {
    // The placeholder resolves to the install path, which can hold a space
    // ("Program Files", "~/Library/Application Support", a user's full name) or
    // be a Windows path used through Bash. An unquoted occurrence in a command
    // line splits into two arguments there and the documented invocation fails.
    const offenders: string[] = [];
    for (const skill of await listServableSkills()) {
      const files = [
        'SKILL.md',
        ...(await listFilesRecursive(path.join(skill.dir, 'references'))).map((f) => `references/${f}`),
      ];
      for (const relative of files) {
        if (!relative.endsWith('.md')) continue;
        const text = fs.readFileSync(path.join(skill.dir, relative), 'utf8');
        text.split('\n').forEach((line, i) => {
          // A command word followed by the bare placeholder: `python3 {SKILL_DIR}/…`.
          // Prose and reference tables name the path without running it, and a
          // quoted occurrence is already correct.
          if (/(?:^|[`\s(])(?:python3?|node|bash|sh|cp|mv|cat|ls|rm)\s+\{SKILL_DIR\}/.test(line)) {
            offenders.push(`${skill.name}/${relative}:${i + 1}: ${line.trim()}`);
          }
          // `$(teamai skill path …)` is word-split in a shell command just the
          // same, so it is always written inside double quotes.
          if (/(?<!")\$\(teamai skill path /.test(line)) {
            offenders.push(`${skill.name}/${relative}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships no Chinese text in the deployed stub or the served content', async () => {
    // Both reach the agent as CLI output (`teamai skill get` prints skill-data/),
    // which the repo rule keeps English; the agent translates for the user.
    const offenders: string[] = [];
    for (const root of ['skills', 'skill-data']) {
      for (const relative of await listFilesRecursive(path.join(ROOT, root))) {
        const text = fs.readFileSync(path.join(ROOT, root, relative), 'utf8');
        text.split('\n').forEach((line, i) => {
          if (/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(line)) offenders.push(`${root}/${relative}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the tests\' stand-in for shipped content on the paths the real digests record', async () => {
    // The prune tests mock the digest table; a path they know and the real
    // table does not (or the reverse) would test a prune that never runs.
    const { PACKAGED_SKILL_DIGESTS } = await import('../packaged-skill-digests.js');
    const { shippedSkillDigestsMock } = await import('./helpers/shipped-skills.js');
    const paths = (table: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>) =>
      Object.fromEntries([...table].map(([skill, files]) => [skill, [...files.keys()].sort()]));
    expect(paths(shippedSkillDigestsMock().PACKAGED_SKILL_DIGESTS)).toEqual(paths(PACKAGED_SKILL_DIGESTS));
  });

  it('keeps the stub description within the 1024-character budget agents load it under', async () => {
    // With one deployed skill, this description is the only text an agent sees
    // at selection time, and hosts cap it at 1024 characters.
    const description = await readSkillDescription(path.join(ROOT, 'skills/teamai/SKILL.md'));
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});

describe('npm package contents', () => {
  // The whole design fails silently when skill-data/ is missing from
  // package.json "files": every test above still passes against the repo, and
  // `skill get` serves nothing at all once installed from the registry.
  it('ships both the deployed stub and the served content', () => {
    const packed = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = (JSON.parse(packed) as Array<{ files: Array<{ path: string }> }>)[0]
      .files.map((f) => f.path);

    expect(files).toContain('skills/teamai/SKILL.md');
    for (const skill of ['core', 'share', 'wiki']) {
      expect(files.some((f) => f.startsWith(`skill-data/${skill}/`)), skill).toBe(true);
    }
    expect(files).toContain('skill-data/wiki/scripts/scan_repo.py');
    // Running the wiki scripts (the e2e suite does) leaves __pycache__ beside
    // them; "files" must not sweep interpreter bytecode into the package.
    expect(files.filter((f) => f.endsWith('.pyc') || f.includes('__pycache__'))).toEqual([]);
  }, 60_000);
});
