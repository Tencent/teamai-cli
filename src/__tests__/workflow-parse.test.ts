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

  it('rejects a step that is not exactly one command', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: one
    command: echo one
    agent: reviewer
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ file: FILE, line: 7, field: 'steps[0].agent', message: 'a step has exactly one command' }),
    ]);
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
