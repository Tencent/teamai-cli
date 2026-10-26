import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The isolated home's .gitconfig must actually reach git. The setup file
// writes gc.auto=0 and maintenance.auto=false so that no commit, fetch or
// push leaves a detached `git gc --auto` / `git maintenance run --auto`
// writing into `.git/objects/` after the test returns — the writer that
// turned teardowns into ENOTEMPTY under CI parallel load (#1413). Asserting
// only the file's text would pass while git reads some other config, so git
// itself is asked, both at the global level and from a fresh repo.
describe('isolate-home gitconfig (#1413)', () => {
  it('turns git background upkeep off for the isolated home', () => {
    // Fails at this assertion on a base without the setup file's gitconfig,
    // not on the read, so the gap is named.
    const file = path.join(process.env.HOME!, '.gitconfig');
    expect(fs.existsSync(file), `no .gitconfig in the isolated home ${process.env.HOME}`).toBe(true);
    const config = fs.readFileSync(file, 'utf-8');
    expect(config).toContain('[gc]');
    expect(config).toContain('auto = 0');
    expect(config).toContain('[maintenance]');

    expect(execFileSync('git', ['config', '--global', '--get', 'gc.auto'], { encoding: 'utf-8' }).trim()).toBe('0');
    expect(execFileSync('git', ['config', '--global', '--get', 'maintenance.auto'], { encoding: 'utf-8' }).trim()).toBe('false');
  });

  it('a fresh repo under this home inherits the off-switch', () => {
    // Under process.env.TMPDIR so the setup file's afterAll removes it.
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'teamai-gitconfig-1413-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      expect(execFileSync('git', ['config', 'gc.auto'], { cwd: repo, encoding: 'utf-8' }).trim()).toBe('0');
      expect(execFileSync('git', ['config', 'maintenance.auto'], { cwd: repo, encoding: 'utf-8' }).trim()).toBe('false');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
