import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTeamaiGitignore } from '../utils/git.js';

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitignore-'));
}

const MARKER = '# >>> teamai managed >>>';

describe('ensureTeamaiGitignore', () => {
  beforeEach(() => {
    delete process.env.TEAMAI_MANAGE_GITIGNORE;
  });
  afterEach(() => {
    delete process.env.TEAMAI_MANAGE_GITIGNORE;
  });

  it('creates .gitignore with the marker block when absent', async () => {
    const dir = tmpProject();
    const added = await ensureTeamaiGitignore(dir);
    expect(added).toBe(true);
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content).toContain(MARKER);
    expect(content).toContain('.teamai/');
    expect(content).toContain('.claude/');
    expect(content).toContain('AGENTS.md');
  });

  it('appends to an existing .gitignore without touching prior content', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\nnode_modules/\n');
    const added = await ensureTeamaiGitignore(dir);
    expect(added).toBe(true);
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content.startsWith('build/\nnode_modules/\n')).toBe(true);
    expect(content).toContain(MARKER);
  });

  it('is idempotent when the marker block already exists', async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, '.gitignore'), `build/\n${MARKER}\n.teamai/\n.claude/\nAGENTS.md\n# <<< teamai managed <<<\n`);
    const added = await ensureTeamaiGitignore(dir);
    expect(added).toBe(false);
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(content.match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1);
  });

  it('does nothing when TEAMAI_MANAGE_GITIGNORE=0', async () => {
    process.env.TEAMAI_MANAGE_GITIGNORE = '0';
    const dir = tmpProject();
    const added = await ensureTeamaiGitignore(dir);
    expect(added).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });
});
