import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_MODEL_AGENTS } from '../models/profile.js';
import { isToolId, TOOLS, type Support } from '../tools.js';
import { DEFAULT_TOOL_PATHS, type ToolId } from '../types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const READMES = fs.readdirSync(ROOT).filter((file) => /^README(\..+)?\.md$/.test(file)).sort();

const COLUMNS = ['skills', 'rules', 'culture', 'agents', 'hooks', 'mcp', 'workflows', 'env', 'models', 'context', 'usage', 'sessions', 'scorers'] as const;
type Column = (typeof COLUMNS)[number];

/** The README's row label for each tool it lists. */
const LABELS: Readonly<Record<string, ToolId>> = {
  'Claude Code': 'claude', Codex: 'codex', Cursor: 'cursor', CodeBuddy: 'codebuddy', WorkBuddy: 'workbuddy',
  'GitHub Copilot CLI': 'copilot', OpenCode: 'opencode', 'Pi Coding Agent': 'pi', 'Oh My Pi': 'omp', OpenClaw: 'openclaw',
  Hermes: 'hermes', 'DeepSeek Harness': 'dsh', Qoder: 'qoder', 'Qoder CN': 'qoder-cn', Kiro: 'kiro', Trae: 'trae',
  'Trae CN': 'trae-cn', ZCode: 'zcode', JoyCode: 'joycode', 'Muse Code': 'muse',
};
/** Internal builds the README leaves out. */
const UNLISTED: readonly ToolId[] = ['claude-internal', 'codex-internal', 'tclaude', 'tcodex'];

function rows(file: string): Map<string, readonly string[]> {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Map([...text.matchAll(/<tr><td>([^<]+)<\/td>(.*?)<\/tr>/g)].map(([, label, cells]) => {
    const values = [...cells.matchAll(/<td align="center">(.*?)<\/td>/g)].map(([, value]) => value);
    expect(values, `${file}: ${label}`).toHaveLength(COLUMNS.length);
    return [label, values];
  }));
}

function cell(row: readonly string[], column: Column): string | undefined {
  return row[COLUMNS.indexOf(column)];
}

/** `✓` or `—` when the descriptor's mark decides it, else undefined (`?`). */
function decided(support: Support): '✓' | '—' | undefined {
  const cell = typeof support === 'string' ? support : support.cell;
  if (cell === '?') return undefined;
  return cell.startsWith('✓') || cell.startsWith('◐') ? '✓' : '—';
}

describe('README agent matrix', () => {
  const matrix = rows('README.md');

  it('lists every tool but the internal builds', () => {
    const tools = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId).filter((tool) => !UNLISTED.includes(tool));
    expect([...matrix.keys()].map((label) => LABELS[label]).sort()).toEqual(tools.sort());
  });

  it.each(READMES.filter((file) => file !== 'README.md'))('%s has the same cells as README.md', (file) => {
    expect(rows(file)).toEqual(matrix);
  });

  it.each([...matrix])('%s agrees with the tool descriptor', (label, row) => {
    const tool = LABELS[label];
    const d = TOOLS[tool];
    const blocks = typeof d.blocks.user === 'object' || typeof d.blocks.project === 'object';
    if (typeof d.rules.user === 'object' && d.rules.user.channel === 'inline') expect(cell(row, 'rules')).toBe('✓¹');
    expect(cell(row, 'culture')).toBe(blocks ? '✓' : '—');
    expect(cell(row, 'models')).toBe(ALL_MODEL_AGENTS.some((agent) => agent === tool) ? '✓' : '—');
    const usage = decided(d.features.stats);
    if (usage !== undefined) expect(cell(row, 'usage')).toBe(usage);
    // The skill driver runs workflows wherever the teamai skill reaches the session.
    expect(cell(row, 'workflows')).toBe(cell(row, 'skills'));
    const sessionJudge = decided(d.features.sessionJudge) === '✓';
    // Without a session reader, a tool whose session judges its skill-driven runs scores only those (✓³).
    expect(cell(row, 'scorers')).toBe(Array.isArray(d.sessions) ? '✓' : sessionJudge ? '✓³' : '—');
  });
});
