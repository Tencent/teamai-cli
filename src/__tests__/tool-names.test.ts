// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';
import { normalizeToolName } from '../utils/tool-names.js';
import { parseHookInput } from '../auto-recall.js';

describe('normalizeToolName', () => {
  it('maps IDE-style names to CLI-style', () => {
    expect(normalizeToolName('execute_command')).toBe('Bash');
    expect(normalizeToolName('search_content')).toBe('Grep');
    expect(normalizeToolName('write_to_file')).toBe('Write');
    expect(normalizeToolName('replace_in_file')).toBe('Edit');
    expect(normalizeToolName('list_dir')).toBe('Glob');
    expect(normalizeToolName('web_search')).toBe('WebSearch');
    expect(normalizeToolName('web_fetch')).toBe('WebFetch');
    expect(normalizeToolName('read_file')).toBe('Read');
    expect(normalizeToolName('task')).toBe('Task');
  });

  it('passes through CLI-style names unchanged', () => {
    expect(normalizeToolName('Bash')).toBe('Bash');
    expect(normalizeToolName('Grep')).toBe('Grep');
    expect(normalizeToolName('Write')).toBe('Write');
    expect(normalizeToolName('Skill')).toBe('Skill');
    expect(normalizeToolName('WebSearch')).toBe('WebSearch');
  });

  it('passes through unknown names unchanged', () => {
    expect(normalizeToolName('SomeNewTool')).toBe('SomeNewTool');
    expect(normalizeToolName('')).toBe('');
  });
});

describe('parseHookInput normalizes IDE tool names', () => {
  it('normalizes execute_command to Bash', () => {
    const result = parseHookInput({
      tool_name: 'execute_command',
      tool_input: { command: 'ls -la' },
      tool_response: { stdout: 'file.txt', stderr: '' },
    });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('Bash');
  });

  it('normalizes search_content to Grep', () => {
    const result = parseHookInput({
      tool_name: 'search_content',
      tool_input: { pattern: 'TODO' },
      tool_response: { stdout: 'src/main.ts:5: // TODO fix', stderr: '' },
    });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('Grep');
  });

  it('normalizes web_search to WebSearch', () => {
    const result = parseHookInput({
      tool_name: 'web_search',
      tool_input: { query: 'node.js streams' },
      tool_response: { stdout: '...', stderr: '' },
    });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('WebSearch');
  });

  it('keeps CLI-style names as-is', () => {
    const result = parseHookInput({
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { stdout: 'hello', stderr: '' },
    });
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('Bash');
  });
});
