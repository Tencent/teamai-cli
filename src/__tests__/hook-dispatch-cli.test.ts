import { describe, it, expect } from 'vitest';

import { parseStdin } from '../hook-dispatch-cli.js';

describe('parseStdin', () => {
  it('degrades malformed JSON to an empty object instead of null', () => {
    // RED BASELINE: before the fix this returns null (short-circuiting all
    // dispatch). After the fix it degrades to {} so non-stdin-dependent
    // background handlers still run, and records diagnostics to debug.log.
    const result = parseStdin('{broken', 'stop');
    expect(result).not.toBeNull();
    expect(result).toBeTypeOf('object');
    expect(result.hook_event_name).toBe('Stop');
  });

  it('returns an empty object (plus event name) for blank STDIN', () => {
    const result = parseStdin('', 'stop');
    expect(result).toEqual({ hook_event_name: 'Stop' });
  });

  it('parses well-formed JSON and keeps its fields (regression)', () => {
    const result = parseStdin('{"transcript_path":"/x"}', 'stop');
    expect(result.transcript_path).toBe('/x');
    expect(result.hook_event_name).toBe('Stop');
  });

  it('maps lower-case event aliases to their canonical hook names', () => {
    const result = parseStdin('', 'session-start');
    expect(result.hook_event_name).toBe('SessionStart');
  });

  it('degrades JSON `null` to {} instead of throwing', () => {
    // RED BASELINE: before the fix, JSON.parse('null') returns null, and the
    // subsequent `stdin.hook_event_name` access throws TypeError in ESM strict
    // mode, short-circuiting all dispatch (the very failure mode the original
    // malformed-JSON fix was meant to prevent).
    const result = parseStdin('null', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result.hook_event_name).toBe('Stop');
  });

  it('degrades JSON number to {} instead of throwing', () => {
    // RED BASELINE: before the fix, JSON.parse('123') returns 123, and
    // assigning a property on a number primitive throws TypeError in ESM
    // strict mode.
    const result = parseStdin('123', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result.hook_event_name).toBe('Stop');
  });

  it('degrades JSON array to a plain object (arrays are not records)', () => {
    // RED BASELINE: before the fix, JSON.parse('[1,2]') returns an array,
    // which is typeof 'object' but not a plain record — downstream handlers
    // indexing string keys would misbehave.
    const result = parseStdin('[1,2]', 'stop');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual({ hook_event_name: 'Stop' });
  });
});
