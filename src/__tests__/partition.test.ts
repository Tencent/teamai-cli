import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import fse from 'fs-extra';
import YAML from 'yaml';
import {
  projectSlug,
  legacyProjectSlug,
  projectDataHome,
  resolvePartitionDir,
  isCaseInsensitiveFs,
  resetCaseProbeCache,
} from '../utils/partition.js';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetCaseProbeCache();
  vi.restoreAllMocks();
});

describe('projectSlug / projectDataHome (issue #374 partition identity)', () => {
  it('is deterministic for the same anchor', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // force case-sensitive
    const a = projectSlug('/Users/x/Project/teamai-cli');
    const b = projectSlug('/Users/x/Project/teamai-cli');
    expect(a).toBe(b);
    expect(a).toMatch(/^Users-x-Project-teamai-cli-[0-9a-f]{16}$/);
  });

  it('prefix reads back to the full project path (Claude-style readability)', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // force case-sensitive
    const slug = projectSlug('/Users/x/Project/teamai-cli');
    // The whole path is encoded (leading '/' dropped, separators → '-'), not
    // just the basename — the directory name says which project it belongs to.
    expect(slug.startsWith('Users-x-Project-teamai-cli-')).toBe(true);
  });

  it('does NOT collide for escape-ambiguous paths (/x/my-proj vs /x/my/proj)', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    // A raw separator→'-' escape would map both to the same string; the hash
    // must keep them distinct.
    expect(projectSlug('/x/my-proj')).not.toBe(projectSlug('/x/my/proj'));
  });

  it('distinguishes two projects sharing a basename by full path + hash', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const a = projectSlug('/work/a/teamai-cli');
    const b = projectSlug('/work/b/teamai-cli');
    expect(a).not.toBe(b);
    // The full path is in the prefix, so the parent dir already tells them apart.
    expect(a.startsWith('work-a-teamai-cli-')).toBe(true);
    expect(b.startsWith('work-b-teamai-cli-')).toBe(true);
    // …and the hash suffixes still differ as a second guarantee.
    expect(a.split('-').pop()).not.toBe(b.split('-').pop());
  });

  it('case-insensitive FS: different spellings of one dir map to the SAME slug', () => {
    resetCaseProbeCache();
    // Simulate a case-insensitive FS: the lowercase probe path "exists".
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as unknown as string);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'rmSync').mockReturnValue(undefined);
    expect(isCaseInsensitiveFs()).toBe(true);
    expect(projectSlug('/Users/X/Project/CaseTest')).toBe(projectSlug('/users/x/project/casetest'));
  });

  it('case-sensitive FS: different spellings map to DIFFERENT slugs', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // probe file not found → case-sensitive
    expect(isCaseInsensitiveFs()).toBe(false);
    expect(projectSlug('/work/CaseTest')).not.toBe(projectSlug('/work/casetest'));
  });

  it('uses a 64-bit (16 hex) digest suffix, not 32-bit', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const slug = projectSlug('/work/proj');
    const hex = slug.split('-').pop() ?? '';
    // 32-bit (8 hex) is cheaply collidable; require the widened suffix.
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });

  it('bounds an overlong path prefix while the hash keeps it unique', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const deep = '/' + Array.from({ length: 40 }, (_, i) => `segment${i}`).join('/');
    const slug = projectSlug(deep);
    // The whole slug (prefix + '-' + 16 hex) must stay well under NAME_MAX (255).
    expect(slug.length).toBeLessThanOrEqual(200);
    // Two long paths sharing a truncated head still resolve to distinct slugs.
    expect(projectSlug(deep + '/alpha')).not.toBe(projectSlug(deep + '/beta'));
  });

  it('projectDataHome roots under ~/.teamai/projects/<slug>', () => {
    process.env.HOME = '/home/alice';
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const home = projectDataHome('/work/proj');
    expect(home).toBe(path.join('/home/alice', '.teamai', 'projects', projectSlug('/work/proj')));
  });

  it('real-FS probe runs without throwing and yields a stable boolean', () => {
    resetCaseProbeCache();
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-probe-'));
    const first = isCaseInsensitiveFs(probeDir);
    const second = isCaseInsensitiveFs(probeDir); // cached
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
    fs.rmSync(probeDir, { recursive: true, force: true });
  });
});

describe('legacyProjectSlug (pre-#546 partition naming)', () => {
  it('keeps the old <basename>-<hash> format and shares the hash with the current slug', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // force case-sensitive
    const legacy = legacyProjectSlug('/Users/x/Project/teamai-cli');
    expect(legacy).toMatch(/^teamai-cli-[0-9a-f]{16}$/);
    // Same hash suffix — this shared suffix is what makes rename-based
    // adoption of a legacy partition exact (same anchor, same digest).
    expect(legacy.split('-').pop()).toBe(projectSlug('/Users/x/Project/teamai-cli').split('-').pop());
    // …while the current slug differs (whole-path prefix).
    expect(legacy).not.toBe(projectSlug('/Users/x/Project/teamai-cli'));
  });

  it('folds the basename like the pre-#546 implementation (cleaned, bounded to 40)', () => {
    resetCaseProbeCache();
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const longName = 'x'.repeat(60);
    const legacy = legacyProjectSlug(`/work/${longName}`);
    expect(legacy).toMatch(/^x{40}-[0-9a-f]{16}$/);
  });
});

describe('resolvePartitionDir (legacy partition adoption)', () => {
  let base: string;
  let home: string;
  let anchor: string;

  const projectsRoot = () => path.join(home, '.teamai', 'projects');
  const canonical = () => path.join(projectsRoot(), projectSlug(anchor));
  const legacy = () => path.join(projectsRoot(), legacyProjectSlug(anchor));

  beforeEach(() => {
    base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-adopt-')));
    home = path.join(base, 'home');
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    anchor = path.join(base, 'project');
    fs.mkdirSync(anchor, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('returns the canonical path for a fresh install (pure resolution, no mkdir)', async () => {
    const dir = await resolvePartitionDir(anchor);
    expect(dir).toBe(canonical());
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('adopts a legacy-named partition by renaming it under the current name', async () => {
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.yaml'), 'repo: {}\n');
    fs.writeFileSync(path.join(legacy(), 'env.local'), 'TOKEN=s3cret\n');

    const dir = await resolvePartitionDir(anchor);

    expect(dir).toBe(canonical());
    expect(fs.existsSync(legacy())).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')).toBe('repo: {}\n');
    expect(fs.readFileSync(path.join(dir, 'env.local'), 'utf-8')).toBe('TOKEN=s3cret\n');
  });

  it('keeps an authoritative canonical partition and leaves a leftover legacy dir alone', async () => {
    fs.mkdirSync(canonical(), { recursive: true });
    fs.writeFileSync(path.join(canonical(), 'config.yaml'), 'authoritative\n');
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.yaml'), 'stale\n');

    const dir = await resolvePartitionDir(anchor);

    expect(dir).toBe(canonical());
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')).toBe('authoritative\n');
    // Never clobber the authoritative partition; the stale dir stays for
    // `status --all` / manual cleanup (same rule as migration).
    expect(fs.readFileSync(path.join(legacy(), 'config.yaml'), 'utf-8')).toBe('stale\n');
  });

  it('replaces an empty canonical leftover with the full legacy partition', async () => {
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.yaml'), 'real\n');
    fs.mkdirSync(canonical(), { recursive: true }); // bare mkdir from a crashed init

    const dir = await resolvePartitionDir(anchor);

    expect(dir).toBe(canonical());
    expect(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')).toBe('real\n');
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('is idempotent: a resolve after adoption lands on the canonical dir', async () => {
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'state.json'), '{}\n');

    await resolvePartitionDir(anchor);
    const again = await resolvePartitionDir(anchor);

    expect(again).toBe(canonical());
    expect(fs.existsSync(path.join(canonical(), 'state.json'))).toBe(true);
    expect(fs.existsSync(legacy())).toBe(false);
  });

  it('rebases repo.localPath off the legacy dir so pull can still find the team clone', async () => {
    // The team-repo clone was stored as an ABSOLUTE path inside the legacy dir.
    // A bare rename would leave config.yaml pointing at a now-gone path and every
    // later `pull` would silently skip the sync ("Team config not found", exit 0).
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(
      path.join(legacy(), 'config.yaml'),
      YAML.stringify({
        repo: { localPath: path.join(legacy(), 'team-repo'), remote: 'https://x', kind: 'git' },
        username: 'a', scope: 'project', projectRoot: anchor, additionalRoles: [],
      }),
    );

    const dir = await resolvePartitionDir(anchor);

    expect(dir).toBe(canonical());
    const doc = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8'));
    // localPath now points inside the NEW partition, and that path exists.
    expect(doc.repo.localPath).toBe(path.join(canonical(), 'team-repo'));
    // Other fields survive the YAML round-trip untouched.
    expect(doc.repo.remote).toBe('https://x');
    expect(doc.username).toBe('a');
  });

  it('leaves an external repo.localPath (outside the legacy dir) untouched', async () => {
    const external = path.join(base, 'elsewhere', 'team-repo');
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(
      path.join(legacy(), 'config.yaml'),
      YAML.stringify({ repo: { localPath: external, remote: 'https://x', kind: 'git' } }),
    );

    const dir = await resolvePartitionDir(anchor);

    const doc = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8'));
    expect(doc.repo.localPath).toBe(external); // not inside legacyDir → left alone
  });

  it('is a no-op on a modern install whose localPath is already in the canonical dir', async () => {
    // Fresh (current-format) partition; resolve must not rewrite anything.
    fs.mkdirSync(canonical(), { recursive: true });
    const yaml = YAML.stringify({
      repo: { localPath: path.join(canonical(), 'team-repo'), remote: 'https://x', kind: 'git' },
    });
    fs.writeFileSync(path.join(canonical(), 'config.yaml'), yaml);

    const dir = await resolvePartitionDir(anchor);

    expect(dir).toBe(canonical());
    expect(fs.readFileSync(path.join(canonical(), 'config.yaml'), 'utf-8')).toBe(yaml);
  });

  it('preserves config.yaml intact when the localPath rewrite fails mid-write (atomic)', async () => {
    // The legacy source is already renamed away, so config.yaml is the only copy.
    // A partial overwrite (ENOSPC/EFBIG/crash) must never truncate it — the write
    // is atomic (same-dir temp + rename), so a failed write leaves the original.
    const original = YAML.stringify({
      repo: { localPath: path.join(legacy(), 'team-repo'), remote: 'https://x', kind: 'git' },
      username: 'a', scope: 'project', projectRoot: anchor, additionalRoles: [],
    });
    fs.mkdirSync(legacy(), { recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.yaml'), original);

    // Fail the temp-file write the atomic writer performs (simulates EFBIG).
    const spy = vi.spyOn(fse, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' }) as never,
    );

    // The adoption rename still happens; only the config rewrite fails and rethrows.
    await expect(resolvePartitionDir(anchor)).rejects.toThrow(/EFBIG/);
    spy.mockRestore();

    // config.yaml survived byte-for-byte at the canonical location — not truncated,
    // not empty — so the next command can retry (the rebase is idempotent).
    const after = fs.readFileSync(path.join(canonical(), 'config.yaml'), 'utf-8');
    expect(after).toBe(original);
    // No temp file left behind.
    expect(fs.readdirSync(canonical()).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
