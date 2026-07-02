// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';
import { normalizeToolName } from '../utils/tool-names.js';

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
