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
