import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, assertSafeResourceName, defaultAllowedRoots } from '../utils/path-safety.js';

describe('assertSafePath', () => {
  const home = os.homedir();
  const cwd = process.cwd();

  it('allows a path inside home directory', () => {
    expect(() => assertSafePath(path.join(home, '.teamai', 'file.md'), [home])).not.toThrow();
  });

  it('allows a path equal to the allowed root', () => {
    expect(() => assertSafePath(home, [home])).not.toThrow();
  });

  it('allows a path inside cwd', () => {
    expect(() => assertSafePath(path.join(cwd, 'src', 'file.ts'), [cwd])).not.toThrow();
  });

  it('throws for a path outside all allowed roots', () => {
    expect(() => assertSafePath('/etc/passwd', [home, cwd])).toThrow('Path traversal detected');
  });

  it('throws for /tmp when not in allowedRoots', () => {
    expect(() => assertSafePath('/tmp/evil', [home])).toThrow('Path traversal detected');
  });

  it('does not allow sibling path confusion (prefix-only check)', () => {
    // e.g., /home/userX should not be allowed when root is /home/user
    const root = path.join(home, 'safe-dir');
    const tricky = home + '-malicious/file.txt';
    expect(() => assertSafePath(tricky, [root])).toThrow('Path traversal detected');
  });
});

describe('defaultAllowedRoots', () => {
  it('returns cwd and homedir', () => {
    const roots = defaultAllowedRoots();
    expect(roots).toContain(process.cwd());
    expect(roots).toContain(os.homedir());
  });
});

describe('assertSafeResourceName', () => {
  // ── 合法名称 ─────────────────────────────────────────────────
  it('accepts a simple skill name', () => {
    expect(() => assertSafeResourceName('my-skill')).not.toThrow();
  });

  it('accepts name with dots and underscores mixed', () => {
    expect(() => assertSafeResourceName('a.b_c-1')).not.toThrow();
  });

  it('accepts a single character', () => {
    expect(() => assertSafeResourceName('a')).not.toThrow();
  });

  // ── 路径遍历拒绝 ──────────────────────────────────────────────
  it('rejects path traversal "../etc"', () => {
    expect(() => assertSafeResourceName('../etc')).toThrow('Invalid resource name');
  });

  it('rejects double dot ".."', () => {
    expect(() => assertSafeResourceName('..')).toThrow('Invalid resource name');
  });

  it('rejects single dot "."', () => {
    expect(() => assertSafeResourceName('.')).toThrow('Invalid resource name');
  });

  it('rejects empty string', () => {
    expect(() => assertSafeResourceName('')).toThrow('Invalid resource name');
  });

  it('rejects name with forward slash "a/b"', () => {
    expect(() => assertSafeResourceName('a/b')).toThrow('Invalid resource name');
  });

  it('rejects name with backslash "a\\\\b"', () => {
    expect(() => assertSafeResourceName('a\\b')).toThrow('Invalid resource name');
  });

  // ── URL 编码绕过拒绝 ──────────────────────────────────────────
  it('rejects percent-encoded double dot "%2e%2e"', () => {
    expect(() => assertSafeResourceName('%2e%2e')).toThrow('Invalid resource name');
  });

  it('rejects percent-encoded slash "%2fetc"', () => {
    expect(() => assertSafeResourceName('%2fetc')).toThrow('Invalid resource name');
  });

  // ── 特殊字符拒绝 ──────────────────────────────────────────────
  it('rejects name with null byte', () => {
    expect(() => assertSafeResourceName('a\0b')).toThrow('Invalid resource name');
  });

  it('rejects name longer than 64 characters', () => {
    const long = 'a'.repeat(65);
    expect(() => assertSafeResourceName(long)).toThrow('Invalid resource name');
  });

  it('rejects name containing Chinese characters', () => {
    expect(() => assertSafeResourceName('技能')).toThrow('Invalid resource name');
  });

  it('rejects name containing spaces', () => {
    expect(() => assertSafeResourceName('my skill')).toThrow('Invalid resource name');
  });

  it('rejects absolute path "/abs"', () => {
    expect(() => assertSafeResourceName('/abs')).toThrow('Invalid resource name');
  });

  // ── 非法 percent-encoding 拒绝 ────────────────────────────────
  it('rejects malformed percent-encoding like "%E0%A4%A"', () => {
    expect(() => assertSafeResourceName('%E0%A4%A')).toThrow('Invalid resource name');
  });
});
