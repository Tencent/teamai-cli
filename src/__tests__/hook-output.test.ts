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

  it('cursor: returns {message} format', () => {
    const result = formatStopHookOutput('test', 'cursor');
    const parsed = JSON.parse(result);
    expect(parsed.message).toBe('test');
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it('unknown tool: defaults to hookSpecificOutput', () => {
    const result = formatStopHookOutput('x', 'codex');
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('x');
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
