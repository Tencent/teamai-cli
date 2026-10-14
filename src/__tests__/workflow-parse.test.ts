import { describe, expect, it } from 'vitest';
import { formatDiagnostic, parseWorkflow } from '../workflow/parse.js';

const FILE = 'workflows/build.yaml';

function parse(content: string, file = FILE) {
  return parseWorkflow(file, content);
}

describe('parseWorkflow', () => {
  it('parses a command-only workflow in order', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Compile, then test.
steps:
  - id: compile
    command: npm run build
  - id: test
    command: npm test
    output:
      ok: boolean
      verdict: pass | fix
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.id)).toEqual(['compile', 'test']);
    expect(result.definition.steps[1]?.output).toEqual({
      type: 'object',
      fields: {
        ok: { type: 'boolean' },
        verdict: { type: 'enum', values: ['pass', 'fix'] },
      },
    });
  });

  it('parses inline and file prompts with optional agents', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Review and summarize.
steps:
  - id: review
    prompt: Review this repository.
    agent: reviewer
  - id: summarize
    prompt_file: prompts/summary.md
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps).toEqual([
      { id: 'review', prompt: 'Review this repository.', agent: 'reviewer' },
      { id: 'summarize', promptFile: 'prompts/summary.md' },
    ]);
    expect(result.promptFileLocations[1]?.line).toBe(9);
  });

  it('names the file, line, and field when the header does not match', () => {
    const result = parse(`schemaVersion: v1
name: other
description: ''
steps: []
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fields = result.diagnostics.map((diagnostic) => diagnostic.field);
    expect(fields).toEqual(expect.arrayContaining(['schemaVersion', 'name', 'description', 'steps']));
    const name = result.diagnostics.find((diagnostic) => diagnostic.field === 'name');
    expect(name?.line).toBe(2);
    expect(name?.file).toBe(FILE);
    expect(formatDiagnostic(name!)).toBe(`${FILE}:2: field "name": name must match the file name "build"`);
  });

  it('rejects a duplicated step id at its source line', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: echo one
  - id: one
    command: echo two
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const duplicate = result.diagnostics.find((diagnostic) => diagnostic.message.includes('duplicated'));
    expect(duplicate).toMatchObject({ file: FILE, line: 7, field: 'steps[1].id' });
    expect(formatDiagnostic(duplicate!)).toContain(`${FILE}:7:`);
  });

  it('rejects multiple actions and an agent on a command', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: echo one
    prompt: Review it.
    agent: reviewer
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'steps[0]', message: 'a step has exactly one action: command, prompt, or prompt_file' }),
      expect.objectContaining({ field: 'steps[0].agent', message: 'agent is only allowed on a prompt or prompt_file step' }),
    ]));
  });

  it('rejects empty prompts and unsafe prompt_file paths', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    prompt: ''
  - id: two
    prompt_file: ../secret.md
  - id: three
    prompt_file: .git/config
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'steps[0].prompt', message: 'prompt must be a non-empty string' }),
      expect.objectContaining({ field: 'steps[1].prompt_file', message: 'prompt_file must be a relative path under prompts/' }),
      expect.objectContaining({ field: 'steps[2].prompt_file', message: 'prompt_file must be a relative path under prompts/' }),
    ]));
  });

  it('names a step key this version does not know', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: npm test
    if: success
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_key',
        field: 'steps[0].if',
        message: 'workflows/build.yaml uses `if`, which this teamai does not know. Update teamai.',
      }),
    ]));
  });

  it('rejects a YAML syntax error with the file and line', () => {
    const result = parse('schemaVersion: [\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ file: FILE, field: '(document)' });
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    expect(formatDiagnostic(result.diagnostics[0]!)).toContain(`${FILE}:`);
  });
});
