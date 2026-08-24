import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredBranch, cleanupOrphanSkills, recordInstalledSkills } from '../utils/branch-manager.js';

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-branch-'));
}

function configFor(root: string, branch?: string) {
  return { repo: { localPath: path.join(root, 'team-repo'), kind: 'git', branch } };
}

describe('configuredBranch', () => {
  it('returns null when branch is unset', () => {
    expect(configuredBranch(configFor('/x'))).toBeNull();
    expect(configuredBranch(configFor('/x', '  '))).toBeNull();
  });
  it('returns the branch for git kind', () => {
    expect(configuredBranch(configFor('/x', 'develop/vdr-gps'))).toBe('develop/vdr-gps');
  });
  it('returns null for self and http kinds', () => {
    expect(configuredBranch({ repo: { localPath: '/x', kind: 'self', branch: 'b' } })).toBeNull();
    expect(configuredBranch({ repo: { localPath: '/x', kind: 'http', branch: 'b' } })).toBeNull();
  });
});

describe('ledger orphan cleanup', () => {
  it('removes ledger entries absent from the current install set', () => {
    const root = tmpProject();
    const skillA = path.join(root, 'claude-skills', 'skill-a');
    const skillB = path.join(root, 'claude-skills', 'skill-b');
    fs.mkdirSync(skillA, { recursive: true });
    fs.mkdirSync(skillB, { recursive: true });
    const cfg = configFor(root, 'develop/x');
    recordInstalledSkills(cfg, [
      { tool: 'claude', name: 'skill-a', dir: skillA },
      { tool: 'claude', name: 'skill-b', dir: skillB },
    ]);
    // Next branch keeps only skill-a.
    const removed = cleanupOrphanSkills(cfg, [
      { tool: 'claude', name: 'skill-a', dir: skillA },
    ]);
    expect(removed).toBe(1);
    expect(fs.existsSync(skillB)).toBe(false);
    expect(fs.existsSync(skillA)).toBe(true);
  });

  it('never touches directories not recorded in the ledger', () => {
    const root = tmpProject();
    const personal = path.join(root, 'claude-skills', 'my-own-skill');
    fs.mkdirSync(personal, { recursive: true });
    const cfg = configFor(root, 'develop/x');
    // Empty ledger → nothing eligible for removal.
    const removed = cleanupOrphanSkills(cfg, []);
    expect(removed).toBe(0);
    expect(fs.existsSync(personal)).toBe(true);
  });
});
