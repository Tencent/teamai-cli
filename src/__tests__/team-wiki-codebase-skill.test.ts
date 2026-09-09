import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'team-wiki-codebase');

const SKILL_FILES = [
  path.join(SKILL_DIR, 'SKILL.md'),
  path.join(SKILL_DIR, 'README.md'),
  path.join(SKILL_DIR, 'references', 'methodology', 'phase0-collection.md'),
] as const;

const FORBIDDEN_REQUIRED_COMMANDS = [
  'team-wiki compile code',
  'team-wiki reconcile',
  'team-wiki evaluate',
  'team-wiki compile docs',
  'team-wiki refresh',
] as const;

describe('team-wiki-codebase builtin skill (issue #360 slice 1)', () => {
  it('ships the packaged skill files', () => {
    for (const file of SKILL_FILES) {
      expect(fs.existsSync(file), file).toBe(true);
    }
  });

  it('tells Phase 0 to run teamai codebase --extract', () => {
    for (const file of SKILL_FILES) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).toContain('teamai codebase --extract');
    }
  });

  it('does not point at GRAPH-CAPABILITIES.md', () => {
    for (const file of SKILL_FILES) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toContain('GRAPH-CAPABILITIES.md');
    }
  });

  it('does not require standalone team-wiki CLI commands', () => {
    for (const file of SKILL_FILES) {
      const text = fs.readFileSync(file, 'utf8');
      for (const cmd of FORBIDDEN_REQUIRED_COMMANDS) {
        expect(text, `${file} must not require ${cmd}`).not.toContain(cmd);
      }
    }
  });
});
