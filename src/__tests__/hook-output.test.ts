import { describe, it, expect } from 'vitest';
import { formatStopHookOutput } from '../utils/hook-output.js';

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
    const result = formatStopHookOutput('x', 'codex');
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
