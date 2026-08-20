import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

// Mock the prompt module so we control the interactive selection deterministically.
vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn(),
  askConfirmation: vi.fn(),
  askSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

// Mock HOME detection so the picker's "Auto" row + expansion are deterministic.
vi.mock('../known-agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../known-agents.js')>();
  return { ...actual, detectHomeInstalledAgents: vi.fn() };
});

import { promptForSelfModeAgents } from '../init.js';
import { askSelection } from '../utils/prompt.js';
import { detectHomeInstalledAgents } from '../known-agents.js';

describe('promptForSelfModeAgents — interactive Auto option', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalIsTTY = process.stdin.isTTY;
    // Force the interactive branch.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(detectHomeInstalledAgents).mockResolvedValue(['claude', 'codex']);
  });

  afterEach(() => {
    logSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.clearAllMocks();
  });

  it('renders an Auto row (option 1) listing the detected tools', async () => {
    vi.mocked(askSelection).mockResolvedValueOnce([0]); // pick Auto
    await promptForSelfModeAgents({});
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('1. Auto');
    expect(printed).toContain('Claude Code'); // detected labels shown inline
    expect(printed).toContain('Codex');
  });

  it('Enter (null selection) defaults to Auto → detected tools', async () => {
    vi.mocked(askSelection).mockResolvedValueOnce(null);
    const result = await promptForSelfModeAgents({});
    expect(result).toEqual(['claude', 'codex']);
  });

  it('picking Auto (index 0) returns the detected tools', async () => {
    vi.mocked(askSelection).mockResolvedValueOnce([0]);
    const result = await promptForSelfModeAgents({});
    expect(result).toEqual(['claude', 'codex']);
  });

  it('picking a specific tool (index 3 = Cursor) returns just that tool', async () => {
    vi.mocked(askSelection).mockResolvedValueOnce([3]); // 1=Auto,2=claude,3=codex... wait: index maps -1
    const result = await promptForSelfModeAgents({});
    // resolveSelfModeSelection: index 3 → SELF_MODE_AGENT_CHOICES[2] = cursor
    expect(result).toEqual(['cursor']);
  });

  it('offers exactly 6 options (Auto + 5 tools)', async () => {
    vi.mocked(askSelection).mockResolvedValueOnce([0]);
    await promptForSelfModeAgents({});
    const [, itemCount] = vi.mocked(askSelection).mock.calls[0];
    expect(itemCount).toBe(6);
  });

  it('renders "none detected" when HOME has no known tools, and Auto → claude', async () => {
    vi.mocked(detectHomeInstalledAgents).mockResolvedValue([]);
    vi.mocked(askSelection).mockResolvedValueOnce(null); // Enter → Auto
    const result = await promptForSelfModeAgents({});
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('none detected');
    expect(result).toEqual(['claude']);
  });

  it('--agent bypasses the picker entirely', async () => {
    const result = await promptForSelfModeAgents({ agent: 'workbuddy' });
    expect(result).toEqual(['workbuddy']);
    expect(askSelection).not.toHaveBeenCalled();
  });

  it('--force skips the picker and mirrors HOME detection', async () => {
    const result = await promptForSelfModeAgents({ force: true });
    expect(result).toEqual(['claude', 'codex']);
    expect(askSelection).not.toHaveBeenCalled();
  });
});
