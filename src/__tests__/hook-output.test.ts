import { describe, it, expect } from 'vitest';
import { formatStopHookOutput, relayWhenHidden, RELAY_TO_USER_PREFIX } from '../utils/hook-output.js';
import { stopStdoutUnsupported } from '../utils/tool-names.js';

describe('formatStopHookOutput', () => {
  it('claude: returns hookSpecificOutput format', () => {
    const result = formatStopHookOutput('hello', 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('hello');
  });

  it('codebuddy: returns hookSpecificOutput format (same as claude)', () => {
    const result = formatStopHookOutput('msg', 'codebuddy');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toBe('msg');
  });

  it('cursor: returns {followup_message} format', () => {
    const result = formatStopHookOutput('test', 'cursor');
    const parsed = JSON.parse(result);
    expect(parsed.followup_message).toBe('test');
    expect(parsed.hookSpecificOutput).toBeUndefined();
    expect(parsed.message).toBeUndefined();
  });

  it('unknown tool: defaults to hookSpecificOutput (Claude schema)', () => {
    const result = formatStopHookOutput('x', 'unknown');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('x');
  });

  it('workbuddy: uses Claude hookSpecificOutput format', () => {
    const result = formatStopHookOutput('wb', 'workbuddy');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('wb');
  });

  it('tool identifier is case-insensitive for cursor detection', () => {
    const result = formatStopHookOutput('t', 'Cursor');
    const parsed = JSON.parse(result);
    expect(parsed.followup_message).toBe('t');
  });

  it('returns valid JSON string', () => {
    const result = formatStopHookOutput('any message', 'claude');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('empty message is preserved in output', () => {
    const result = formatStopHookOutput('', 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('');
  });
});

/**
 * `relayWhenHidden` is where #719 is decided: Claude Code prints the Stop payload
 * as "Stop hook feedback", so a message it will print must not also carry an
 * order to print it. Cursor shows nothing, so there the order is what makes the
 * message arrive at all.
 */
describe('relayWhenHidden', () => {
  it.each(['claude', 'unknown-tool', 'Claude'])('leaves the message alone for %s', (tool) => {
    expect(relayWhenHidden('[teamai] body', tool)).toBe('[teamai] body');
  });

  it.each(['cursor', 'Cursor'])('asks the model to relay it for %s', (tool) => {
    expect(relayWhenHidden('[teamai] body', tool)).toBe(`${RELAY_TO_USER_PREFIX}[teamai] body`);
  });
});

describe('stopStdoutUnsupported', () => {
  it.each(['codex', 'codex-internal', 'tcodex', 'Codex', 'TCodex', 'codebuddy', 'workbuddy'])(
    'stashes instead of printing for %s',
    (tool) => {
      expect(stopStdoutUnsupported(tool)).toBe(true);
    },
  );

  it.each(['claude', 'cursor', 'opencode', undefined])('lets %s take the Stop payload', (tool) => {
    expect(stopStdoutUnsupported(tool)).toBe(false);
  });
});
