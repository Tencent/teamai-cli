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
    needs: [compile]
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
    needs: [review]
    prompt_file: prompts/summary.md
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps).toEqual([
      { id: 'review', prompt: 'Review this repository.', agent: 'reviewer' },
      { id: 'summarize', needs: ['review'], promptFile: 'prompts/summary.md' },
    ]);
    expect(result.promptFileLocations['steps[1]']?.line).toBe(10);
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
    needs: []
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
      expect.objectContaining({ field: 'steps[0]', message: 'a step has exactly one action: command, prompt, prompt_file, or workflow' }),
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
    needs: [one]
    prompt_file: ../secret.md
  - id: three
    needs: [two]
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
    timeout: 10m
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_key',
        field: 'steps[0].timeout',
        message: 'workflows/build.yaml uses `timeout`, which this teamai does not know. Update teamai.',
      }),
    ]));
  });

  it('checks a with template under a key YAML reads as a number', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Review it.
steps:
  - id: review
    prompt: Review {{ with.1 }}
    with:
      1: "{{ inputs.nope }}"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bad_template', field: 'steps[0].with.1', line: 8 }),
    ]));
  });

  it('reads an element of a declared array by index', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Fix the first file.
inputs:
  labels: [string]
outputs:
  first: steps.review.outputs.files[0].path
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string }]
  - id: fix
    needs: [review]
    if: steps.review.outputs.files[0].path == 'a.ts' && inputs.labels[0] == 'bug'
    prompt: Fix {{ steps.review.outputs.files[0].path }}
`);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects an index into a value that is not declared as an array, and names the path as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Fix the first file.
inputs:
  title: string
outputs:
  first: steps.review.outputs.verdict[0]
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: inputs.title[0] == 'a' || steps.review.outputs.verdict[0] == 'p'
    prompt: Fix {{ with.nope[0] }}
    with:
      refs: [a]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic).sort()).toEqual([
      'workflows/build.yaml:15: field "steps[1].if": step "fix" if reads inputs.title[0], which is not an input the workflow declares',
      'workflows/build.yaml:15: field "steps[1].if": step "fix" if reads steps.review.outputs.verdict[0], which is not in the output step "review" declares',
      'workflows/build.yaml:16: field "steps[1].prompt": step "fix" prompt reads with.nope[0], which is not a name its with declares',
      'workflows/build.yaml:7: field "outputs.first": output "first" reads steps.review.outputs.verdict[0], which is not in the output step "review" declares',
    ]);
  });

  it('rejects a comparison of a value declared as something other than a number', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  title: string
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict < 1 || inputs.title > 0 || steps.review.outcome >= 1
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares steps.review.outputs.verdict with <, but it is not a number',
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares inputs.title with >, but it is not a number',
      'workflows/build.yaml:13: field "steps[1].if": step "fix" if compares steps.review.outcome with >=, but it is not a number',
    ]);
  });

  it('rejects a list argument declared as something other than an array', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.verdict, true)
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if passes steps.review.outputs.verdict to any as its list, but it is not an array',
    ]);
  });

  it('checks what a predicate reads of each element against the items the list declares', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string, lines: number, tags: [string] }]
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.files, .pth == 'a') || all(steps.review.outputs.files, .path < 1) || any(steps.review.outputs.files, any(.path, true))
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if reads .pth, which is not in an item of steps.review.outputs.files',
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if compares .path with <, but it is not a number',
      'workflows/build.yaml:11: field "steps[1].if": step "fix" if passes .path to any as its list, but it is not an array',
    ]);
  });

  it('accepts comparisons, functions and predicates that fit the declared types', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  limit: number
steps:
  - id: review
    command: node review.js
    output:
      count: number
      files: [{ path: string, lines: number, tags: [string] }]
  - id: fix
    needs: [review]
    if: steps.review.outputs.count < inputs.limit && length(filter(steps.review.outputs.files, .lines >= 10)) > 0 && any(steps.review.outputs.files, any(.tags, . == 'bug') && .path != '') && all(steps.review.outputs.files, length(.tags) > 0) && steps.review.outputs.files[0].lines > 0
    command: node fix.js
`);
    expect(result).toMatchObject({ ok: true });
  });

  it('reports an if that calls a function on literals and is always false', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Never runs.
steps:
  - id: one
    if: any([], . == 1) || length([]) > 0
    command: node one.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'false_if', message: 'step "one" if is always false, so the step never runs' })]);
  });

  it('checks a predicate an inline step runs over an enclosing step once, in the enclosing workflow', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
steps:
  - id: review
    command: node review.js
    output:
      files: [{ path: string }]
  - id: grp
    needs: [review]
    workflow:
      steps:
        - id: local
          command: node local.js
          output:
            n: number
        - id: use
          needs: [local]
          if: any(steps.review.outputs.files, .pth == 'a') && steps.local.outputs.n < length(steps.review.outputs.files)
          command: node use.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:19: field "steps[1].workflow.steps[1].if": step "use" if reads .pth, which is not in an item of steps.review.outputs.files',
    ]);
  });

  it('reports an end compared inside a predicate that the workflow a step runs does not declare', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Check the review.
inputs:
  tags: [string]
steps:
  - id: check
    workflow:
      ends:
        done: succeeded
      steps:
        - id: one
          command: node one.js
          end: done
  - id: fix
    needs: [check]
    if: any(inputs.tags, steps.check.end == 'nope')
    command: node fix.js
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'undeclared_end',
      message: 'step "fix" if compares steps.check.end with \'nope\', which is not an end the inline workflow of step "check" declares',
    })]);
  });

  it('rejects a YAML syntax error with the file and line', () => {
    const result = parse('schemaVersion: [\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ file: FILE, field: '(document)' });
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
    expect(formatDiagnostic(result.diagnostics[0]!)).toContain(`${FILE}:`);
  });

  it('reports an expression nested 5,000 levels deep in an if and in a prompt template', () => {
    const deep = `${'('.repeat(5000)}length(inputs.xs)${')'.repeat(5000)}`;
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Nest deep.
inputs:
  xs: [string]
steps:
  - id: explain
    if: ${deep} > 0
    prompt: "Explain {{ ${deep} }} and {{ ${'('.repeat(5000)} }}"
`)).toEqual([
      { message: `${FILE}:8: field "steps[0].if": step "explain" if does not parse at column 101: an expression nests at most 100 levels deep, counting each "(", "!", call, && and ||` },
      { message: `${FILE}:9: field "steps[0].prompt": step "explain" prompt template {{ ${deep} }}: an expression nests at most 100 levels deep, counting each "(", "!", call, && and ||`, code: 'bad_template' },
    ]);
  });
});

function rejected(content: string): Array<{ message: string; code?: string }> {
  const result = parse(content);
  if (result.ok) throw new Error('expected the file to be rejected');
  return result.diagnostics.map((diagnostic) => ({ message: formatDiagnostic(diagnostic), ...(diagnostic.code ? { code: diagnostic.code } : {}) }));
}

const REVIEW_AND_FIX = `schemaVersion: v1alpha1
name: build
description: Review and fix, up to three times.
steps:
  - id: review
    command: node review.js
    output:
      verdict: pass | fix
      findings: [string]
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: node fix.js
    loop: { back_to: review, max_iterations: 3 }
`;

describe('step loops', () => {
  it('parses a loop back to a step the owner needs, with an optional while', () => {
    const result = parse(`${REVIEW_AND_FIX}  - id: decide
    needs: [fix]
    command: node decide.js
    output:
      choice: build | revise
    loop:
      back_to: decide
      while: steps.decide.outputs.choice == 'revise'
      max_iterations: 2
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.loop)).toEqual([
      undefined,
      { backTo: 'review', maxIterations: 3 },
      { backTo: 'decide', while: "steps.decide.outputs.choice == 'revise'", maxIterations: 2 },
    ]);
  });

  it('rejects a loop that is not a map of back_to, max_iterations and while', () => {
    const loop = (value: string): string => REVIEW_AND_FIX.replace('loop: { back_to: review, max_iterations: 3 }', `loop: ${value}`);
    expect(rejected(loop('3'))).toEqual([
      { message: `${FILE}:14: field "steps[1].loop": step "fix" loop must map back_to, max_iterations, and optionally while`, code: 'bad_loop' },
    ]);
    expect(rejected(loop("{ back_to: '', max_iterations: 0, while: 'steps.review.outputs.verdict ==', until: x }"))).toEqual([
      { message: `${FILE}:14: field "steps[1].loop.until": workflows/build.yaml uses \`until\`, which this teamai does not know. Update teamai.`, code: 'unknown_key' },
      { message: `${FILE}:14: field "steps[1].loop.back_to": step "fix" loop.back_to must name a step`, code: 'bad_loop' },
      { message: `${FILE}:14: field "steps[1].loop.max_iterations": step "fix" loop.max_iterations must be a whole number from 1`, code: 'bad_loop' },
      { message: `${FILE}:14: field "steps[1].loop.while": step "fix" loop.while does not parse at column 32: expected a value, found the end of the expression`, code: 'bad_loop' },
    ]);
  });

  it('rejects a loop back to a step its owner does not need, a loop on a step with end, and loops that share a step', () => {
    expect(rejected(REVIEW_AND_FIX.replace('back_to: review', 'back_to: docs') + `  - id: docs
    needs: []
    command: node docs.js
`)).toEqual([{
      message: `${FILE}:14: field "steps[1].loop.back_to": step "fix" loop.back_to is "docs", which is not "fix" or a step it needs, directly or through its needs`,
      code: 'bad_loop',
    }]);
    expect(rejected(`${REVIEW_AND_FIX.replace('description:', 'ends:\n  done: succeeded\ndescription:')}    end: done
`)).toEqual([{
      message: `${FILE}:16: field "steps[1].loop": step "fix" has loop and end; a step that ends its workflow cannot run again`,
      code: 'bad_loop',
    }]);
    expect(rejected(`${REVIEW_AND_FIX}  - id: verify
    needs: [fix]
    command: node verify.js
    loop: { back_to: fix, max_iterations: 2 }
`)).toEqual([{
      message: `${FILE}:18: field "steps[2].loop": step "verify" loop runs "fix" again, which the loop of step "fix" also runs; loops in one workflow share no step, so put the inner one in a sub-workflow`,
      code: 'bad_loop',
    }]);
  });

  it('checks what loop.while reads: its own step and the steps that step needs', () => {
    expect(rejected(REVIEW_AND_FIX.replace('max_iterations: 3 }', "max_iterations: 3, while: \"steps.fix.outputs.again && steps.docs.outcome == 'success' || steps.review.outputs.verdcit\" }") + `  - id: docs
    needs: []
    command: node docs.js
`)).toEqual([
      { message: `${FILE}:14: field "steps[1].loop.while": step "fix" loop.while reads steps.docs, which is not a step it needs, directly or through its needs`, code: 'bad_loop' },
      { message: `${FILE}:14: field "steps[1].loop.while": step "fix" loop.while reads steps.review.outputs.verdcit, which is not in the output step "review" declares`, code: 'bad_loop' },
    ]);
  });

  it('types steps.<id>.passes from the output its step declares', () => {
    const reads = (condition: string): string => `${REVIEW_AND_FIX}  - id: report
    needs: [fix]
    if: ${JSON.stringify(condition)}
    command: node report.js
`;
    expect(parse(reads("length(steps.review.passes) > 1 && steps.review.passes[0].outputs.verdict == 'fix' && any(steps.review.passes, .outputs.findings != [] && .pass > 1)")).ok).toBe(true);
    expect(rejected(reads("steps.review.passes[0].outputs.verdcit == 'fix' || steps.review.passes[0].round == 1 || any(steps.review.passes, .outcome > 1)"))).toEqual([
      { message: `${FILE}:17: field "steps[2].if": step "report" if reads steps.review.passes[0].outputs.verdcit, which is not in a pass of step "review": pass, outcome, end, and outputs as its output declares` },
      { message: `${FILE}:17: field "steps[2].if": step "report" if reads steps.review.passes[0].round, which is not in a pass of step "review": pass, outcome, end, and outputs as its output declares` },
      { message: `${FILE}:17: field "steps[2].if": step "report" if compares .outcome with >, but it is not a number` },
    ]);
  });

  it('lets a step read a step after it in the same loop, in the previous pass, and no other step after it', () => {
    expect(parse(REVIEW_AND_FIX.replace("    command: node review.js\n", "    if: steps.fix.outcome != 'failed'\n    command: node review.js\n")).ok).toBe(true);
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Two checks between a build and a gate that loops.
steps:
  - id: build
    command: node build.js
  - id: unit
    needs: [build]
    if: steps.lint.outcome == 'success'
    command: node unit.js
  - id: lint
    needs: [build]
    command: node lint.js
  - id: gate
    needs: [unit, lint]
    command: node gate.js
    loop: { back_to: build, max_iterations: 2 }
  - id: docs
    needs: []
    if: steps.gate.outcome == 'success'
    command: node docs.js
`)).toEqual([
      { message: `${FILE}:9: field "steps[1].if": step "unit" if reads steps.lint, which is not a step it needs, directly or through its needs` },
      { message: `${FILE}:20: field "steps[4].if": step "docs" if reads steps.gate, which is not a step it needs, directly or through its needs` },
    ]);
  });

  it('rejects two loops that wait for each other through the steps they need', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Two loops, each needed by the other's owner.
steps:
  - id: build
    command: node build.js
  - id: fetch
    needs: []
    command: node fetch.js
  - id: test
    needs: [build, fetch]
    command: node test.js
    loop: { back_to: build, max_iterations: 2 }
  - id: lint
    needs: [build, fetch]
    command: node lint.js
    loop: { back_to: fetch, max_iterations: 2 }
`)).toEqual([{
      message: `${FILE}:11: field "steps[2].needs": step "test" waits in a cycle: test -> lint -> test; a step that needs or reads a step inside a loop waits until the loop ends`,
      code: 'bad_loop',
    }]);
  });
});

describe('workflow loops', () => {
  const POLL = `schemaVersion: v1alpha1
name: build
description: Probe until ready.
inputs:
  target: string
loop:
  while: "steps.probe.outputs.status != 'ready' && inputs.target != ''"
  max_iterations: 5
steps:
  - id: probe
    command: node probe.js
    output:
      status: string
  - id: report
    needs: [probe]
    command: node report.js
    break: steps.probe.outputs.status == 'gone'
  - id: retry
    needs: []
    workflow:
      loop: { max_iterations: 2 }
      steps:
        - id: try
          command: node try.js
`;

  it('parses a loop on a workflow file and on an inline workflow, and a break on a step', () => {
    const result = parse(POLL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.loop).toEqual({ while: "steps.probe.outputs.status != 'ready' && inputs.target != ''", maxIterations: 5 });
    expect(result.definition.steps[1]?.break).toBe("steps.probe.outputs.status == 'gone'");
    const retry = result.definition.steps[2]?.workflow;
    expect(typeof retry === 'object' ? retry.loop : undefined).toEqual({ maxIterations: 2 });
  });

  it('rejects a break inside the range of a step loop', () => {
    expect(rejected(REVIEW_AND_FIX.replace("    command: node review.js\n", "    command: node review.js\n    break: steps.review.outputs.verdict == 'pass'\n"))).toEqual([{
      message: `${FILE}:7: field "steps[0].break": step "review" has break inside the loop of step "fix", where its if and while already end the loop`,
      code: 'bad_loop',
    }]);
  });

  it('rejects a step loop in a workflow that loops', () => {
    expect(rejected(REVIEW_AND_FIX.replace('steps:\n', 'loop: { max_iterations: 2 }\nsteps:\n'))).toEqual([{
      message: `${FILE}:15: field "steps[1].loop": step "fix" has loop in a workflow that loops; put one of the two loops in a sub-workflow`,
      code: 'bad_loop',
    }]);
  });

  it('checks what a workflow loop.while reads: its own steps, the outputs they declare, and the inputs', () => {
    expect(rejected(POLL
      .replace("inputs.target != ''", "inputs.taget != '' || steps.probe.outputs.stauts == 'x' || steps.gone.outcome == 'success'")
      .replace('loop: { max_iterations: 2 }', "loop: { while: \"steps.probe.outcome == 'failed'\", max_iterations: 2 }"))).toEqual([
      { message: `${FILE}:21: field "steps[2].workflow.loop.while": step "retry" workflow loop.while reads steps.probe, which is not one of its steps`, code: 'bad_loop' },
      { message: `${FILE}:7: field "loop.while": workflow loop.while reads inputs.taget, which is not an input the workflow declares`, code: 'bad_loop' },
      { message: `${FILE}:7: field "loop.while": workflow loop.while reads steps.probe.outputs.stauts, which is not in the output step "probe" declares`, code: 'bad_loop' },
      { message: `${FILE}:7: field "loop.while": workflow loop.while reads steps.gone, which is not one of its steps`, code: 'bad_loop' },
    ]);
  });

  it('rejects a workflow loop that is not a map of max_iterations and while, and a break that is not an expression', () => {
    const header = (value: string): string => POLL.replace(/loop:\n {2}while: .*\n {2}max_iterations: 5\n/, `loop: ${value}\n`);
    expect(rejected(header('3'))).toEqual([
      { message: `${FILE}:6: field "loop": workflow loop must map max_iterations, and optionally while`, code: 'bad_loop' },
    ]);
    expect(rejected(header("{ back_to: probe, max_iterations: 0, while: 'steps.probe.outcome ==' }"))).toEqual([
      { message: `${FILE}:6: field "loop.back_to": workflow loop has no back_to; each round runs every step of the workflow`, code: 'bad_loop' },
      { message: `${FILE}:6: field "loop.max_iterations": workflow loop.max_iterations must be a whole number from 1`, code: 'bad_loop' },
      { message: `${FILE}:6: field "loop.while": workflow loop.while does not parse at column 23: expected a value, found the end of the expression`, code: 'bad_loop' },
    ]);
    expect(rejected(POLL.replace("break: steps.probe.outputs.status == 'gone'", "break: \"steps.probe.outputs.status ==\""))).toEqual([
      { message: `${FILE}:17: field "steps[1].break": step "report" break does not parse at column 30: expected a value, found the end of the expression`, code: 'bad_loop' },
    ]);
    expect(rejected(POLL.replace("break: steps.probe.outputs.status == 'gone'", 'break: [gone]'))).toEqual([
      { message: `${FILE}:17: field "steps[1].break": step "report" break must be an expression`, code: 'bad_loop' },
    ]);
  });
});

const FAN = `schemaVersion: v1alpha1
name: build
description: Build each target.
inputs:
  targets: [string]
steps:
  - id: build
    for_each: inputs.targets
    command: node build.js
    env:
      TARGET: "{{ item }}"
`;

const ITEM_TEXT = `schemaVersion: v1alpha1
name: build
description: Explain loops that other tools run.
steps:
  - id: explain
    prompt: "Explain {{ item }}, {{ item.name }}, {{ item[0] }} and {{ length(item.xs) }} in a Jinja loop: {{ with.loop }}."
    with:
      loop: ["{{ item }}", "{{ item.name }}", "{{ length(item.xs) }}"]
  - id: play
    needs: [explain]
    command: ansible localhost -m debug -a 'msg={{ item }}'
    env:
      ITEM: "{{ item }}"
      NAME: "{{ item.name }}"
      COUNT: "{{ length(item.xs) }}"
`;

describe('for_each', () => {
  it.each([
    ['loop', '    loop: { back_to: build, max_iterations: 2 }\n', '', 'step "build" has for_each and loop; put the loop in a sub-workflow'],
    ['end', '    end: built\n', 'ends: { built: succeeded }\n', 'step "build" has for_each and end; a step that runs once per item cannot end its workflow'],
    ['break', '    break: "true"\n', '', 'step "build" has for_each and break; a step that runs once per item cannot end its workflow'],
  ])('rejects for_each with %s', (_key, line, header, message) => {
    expect(rejected(FAN.replace('steps:\n', `${header}steps:\n`).replace('    command: node build.js\n', `    command: node build.js\n${line}`))).toEqual([
      { message: `${FILE}:${header ? 9 : 8}: field "steps[0].for_each": ${message}`, code: 'bad_loop' },
    ]);
  });

  it('keeps item as written in the templates and command of a step without for_each, where no item is bound', () => {
    const result = parse(ITEM_TEXT);

    expect(result.ok ? result.definition.steps : result.diagnostics.map(formatDiagnostic)).toEqual([
      {
        id: 'explain',
        prompt: 'Explain {{ item }}, {{ item.name }}, {{ item[0] }} and {{ length(item.xs) }} in a Jinja loop: {{ with.loop }}.',
        with: { loop: ['{{ item }}', '{{ item.name }}', '{{ length(item.xs) }}'] },
      },
      {
        id: 'play',
        needs: ['explain'],
        command: "ansible localhost -m debug -a 'msg={{ item }}'",
        env: { ITEM: '{{ item }}', NAME: '{{ item.name }}', COUNT: '{{ length(item.xs) }}' },
      },
    ]);
  });

  it('accepts a call on item in a template of a for_each step, where item is bound', () => {
    const result = parse(FAN.replace('"{{ item }}"', '"{{ length(item.xs) }}"'));

    expect(result.ok ? result.definition.steps[0]?.env : result.diagnostics.map(formatDiagnostic)).toEqual({ TARGET: '{{ length(item.xs) }}' });
  });

  it('rejects an if that reads item in a step without for_each', () => {
    expect(rejected(ITEM_TEXT.replace('    command: ansible', '    if: item.x == 1\n    command: ansible'))).toEqual([
      { message: `${FILE}:11: field "steps[1].if": step "play" if reads item, which is bound only in the templates of a for_each step and in the workflow each item runs` },
    ]);
  });

  it.each([
    ['if', "    if: item != 'docs'\n", 'if'],
    ['for_each', '', 'for_each'],
  ])('rejects item in the %s of a for_each step, which is evaluated once before any item', (_what, line, field) => {
    const content = FAN.replace('    for_each: inputs.targets\n', `${line}    for_each: ${field === 'for_each' ? 'item.targets' : 'inputs.targets'}\n`);
    expect(rejected(content)).toEqual([
      { message: `${FILE}:8: field "steps[0].${field}": step "build" ${field} reads item, which is bound only in the templates of a for_each step and in the workflow each item runs` },
    ]);
  });

  it.each([
    ['a list', '[a, b]', 'steps[0].for_each', 'step "build" for_each must be an expression, or a map of items and max_parallel'],
    ['a map without items', '{ max_parallel: 2 }', 'steps[0].for_each.items', 'step "build" for_each.items must be an expression'],
    ['max_parallel 0', '{ items: inputs.targets, max_parallel: 0 }', 'steps[0].for_each.max_parallel', 'step "build" for_each.max_parallel must be a whole number from 1'],
  ])('rejects a for_each that is %s, so a kept copy cannot run the step once', (_what, value, field, message) => {
    expect(rejected(FAN.replace('for_each: inputs.targets', `for_each: ${value}`))).toEqual([
      { message: `${FILE}:8: field "${field}": ${message}`, code: 'bad_loop' },
    ]);
  });

  it('rejects a read of the outputs of a for_each step, whose outputs are per item', () => {
    const content = `${FAN.replace('    env:\n', '    output: { ok: boolean }\n    env:\n')}  - id: report
    needs: [build]
    if: steps.build.outputs.ok
    command: node report.js
`;
    expect(rejected(content)).toEqual([
      { message: `${FILE}:15: field "steps[1].if": step "report" if reads steps.build.outputs, but step "build" has for_each, so its outputs are in steps.build.results` },
    ]);
  });

  it('rejects a read of the results of a step without for_each', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Build.
steps:
  - id: build
    command: node build.js
  - id: report
    needs: [build]
    if: any(steps.build.results, .outcome == 'failed')
    command: node report.js
`)).toEqual([
      { message: `${FILE}:9: field "steps[1].if": step "report" if reads steps.build.results, but step "build" has no for_each, so it has no results` },
    ]);
  });

  it('reports a rejected for_each step once, not again at each read of its results', () => {
    const content = `${FAN.replace('node build.js', 'node build.js {{ item }}')}  - id: report
    needs: [build]
    if: any(steps.build.results, .outcome == 'failed')
    command: node report.js
`;
    expect(rejected(content)).toEqual([
      { message: `${FILE}:9: field "steps[0].command": step "build" command contains {{ item }}; command strings are not templated; pass the value through env:` },
    ]);
  });

  it('rejects item in a command, which is never rendered', () => {
    expect(rejected(FAN.replace('node build.js', 'node build.js {{ item.name }}'))).toEqual([
      { message: `${FILE}:9: field "steps[0].command": step "build" command contains {{ item.name }}; command strings are not templated; pass the value through env:` },
    ]);
  });
});

const TRIAGE = `schemaVersion: v1alpha1
name: build
description: Triage the builds.
inputs:
  packages: [{ id: string }]
steps:
  - id: plan
    command: node plan.js
    output:
      title: string
      files: [{ path: string }]
  - id: build
    needs: [plan]
    for_each: inputs.packages
    command: node build.js
  - id: other
    needs: []
    command: node other.js
  - id: fix
    needs: [build]
    prompt: "Fix {{ length(filter(steps.build.results, .outcome == 'failed')) }} builds: {{ filter(steps.build.results, .outcome == 'failed') }}."
`;
const FIX_PROMPT = `"Fix {{ length(filter(steps.build.results, .outcome == 'failed')) }} builds: {{ filter(steps.build.results, .outcome == 'failed') }}."`;

describe('expressions in templates', () => {
  it('accepts an expression in a template and keeps the text to render when the step starts', () => {
    const result = parse(TRIAGE);

    expect(result.ok ? result.definition.steps[3]?.prompt : result.diagnostics.map(formatDiagnostic))
      .toBe("Fix {{ length(filter(steps.build.results, .outcome == 'failed')) }} builds: {{ filter(steps.build.results, .outcome == 'failed') }}.");
  });

  it.each([
    ['a double-quoted string', '{{ filter(steps.build.results, .outcome == "failed") }}', "strings use single quotes, as in 'failed'"],
    ['= for ==', "{{ any(steps.build.results, .outcome = 'failed') }}", 'any is called as any(list, predicate)'],
    ['a field a step does not have', '{{ length(steps.build.result) }}',
      '"steps.build.result" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.outputs, steps.<id>.passes or steps.<id>.results'],
    ['a string compared with <', "{{ length(steps.build.results) < 'x' }}", "compares 'x' with <, but it is not a number"],
  ])('rejects a call with %s, with the parse error', (_case, text, message) => {
    expect(rejected(TRIAGE.replace(FIX_PROMPT, `'Fix ${text.replaceAll("'", "''")}.'`))).toEqual([
      { message: `${FILE}:21: field "steps[3].prompt": step "fix" prompt template ${text}: ${message}`, code: 'bad_template' },
    ]);
  });

  it('rejects an expression in a template that reads a step its step does not need, as in an if', () => {
    expect(rejected(TRIAGE.replace(FIX_PROMPT, `"Fix it if {{ steps.other.outcome == 'success' }}."`))).toEqual([
      { message: `${FILE}:21: field "steps[3].prompt": step "fix" prompt reads steps.other, which is not a step it needs, directly or through its needs`, code: 'bad_template' },
    ]);
  });

  it('checks the types an expression in a template reads, as in an if', () => {
    expect(rejected(TRIAGE.replace(FIX_PROMPT, '"Fix {{ length(steps.plan.outputs.title) }} and {{ filter(steps.plan.outputs.files, .finding) }}."'))).toEqual([
      { message: `${FILE}:21: field "steps[3].prompt": step "fix" prompt passes steps.plan.outputs.title to length as its list, but it is not an array`, code: 'bad_template' },
      { message: `${FILE}:21: field "steps[3].prompt": step "fix" prompt reads .finding, which is not in an item of steps.plan.outputs.files`, code: 'bad_template' },
    ]);
  });

  it('rejects a call in a command, which is never rendered', () => {
    expect(rejected(TRIAGE.replace('node other.js', 'node other.js {{ length(inputs.packages) }}'))).toEqual([
      { message: `${FILE}:18: field "steps[2].command": step "other" command contains {{ length(inputs.packages) }}; command strings are not templated; pass the value through env:` },
    ]);
  });
});

describe('step model and defaults', () => {
  it('reports model on a command or workflow step, with the file and step', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: compile
    command: npm run build
    model: strong
  - id: check
    needs: [compile]
    workflow:
      steps:
        - id: lint
          command: npm run lint
    model: fast
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].model": model is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:14: field "steps[1].model": model is only allowed on a prompt or prompt_file step',
    ]);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === undefined)).toBe(true);
  });

  it('reports a templated model on a step and in defaults as a validation error', () => {
    for (const template of ['${{ inputs.m }}', '{{ inputs.m }}']) {
      const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
inputs:
  m: string
defaults:
  model: "${template}"
steps:
  - id: plan
    prompt: Plan it.
    model: "${template}"
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.map(formatDiagnostic)).toEqual([
        'workflows/build.yaml:7: field "defaults.model": model cannot contain a template; write an alias or a model name as is',
        'workflows/build.yaml:11: field "steps[0].model": model cannot contain a template; write an alias or a model name as is',
      ]);
    }
  });

  it('keeps a prompt step model and defaults.model as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  model: fast
steps:
  - id: plan
    prompt: Plan it.
    model: strong
  - id: review
    needs: [plan]
    prompt_file: prompts/review.md
    agent: reviewer
    model: claude-opus-4.1
  - id: summary
    needs: [review]
    prompt: Summarize it.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.defaults).toEqual({ model: 'fast' });
    expect(result.definition.steps.map((step) => step.model)).toEqual(['strong', 'claude-opus-4.1', undefined]);
  });

  it('rejects a model that is empty, not a string, or has spaces', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  model: 3
steps:
  - id: plan
    prompt: Plan it.
    model: ''
  - id: review
    needs: [plan]
    prompt: Review it.
    model: claude opus
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "defaults.model": model must be a non-empty string without spaces',
      'workflows/build.yaml:9: field "steps[0].model": model must be a non-empty string without spaces',
      'workflows/build.yaml:13: field "steps[1].model": model must be a non-empty string without spaces',
    ]);
  });

  it('reports a defaults key this version does not know as unknown_key, and defaults that are not a mapping', () => {
    const unknown = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  model: fast
  requires: [git]
steps:
  - id: plan
    prompt: Plan it.
`);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.diagnostics).toEqual([expect.objectContaining({ field: 'defaults.requires', line: 6, code: 'unknown_key' })]);

    const scalar = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults: fast
steps:
  - id: plan
    prompt: Plan it.
`);
    expect(scalar.ok).toBe(false);
    if (scalar.ok) return;
    expect(scalar.diagnostics.map(formatDiagnostic)).toEqual(['workflows/build.yaml:4: field "defaults": defaults must be a mapping']);
  });

  it('reports defaults on an inline workflow, which carries none', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: check
    workflow:
      defaults:
        model: fast
      steps:
        - id: plan
          prompt: Plan it.
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].workflow.defaults": step "check" runs an inline workflow, which carries only steps, outputs, ends, and loop',
    ]);
    expect(result.diagnostics[0]?.code).toBeUndefined();
  });
});

