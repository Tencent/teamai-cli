import { describe, it, expect } from 'vitest';
import { resolveInheritUserScope, resolveInitScope, resolveInitRepo } from '../init.js';

describe('resolveInitScope', () => {
  const cwd = '/tmp/my-project';
  const home = '/home/alice';

  it('defaults to project with projectRoot = cwd when scope is omitted', () => {
    const result = resolveInitScope(undefined, cwd, home);
    expect(result).toEqual({
      scope: 'project',
      projectRoot: cwd,
      explicit: false,
    });
  });

  it('uses user scope when --scope user is explicit', () => {
    const result = resolveInitScope('user', cwd, home);
    expect(result).toEqual({
      scope: 'user',
      projectRoot: undefined,
      explicit: true,
    });
  });

  it('uses project scope when --scope project is explicit', () => {
    const result = resolveInitScope('project', cwd, home);
    expect(result).toEqual({
      scope: 'project',
      projectRoot: cwd,
      explicit: true,
    });
  });

  it('throws on invalid scope values', () => {
    expect(() => resolveInitScope('global', cwd, home)).toThrow(/Invalid scope "global"/);
    expect(() => resolveInitScope('workspace', cwd, home)).toThrow(/Invalid scope/);
  });

  it('falls back to user when cwd === home and scope is implicit (E1)', () => {
    const result = resolveInitScope(undefined, home, home);
    expect(result.scope).toBe('user');
    expect(result.projectRoot).toBeUndefined();
    expect(result.explicit).toBe(false);
    expect(result.fallbackReason).toMatch(/home directory/);
  });

  it('treats symlink-equivalent cwd/home as the same path (macOS /var vs /private/var)', () => {
    // Use the real process HOME/tmpdir pair when they resolve to the same inode
    // via realpath; otherwise simulate with identical logical paths.
    const result = resolveInitScope(undefined, '/tmp', '/tmp');
    // /tmp may realpath to /private/tmp on macOS — both args go through realpath
    expect(result.scope).toBe('user');
    expect(result.fallbackReason).toMatch(/home directory/);
  });

  it('throws when --scope project is explicit and cwd === home (E1)', () => {
    expect(() => resolveInitScope('project', home, home)).toThrow(
      /Cannot use --scope project in your home directory/,
    );
  });

  it('allows explicit --scope user when cwd === home', () => {
    const result = resolveInitScope('user', home, home);
    expect(result).toEqual({
      scope: 'user',
      projectRoot: undefined,
      explicit: true,
    });
  });
});

describe('resolveInheritUserScope', () => {
  it('enables inheritance only for project scope', () => {
    expect(resolveInheritUserScope('project', true, undefined)).toBe(true);
    expect(() => resolveInheritUserScope('user', true, undefined)).toThrow(
      /only be used with project scope/,
    );
  });

  it('preserves an existing project setting when the flag is omitted', () => {
    expect(resolveInheritUserScope('project', undefined, true)).toBe(true);
    expect(resolveInheritUserScope('project', undefined, false)).toBe(false);
  });

  it('allows an explicit disable and ignores the setting for user scope', () => {
    expect(resolveInheritUserScope('project', false, true)).toBe(false);
    expect(resolveInheritUserScope('user', false, true)).toBeUndefined();
  });
});

describe('resolveInitRepo', () => {
  it('uses positional when only positional is set', () => {
    expect(resolveInitRepo('owner/repo', undefined)).toBe('owner/repo');
  });

  it('uses --repo when only --repo is set (no deprecation)', () => {
    expect(resolveInitRepo(undefined, 'owner/repo')).toBe('owner/repo');
  });

  it('accepts identical positional and --repo', () => {
    expect(resolveInitRepo('owner/repo', 'owner/repo')).toBe('owner/repo');
  });

  it('throws when positional and --repo conflict', () => {
    expect(() => resolveInitRepo('a/b', 'c/d')).toThrow(/Conflicting repo values/);
  });

  it('returns undefined when neither is set', () => {
    expect(resolveInitRepo(undefined, undefined)).toBeUndefined();
    expect(resolveInitRepo('', '  ')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(resolveInitRepo('  owner/repo  ', undefined)).toBe('owner/repo');
    expect(resolveInitRepo(undefined, '  owner/repo  ')).toBe('owner/repo');
  });
});
