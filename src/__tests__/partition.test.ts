import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { projectSlug, projectDataHome, isCaseInsensitiveFs, resetCaseProbeCache } from '../utils/partition.js';

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
