/**
 * Retiring the `post-tool-use --matcher Skill` hook (#1221): each `*.before.json`
 * is the file the previous release wrote for one format family; reconcile it
 * and only the Skill entry goes, every other byte stays. A project's team-only
 * file never held the built-in, so it is written as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectHooks, reconcileHooks } from '../hooks.js';
import type { HookDef } from '../types.js';

const FIXTURES = path.resolve(__dirname, 'fixtures', 'hooks-skill-retire');

/** The team hook the team-only fixture was written with. */
const TEAM_LINT: HookDef = {
  source: 'team', key: 'lint', event: 'PostToolUse', matcher: 'Edit',
  command: 'bash .teamai/team-scripts/lint.sh', description: '[teamai:team:lint] Lint after edits',
};

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-retire-')));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** `value` without the array entries that hold a `--matcher Skill` dispatch. */
function withoutSkillHook(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => !JSON.stringify(entry).includes('--matcher Skill')).map(withoutSkillHook);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutSkillHook(inner)]));
  }
  return value;
}

const FAMILIES = [
  { name: 'claude', file: 'settings.json' },
  { name: 'codex', file: 'hooks.json' },
  { name: 'copilot', file: 'teamai.json' },
  { name: 'cursor', file: 'hooks.json' },
  { name: 'zcode', file: 'config.json' },
];

describe('reconcile retires the Skill dispatch hook (#1221)', () => {
  it.each(FAMILIES)('$name: removes only the Skill entry', async ({ name, file }) => {
    const before = fs.readFileSync(path.join(FIXTURES, `${name}.before.json`), 'utf-8');
    expect(before).toContain('--matcher Skill');
    const settings = path.join(tmp, name, file);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, before);

    await injectHooks(settings, name);

    const after = fs.readFileSync(settings, 'utf-8');
    expect(JSON.parse(after)).toEqual(withoutSkillHook(JSON.parse(before)));
    await expect(after).toMatchFileSnapshot(path.join(FIXTURES, `${name}.after.json`));
  });

  it('writes a project team-only file byte for byte as the previous release did', async () => {
    const before = fs.readFileSync(path.join(FIXTURES, 'claude-team-only.json'), 'utf-8');
    const settings = path.join(tmp, 'project', '.claude', 'settings.json');
    await reconcileHooks(settings, 'claude', [TEAM_LINT], { manifestPath: path.join(tmp, 'managed.json'), teamOnly: true });
    expect(fs.readFileSync(settings, 'utf-8')).toBe(before);
  });
});
