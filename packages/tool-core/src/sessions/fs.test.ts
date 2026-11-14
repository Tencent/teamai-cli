import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName } from './fs.js';

describe('claudeProjectDirName carried as its source', () => {
  // A fake Claude Code written as a script runs `String(claudeProjectDirName)` with nothing of this module around it.
  const copied = (cwd: string): unknown => vm.runInNewContext(`(${String(claudeProjectDirName)})(cwd)`, { cwd });

  it.each([
    ['a short cwd', '/home/user/project'],
    ['a cwd with spaces', '/Users/foo/my project'],
    ['a cwd over 200 characters, which is cut and hashed', `/home/user/${'deep/'.repeat(50)}project`],
  ])('names the project of %s as the module does', (_, cwd) => {
    expect(copied(cwd)).toBe(claudeProjectDirName(cwd));
  });
});
