import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeCwdCodeBuddy } from '../session-flow/fs.js';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, resolve: vi.fn(actual.resolve) };
});

afterEach(() => vi.restoreAllMocks());

describe('CodeBuddy and WorkBuddy native project directory encoding', () => {
  it.each([
    ['C:\\Work\\my project', 'C-Work-my project'],
    ['D:/Work/team.ai_dev', 'D-Work-team.ai_dev'],
    ['C:\\Work\\my--project', 'C-Work-my-project'],
  ])('keeps the Windows drive in %s', (cwd, expected) => {
    vi.mocked(path.resolve).mockImplementation(path.win32.resolve);
    expect(encodeCwdCodeBuddy(cwd)).toBe(expected);
  });

  it('keeps POSIX spaces and punctuation', () => {
    vi.mocked(path.resolve).mockImplementation(path.posix.resolve);
    expect(encodeCwdCodeBuddy('/nonexistent-teamai/work space/team.ai_dev')).toBe('nonexistent-teamai-work space-team.ai_dev');
  });
});

// Fixed vectors evaluated with compressWorkspacePathName from the publisher's
// @tencent-ai/codebuddy-code@2.173.0 bundle (cli.js), not TeamAI's encoder.
describe('CodeBuddy long project directory names', () => {
  it.each([
    ['255 ASCII bytes', '/' + 'a'.repeat(255), 'a'.repeat(255)],
    ['256 ASCII bytes', '/' + 'a'.repeat(256), 'a'.repeat(180) + '-77f405'],
    ['multibyte cutoff', '/' + '界'.repeat(90), '界'.repeat(60) + '-mfc5vp'],
    ['code point cutoff', '/' + 'a'.repeat(178) + '😀' + 'b'.repeat(80), 'a'.repeat(178) + '-fxv6qa'],
    ['distinct suffix', '/' + 'a'.repeat(255) + 'b', 'a'.repeat(180) + '-77f406'],
    ['Windows long path', 'C:\\' + 'work\\'.repeat(60) + 'project', 'C-' + 'work-'.repeat(35) + 'wor-1larcam'],
  ])('%s matches the native byte limit and hash', (_name, cwd, expected) => {
    vi.mocked(path.resolve).mockImplementation(cwd.startsWith('C:') ? path.win32.resolve : path.posix.resolve);
    expect(encodeCwdCodeBuddy(cwd)).toBe(expected);
    expect(Buffer.byteLength(expected, 'utf8')).toBeLessThanOrEqual(255);
  });
});
