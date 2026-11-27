import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafePath, assertSafeResourceName, assertWithinRoot, defaultAllowedRoots } from '../utils/path-safety.js';
import { trySymlink } from './helpers/symlink.js';

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

describe('assertSafePath with a symlinked root', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-path-safety-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('allows a missing child under a root reached through a symlink', () => {
    // macOS reaches tmpdirs as /var/... but they resolve to /private/var/...;
    // the missing child must come back in the same form as the existing root.
    const real = path.join(base, 'real');
    const link = path.join(base, 'link');
    fs.mkdirSync(real);
    if (!trySymlink(real, link)) return;
    expect(() => assertSafePath(path.join(link, 'missing.mjs'), [link])).not.toThrow();
  });

  it('still rejects a missing leaf reached through a symlink that escapes the root', () => {
    const real = path.join(base, 'real');
    const escape = path.join(base, 'escape');
    fs.mkdirSync(real);
    fs.mkdirSync(escape);
    if (!trySymlink(escape, path.join(real, 'out-link'))) return;
    expect(() => assertSafePath(path.join(real, 'out-link', 'file.mjs'), [real])).toThrow(
      'Path traversal detected',
    );
  });
});

describe('containment guards across host path semantics', () => {
  it('allows the same file spelled with a differently cased drive letter', () => {
    if (process.platform !== 'win32') return;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-path-case-'));
    try {
      const child = path.join(base, 'note.md');
      fs.writeFileSync(child, 'note');
      const otherCasing = child.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());

      expect(() => assertSafePath(otherCasing, [base])).not.toThrow();
      expect(() => assertWithinRoot(base, otherCasing)).not.toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('allows anything under the filesystem root', () => {
    // `path.sep` appended to `C:\` or `/` would match no child at all.
    const root = path.parse(process.cwd()).root;
    const child = path.join(root, 'teamai-path-safety-probe');

    expect(() => assertSafePath(child, [root])).not.toThrow();
    expect(() => assertWithinRoot(root, child)).not.toThrow();
  });

  it('still rejects a sibling that only shares the root as a string prefix', () => {
    const base = path.join(os.tmpdir(), 'teamai-path-prefix');
    expect(() => assertWithinRoot(base, `${base}-other/file.md`)).toThrow('path traversal detected');
    expect(() => assertSafePath(`${base}-other/file.md`, [base])).toThrow('Path traversal detected');
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
