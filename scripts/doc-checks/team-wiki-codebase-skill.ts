import assert from 'node:assert/strict';
import { check } from '../doc-check.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKILL_DIR = path.join(ROOT, 'skill-data', 'wiki');

const SKILL_FILES = [
  path.join(SKILL_DIR, 'SKILL.md'),
  path.join(SKILL_DIR, 'references', 'overview.md'),
  path.join(SKILL_DIR, 'references', 'phases', 'phase0-init.md'),
  path.join(SKILL_DIR, 'references', 'methodology', 'phase0-collection.md'),
] as const;

/** Phase 0's procedure moved out of SKILL.md into its own reference (#678). */
const PHASE0_FILES = SKILL_FILES.filter((f) => !f.endsWith(path.join('wiki', 'SKILL.md')));

const FORBIDDEN_REQUIRED_COMMANDS = [
  'team-wiki compile code',
  'team-wiki reconcile',
  'team-wiki evaluate',
  'team-wiki compile docs',
  'team-wiki refresh',
] as const;

await check('ships the packaged skill files', () => {
  for (const file of SKILL_FILES) {
    assert.equal(fs.existsSync(file), true, file);
  }
});

await check('tells Phase 0 to run teamai import --dir', () => {
  for (const file of PHASE0_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('teamai import --dir'), file);
  }
});

await check('no longer points at the removed teamai codebase --extract', () => {
  for (const file of SKILL_FILES) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('codebase --extract'), file);
  }
});

await check('tells agents to run teamai codebase --deep-enrich', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /`teamai codebase --deep-enrich --project <slug>`/);
});

await check('does not point at GRAPH-CAPABILITIES.md', () => {
  for (const file of SKILL_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('GRAPH-CAPABILITIES.md'), file);
  }
});

await check('does not require standalone team-wiki CLI commands', () => {
  for (const file of SKILL_FILES) {
    const text = fs.readFileSync(file, 'utf8');
    for (const cmd of FORBIDDEN_REQUIRED_COMMANDS) {
      assert.ok(!text.includes(cmd), `${file} must not require ${cmd}`);
    }
  }
});
