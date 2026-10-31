import assert from 'node:assert/strict';
import { check } from '../doc-check.js';
import fs from 'node:fs';
import path from 'node:path';

import { ALL_MODEL_AGENTS } from '../../src/models/profile.js';
import { runsTeamHookOn } from '../../src/hooks.js';
import { isLaunchTool } from '../../src/tool-launch/tools.js';
import { isToolId, TOOLS, type Support } from '../../src/tools.js';
import { DEFAULT_TOOL_PATHS, type ToolId } from '../../src/types.js';

const ROOT = process.cwd();
const READMES = fs
  .readdirSync(ROOT)
  .filter((file) => /^README(\..+)?\.md$/.test(file))
  .sort();

const COLUMNS = [
  'skills',
  'rules',
  'culture',
  'agents',
  'hooks',
  'mcp',
  'workflows',
  'env',
  'models',
  'context',
  'usage',
  'sessions',
  'scorers',
  'benchmarks',
] as const;
type Column = (typeof COLUMNS)[number];

/** The README's row label for each tool it lists. */
const LABELS: Readonly<Record<string, ToolId>> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  Cursor: 'cursor',
  CodeBuddy: 'codebuddy',
  WorkBuddy: 'workbuddy',
  'GitHub Copilot CLI': 'copilot',
  OpenCode: 'opencode',
  'Pi Coding Agent': 'pi',
  'Oh My Pi': 'omp',
  OpenClaw: 'openclaw',
  Hermes: 'hermes',
  'DeepSeek Harness': 'dsh',
  Qoder: 'qoder',
  'Qoder CN': 'qoder-cn',
  Kiro: 'kiro',
  Trae: 'trae',
  'Trae CN': 'trae-cn',
  ZCode: 'zcode',
  JoyCode: 'joycode',
  'Muse Code': 'muse',
  Antigravity: 'agy',
};
/** Internal builds the README leaves out. */
const UNLISTED: ReadonlySet<ToolId> = new Set(['claude-internal', 'codex-internal', 'tclaude', 'tcodex']);

function rows(file: string): Map<string, readonly string[]> {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Map(
    [...text.matchAll(/<tr><td>([^<]+)<\/td>(.*?)<\/tr>/g)].map(([, label, cells]) => {
      const values = [...cells.matchAll(/<td align="center">(.*?)<\/td>/g)].map(([, value]) => value);
      assert.equal(values.length, COLUMNS.length, `${file}: ${label}`);
      return [label, values];
    }),
  );
}

function cell(row: readonly string[], column: Column): string | undefined {
  return row[COLUMNS.indexOf(column)];
}

/** `✓` or `—` when the descriptor's mark decides it, else undefined (`?`). */
function decided(support: Support): '✓' | '—' | undefined {
  const mark = typeof support === 'string' ? support : support.cell;
  if (mark === '?') return undefined;
  return mark.startsWith('✓') || mark.startsWith('◐') ? '✓' : '—';
}

const matrix = rows('README.md');

await check('lists every tool but the internal builds', () => {
  const tools = Object.keys(DEFAULT_TOOL_PATHS)
    .filter(isToolId)
    .filter((tool) => !UNLISTED.has(tool));
  assert.deepEqual([...matrix.keys()].map((label) => LABELS[label]).sort(), tools.sort());
});

for (const file of READMES.filter((candidate) => candidate !== 'README.md')) {
  await check(`${file} has the same cells as README.md`, () => {
    assert.deepEqual(rows(file), matrix);
  });
}

for (const [label, row] of matrix) {
  await check(`${label} agrees with the tool descriptor`, () => {
    const tool = LABELS[label];
    const d = TOOLS[tool];
    const blocks = typeof d.blocks.user === 'object' || typeof d.blocks.project === 'object';
    if (typeof d.rules.user === 'object' && d.rules.user.channel === 'inline') assert.equal(cell(row, 'rules'), '✓¹');
    assert.equal(cell(row, 'culture'), blocks ? '✓' : '—');
    assert.equal(cell(row, 'models'), ALL_MODEL_AGENTS.some((agent) => agent === tool) ? '✓' : '—');
    // ✓ is teamai's hooks and the team's hooks/hooks.yaml both.
    assert.equal(
      cell(row, 'hooks'),
      typeof d.hooks.user === 'object' && runsTeamHookOn(tool, 'SessionStart') ? '✓' : '—',
    );
    const usage = decided(d.features.stats);
    if (usage !== undefined) assert.equal(cell(row, 'usage'), usage);
    // The skill driver runs workflows wherever the teamai skill reaches the session.
    assert.equal(cell(row, 'workflows'), cell(row, 'skills'));
    const sessionJudge = decided(d.features.sessionJudge) === '✓';
    // Without a session reader, a tool whose session judges its skill-driven runs scores only those (✓³).
    assert.equal(cell(row, 'scorers'), Array.isArray(d.sessions) ? '✓' : sessionJudge ? '✓³' : '—');
    // A benchmark arm runs on a tool the local driver launches.
    assert.equal(cell(row, 'benchmarks'), isLaunchTool(tool) ? '✓' : '—');
  });
}
