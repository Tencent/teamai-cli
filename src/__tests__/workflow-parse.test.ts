import { describe, expect, it } from 'vitest';
import { stepWorkflow } from '../workflow/types.js';
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
      expect.objectContaining({ field: 'steps[0]', message: 'a step has exactly one action: command, prompt, prompt_file, answer, or workflow' }),
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
    future_option: 10m
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'unknown_key',
        field: 'steps[0].future_option',
        message: 'workflows/build.yaml uses `future_option`, which this teamai does not know. Update teamai.',
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

describe('a workflow header workspace', () => {
  const HEADER = `schemaVersion: v1alpha1
name: build
description: Review and fix in one copy.
`;
  const STEPS = `steps:
  - id: review
    command: node review.js
`;

  it('accepts workspace: new, which the definition keeps', () => {
    const result = parse(`${HEADER}workspace: new\n${STEPS}`);
    expect(result.ok && result.definition.workspace).toBe('new');
  });

  it('rejects any other header workspace', () => {
    expect(rejected(`${HEADER}workspace: continue\n${STEPS}`)).toEqual([
      { message: `${FILE}:4: field "workspace": workspace in a workflow header must be new, so its steps work in one copy; set workspace on a step for any other mode`, code: 'bad_workspace' },
    ]);
  });

  it('rejects deliver in the header, pointing at the step that runs the workflow', () => {
    expect(rejected(`${HEADER}workspace: new\ndeliver: pr\n${STEPS}`)).toEqual([
      { message: `${FILE}:5: field "deliver": a workflow header takes no deliver; delivery belongs to a step, so run this workflow from a step with deliver: pr`, code: 'bad_delivery' },
    ]);
  });

  it('refuses a role on a step continuing the copy the run opens with another, naming defaults.role as where the copy gets its role', () => {
    expect(rejected(`${HEADER}workspace: new
defaults: { role: review }
steps:
  - id: fix
    role: spec
    prompt: Fix it.
`)).toEqual([
      { code: 'bad_role', message: `${FILE}:8: field "steps[0].role": step "fix" has role spec but continues the copy the run opens with role review, which every step there runs with; remove role from step "fix", or set it as defaults.role` },
    ]);
  });

  it('rejects a read-only step that runs a workflow whose header says workspace: new, naming both', () => {
    const child = parse(`schemaVersion: v1alpha1
name: review-and-fix
description: Review and fix in one copy.
workspace: new
${STEPS}`, 'workflows/review-and-fix.yaml');
    if (!child.ok) throw new Error(child.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'review-and-fix' ? child.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `${HEADER}steps:
  - id: check
    workspace: read-only
    workflow: review-and-fix
`, files);
    expect(result.ok ? [] : result.diagnostics.map((diagnostic) => ({ message: formatDiagnostic(diagnostic), code: diagnostic.code }))).toEqual([
      { message: `${FILE}:6: field "steps[0].workspace": step "check" has workspace: read-only but runs workflow "review-and-fix", whose header says workspace: new, so its steps work in a copy; remove workspace from step "check" so it opens or continues one`, code: 'bad_workspace' },
    ]);
  });
});

describe('deliver', () => {
  const FIX = `schemaVersion: v1alpha1
name: build
description: Fix a bug.
steps:
  - id: fix
`;

  it('parses deliver: pr on a step that writes a branch', () => {
    const result = parse(`${FIX}    command: node fix.js
    workspace: new
    deliver: pr
`);
    expect(result.ok && result.definition.steps[0]).toMatchObject({ deliver: 'pr' });
  });

  it('rejects a delivery other than pr, and deliver: pr on a step that can only read', () => {
    expect(rejected(`${FIX}    prompt: Fix it.
    deliver: merge
`)).toEqual([{ message: `${FILE}:7: field "steps[0].deliver": step "fix" deliver must be pr or publish; TeamAI opens a pull request, or publishes to a teamai data branch, and never merges`, code: 'bad_delivery' }]);
    expect(rejected(`${FIX}    prompt: Fix it.
    workspace: read-only
    deliver: pr
`)).toEqual([{ message: `${FILE}:8: field "steps[0].deliver": step "fix" has deliver: pr but runs read-only; set workspace: new so it has a branch to deliver`, code: 'bad_delivery' }]);
    expect(rejected(`${FIX}    command: node fix.js
    deliver: pr
`)).toEqual([{ message: `${FILE}:7: field "steps[0].deliver": step "fix" has deliver: pr but runs read-only, as a command without workspace does; set workspace: new so it has a branch to deliver`, code: 'bad_delivery' }]);
  });

  it.each(['teamai-reports', 'teamai-learnings'])('parses deliver: publish on a step in the team workspace of the data branch %s', (branch) => {
    const result = parse(`${FIX}    command: teamai score publish
    workspace: { team: { branch: ${branch} } }
    deliver: publish
`);
    expect(result.ok && result.definition.steps[0]).toMatchObject({ deliver: 'publish', workspace: { team: { branch } } });
  });

  it('rejects deliver: publish outside the team workspace of a teamai data branch', () => {
    const NOT_DATA = 'is not a teamai data branch; publish to teamai-reports or teamai-learnings';
    expect(rejected(`${FIX}    command: teamai score publish
    workspace: new
    deliver: publish
`)).toEqual([{ message: `${FILE}:8: field "steps[0].deliver": step "fix" has deliver: publish but runs in no team workspace; give it workspace: { team: { branch: teamai-reports } }`, code: 'bad_delivery' }]);
    expect(rejected(`${FIX}    command: teamai score publish
    workspace: { team: {} }
    deliver: publish
`)).toEqual([{ message: `${FILE}:8: field "steps[0].deliver": step "fix" has deliver: publish to the run's own team branch, which ${NOT_DATA}`, code: 'bad_delivery' }]);
    expect(rejected(`${FIX}    command: teamai score publish
    workspace: { team: { branch: main } }
    deliver: publish
`)).toEqual([{ message: `${FILE}:8: field "steps[0].deliver": step "fix" has deliver: publish to team branch main, which ${NOT_DATA}`, code: 'bad_delivery' }]);
  });
});

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
    const retry = result.definition.steps[2] && stepWorkflow(result.definition.steps[2]);
    expect(retry?.kind === 'inline' ? retry.workflow.loop : undefined).toEqual({ maxIterations: 2 });
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

  /** FAN with a number input `concurrency`, a plan step, and `max_parallel` as written. */
  const fanWith = (maxParallel: string): string => FAN
    .replace('  targets: [string]\n', '  targets: [string]\n  concurrency: number\n  label: string\n')
    .replace('steps:\n', 'steps:\n  - id: plan\n    command: node plan.js\n    output: { width: number }\n')
    .replace('    for_each: inputs.targets\n', `    needs: [plan]\n    for_each: { items: inputs.targets, max_parallel: ${maxParallel} }\n`);

  it('reads a max_parallel template of a number input as written', () => {
    const result = parse(fanWith('"{{ inputs.concurrency }}"'));

    expect(result.ok ? result.definition.steps[1]?.forEach : result.diagnostics.map(formatDiagnostic)).toEqual({ items: 'inputs.targets', maxParallel: { template: '{{ inputs.concurrency }}' } });
  });

  it.each([
    ['reads a step', '"{{ steps.plan.outputs.width }}"', 'template {{ steps.plan.outputs.width }}: a max_parallel template reads only a number input'],
    ['reads item', '"{{ item }}"', 'template {{ item }}: a max_parallel template reads only a number input'],
    ['reads a string input', '"{{ inputs.label }}"', 'template {{ inputs.label }}: a max_parallel template reads only a number input'],
    ['adds text to the read', '"{{ inputs.concurrency }}0"', 'template {{ inputs.concurrency }}0: a max_parallel template is one {{ … }} and nothing else, so it renders a whole number'],
    ['is text with no template', '"four"', 'template four: a max_parallel template is one {{ … }} and nothing else, so it renders a whole number'],
  ])('rejects a max_parallel template that %s, which may not render a whole number from 1', (_what, value, problem) => {
    expect(rejected(fanWith(value))).toEqual([
      { message: `${FILE}:14: field "steps[1].for_each.max_parallel": step "build" for_each.max_parallel ${problem}`, code: 'bad_template' },
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

  it('reads the pull request of a step, a workflow step, each for_each item and each pass with deliver: pr, and passes it out as an output', () => {
    expect(parse(`schemaVersion: v1alpha1
name: build
description: Build and deliver.
inputs:
  targets: [string]
outputs:
  pr: steps.fix.pr
steps:
  - id: fix
    workspace: new
    deliver: pr
    workflow:
      steps:
        - id: patch
          workspace: continue
          command: node patch.js
  - id: build
    needs: []
    for_each: inputs.targets
    workspace: new
    command: node build.js
    deliver: pr
  - id: bump
    needs: []
    workspace: new
    command: node bump.js
    deliver: pr
    loop: { back_to: bump, while: "steps.bump.passes[0].pr == null", max_iterations: 2 }
  - id: report
    needs: [fix, build, bump]
    if: steps.fix.pr == null || steps.bump.pr != null
    env:
      FIX: "{{ steps.fix.pr.url }}"
      FIRST: "{{ steps.build.results[0].pr.url }}"
    command: node report.js
`)).toMatchObject({ ok: true });
  });

  it('rejects a read of the pull request of a step without deliver: pr', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Build.
steps:
  - id: build
    workspace: new
    command: node build.js
  - id: report
    needs: [build]
    if: steps.build.pr != null
    command: node report.js
`)).toEqual([
      { message: `${FILE}:10: field "steps[1].if": step "report" if reads steps.build.pr, but step "build" has no deliver: pr, so it has no pr` },
    ]);
  });

  it('rejects a read of the pull request of a for_each step, whose pull requests are per item', () => {
    const content = `${FAN.replace('    for_each: inputs.targets\n', '    for_each: inputs.targets\n    workspace: new\n    deliver: pr\n')}  - id: report
    needs: [build]
    if: steps.build.pr != null
    command: node report.js
`;
    expect(rejected(content)).toEqual([
      { message: `${FILE}:16: field "steps[1].if": step "report" if reads steps.build.pr, but step "build" has for_each, so its pr is in steps.build.results` },
    ]);
  });

  it('rejects a read of a pull request field other than url', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Build.
steps:
  - id: build
    workspace: new
    command: node build.js
    deliver: pr
  - id: report
    needs: [build]
    if: steps.build.pr.number > 0
    command: node report.js
`)).toEqual([
      { message: `${FILE}:11: field "steps[1].if": step "report" if reads steps.build.pr.number, which is not in a pull request: url` },
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
      '"steps.build.result" must read steps.<id>.outcome, steps.<id>.end, steps.<id>.failure, steps.<id>.choice, steps.<id>.note, steps.<id>.outputs, steps.<id>.passes, steps.<id>.results, steps.<id>.branches or steps.<id>.pr'],
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

describe('step tool', () => {
  it('keeps a prompt step tool as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    tool: codex
  - id: review
    needs: [plan]
    prompt: Review it.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.tool)).toEqual(['codex', undefined]);
  });

  it('rejects a tool off a prompt step, and a tool that is not a name', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: compile
    command: npm run build
    tool: codex
  - id: plan
    needs: [compile]
    prompt: Plan it.
    tool: "{{ inputs.tool }}"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].tool": tool is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:11: field "steps[1].tool": tool must be the id of a tool, such as claude or codex, written as is',
    ]);
  });
});

describe('exact step model', () => {
  it('keeps an exact model as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    model: { name: gpt-5.1-codex, effort: high }
  - id: review
    needs: [plan]
    prompt: Review it.
    model: { name: claude-opus-4.1 }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.model)).toEqual([{ name: 'gpt-5.1-codex', effort: 'high' }, { name: 'claude-opus-4.1' }]);
  });

  it('rejects an exact model without a name, or with a key or a value it does not take', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: review
    prompt: Review it.
    model: { effort: high }
  - id: ship
    needs: [review]
    prompt: Ship it.
    model: { name: opus, effort: very high, speed: fast }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].model": model must be an alias or a model name, or { name, effort? } with the exact model',
      'workflows/build.yaml:11: field "steps[1].model": model must be an alias or a model name, or { name, effort? } with the exact model',
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

  it('reports a templated defaults.model as a validation error', () => {
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
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.map(formatDiagnostic)).toEqual([
        'workflows/build.yaml:7: field "defaults.model": model cannot contain a template; write an alias or a model name as is',
      ]);
    }
  });

  it('keeps a step model template that reads an input, the item, or the outputs of a step it needs, as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
inputs:
  judge: string
steps:
  - id: plan
    command: echo plan
    output:
      model: string
      groups: [{ model: string }]
  - id: label
    needs: [plan]
    for_each: steps.plan.outputs.groups
    prompt: Label it.
    model: "{{ item.model }}"
  - id: sum
    needs: [plan]
    prompt: Sum it.
    model: "claude-{{ steps.plan.outputs.model }}"
  - id: pick
    needs: []
    prompt: Pick one.
    model: "{{ inputs.judge }}"
`);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([]);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.model)).toEqual([undefined, '{{ item.model }}', 'claude-{{ steps.plan.outputs.model }}', '{{ inputs.judge }}']);
  });

  it('refuses a step model template that reads anything but an input, the item, or the outputs of a step the step needs', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
inputs:
  m: string
steps:
  - id: plan
    command: echo plan
    output:
      model: string
  - id: other
    needs: []
    command: echo other
    output:
      model: string
  - id: a
    needs: [plan]
    prompt: Run it.
    model: "{{ run.id }}"
  - id: b
    needs: [plan]
    prompt: Run it.
    model: "{{ steps.plan.outcome }}"
  - id: c
    needs: [plan]
    prompt: Run it.
    model: "{{ steps.other.outputs.model }}"
  - id: d
    needs: []
    prompt: Run it.
    model: "{{ item.model }}"
  - id: e
    needs: []
    prompt: Run it.
    model: "\${{ inputs.m }}"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const READS = 'a model template reads only inputs, item and the outputs of steps the step needs';
    const LITERAL = 'text outside a template cannot hold a space or {{, and {{ item }} is a template only where for_each binds an item';
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      `workflows/build.yaml:19: field "steps[2].model": step "a" model template {{ run.id }}: ${READS}`,
      `workflows/build.yaml:23: field "steps[3].model": step "b" model template {{ steps.plan.outcome }}: ${READS}`,
      `workflows/build.yaml:31: field "steps[5].model": step "d" model template {{ item.model }}: ${LITERAL}`,
      `workflows/build.yaml:35: field "steps[6].model": step "e" model template \${{ inputs.m }}: ${LITERAL}`,
      'workflows/build.yaml:27: field "steps[4].model": step "c" model reads steps.other, which is not a step it needs, directly or through its needs',
    ]);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'bad_template')).toBe(true);
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
  retries: 2
steps:
  - id: plan
    prompt: Plan it.
`);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.diagnostics).toEqual([expect.objectContaining({ field: 'defaults.retries', line: 6, code: 'unknown_key' })]);

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

  it('keeps a default of each input it declares, of the input\'s type', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Score it.
inputs: { subject: string, files: [string], store: boolean, demand: auto | named }
defaults:
  inputs: { files: [], store: true, demand: auto }
steps:
  - id: plan
    command: echo plan
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.defaults).toEqual({ inputs: { files: [], store: true, demand: 'auto' } });
  });

  it('refuses an input default that does not fit the input\'s type, and one of an input the file does not declare', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Score it.
inputs: { files: [string], store: boolean, demand: auto | named }
defaults:
  inputs:
    files: [1]
    store: "yes"
    demand: someone
    colour: blue
steps:
  - id: plan
    command: echo plan
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "defaults.inputs.files": defaults.inputs.files[0] must be a string',
      'workflows/build.yaml:8: field "defaults.inputs.store": defaults.inputs.store must be a boolean',
      'workflows/build.yaml:9: field "defaults.inputs.demand": defaults.inputs.demand must be one of auto, named',
      'workflows/build.yaml:10: field "defaults.inputs.colour": defaults.inputs.colour is not an input this workflow declares in inputs',
    ]);
  });

  it('parses requires on a step and in defaults', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  requires: { network: false }
steps:
  - id: plan
    prompt: Plan it.
    requires: { network: true, isolation: sandbox }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.defaults).toEqual({ requires: { network: false } });
    expect(result.definition.steps[0]?.requires).toEqual({ network: true, isolation: 'sandbox' });
  });

  it('refuses a step under a strict sandbox whose requires.env names a credential the sandbox withholds', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  requires: { isolation: sandbox, strict: true }
steps:
  - id: plan
    prompt: Plan it.
    requires: { env: [GH_TOKEN] }
  - id: ship
    needs: [plan]
    workflow:
      steps:
        - id: push
          command: git push
          requires: { env: [NPM_TOKEN, SSH_AUTH_SOCK] }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[0].requires.env": steps[0].requires.env names GH_TOKEN, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.',
      'workflows/build.yaml:16: field "steps[1].workflow.steps[0].requires.env": steps[1].workflow.steps[0].requires.env names SSH_AUTH_SOCK, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.',
    ]);
  });

  it('refuses a strict sandbox in defaults whose requires.env names a credential the sandbox withholds', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  requires: { isolation: sandbox, strict: true, env: [GH_TOKEN] }
steps:
  - id: plan
    prompt: Plan it.
`);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:5: field "defaults.requires.env": defaults.requires.env names GH_TOKEN, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.',
    ]);
  });

  it('refuses a step under a strict sandbox that runs a workflow file whose requires.env names a credential the sandbox withholds', () => {
    const check = parse(`schemaVersion: v1alpha1
name: check
description: Check it.
defaults:
  requires: { env: [GH_TOKEN] }
steps:
  - id: lint
    command: npm run lint
  - id: push
    needs: [lint]
    command: git push
    requires: { env: [NPM_TOKEN, SSH_AUTH_SOCK] }
`, 'workflows/check.yaml');
    if (!check.ok) throw new Error(check.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'check' ? check.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Build, then check.
steps:
  - id: compile
    command: npm run build
  - id: check
    needs: [compile]
    workflow: check
    requires: { isolation: sandbox, strict: true }
`, files);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].workflow": steps[1].workflow runs workflow "check", whose defaults.requires.env names GH_TOKEN, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.',
      'workflows/build.yaml:9: field "steps[1].workflow": steps[1].workflow runs workflow "check", whose steps[1].requires.env names SSH_AUTH_SOCK, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.',
    ]);
  });

  it('accepts a step under a strict sandbox that runs workflow files calling each other', () => {
    const named = (name: string, runs: string) => parse(`schemaVersion: v1alpha1
name: ${name}
description: Run ${runs}.
steps:
  - id: next
    workflow: ${runs}
`, `workflows/${name}.yaml`);
    const ping = named('ping', 'pong');
    const pong = named('pong', 'ping');
    if (!ping.ok || !pong.ok) throw new Error('ping and pong must parse');
    const files = { runnable: (name: string) => (name === 'ping' ? ping.definition : name === 'pong' ? pong.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Build, then ping.
steps:
  - id: ping
    workflow: ping
    requires: { isolation: sandbox, strict: true }
`, files);
    expect(result.ok).toBe(true);
  });

  it('accepts a credential in requires.env under a sandbox that is not strict', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    requires: { isolation: sandbox, env: [GH_TOKEN] }
`);
    expect(result.ok).toBe(true);
  });

  it('reports a requires key this version does not know as unknown_key, a value of the wrong type, and requires on a step with no action', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  requires: [network]
steps:
  - id: plan
    prompt: Plan it.
    requires: { network: maybe, isolation: vm, gpu: true }
  - id: done
    needs: [plan]
    end: shipped
    requires: { network: true }
ends: { shipped: succeeded }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:5: field "defaults.requires": defaults.requires must map network, isolation, env, strict to values',
      expect.stringMatching(/^workflows\/build\.yaml:9: field "steps\[0\]\.requires\.network": steps\[0\]\.requires\.network: .*boolean.*string$/),
      expect.stringMatching(/field "steps\[0\]\.requires\.isolation": steps\[0\]\.requires\.isolation: .*"none".*"worktree".*"sandbox"/),
      expect.stringContaining('field "steps[1].requires": step "done" has no action'),
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'steps[0].requires.gpu', code: 'unknown_key' }));
  });

  it('reads a timeout in days', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
timeout: 2d
steps:
  - id: plan
    prompt: Plan it.
    timeout: 1d
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.timeout).toBe(172_800_000);
    expect(result.definition.steps.map((step) => step.timeout)).toEqual([86_400_000]);
  });

  it('reads timeout on the file and on a step as milliseconds', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
timeout: 2h
steps:
  - id: plan
    prompt: Plan it.
    timeout: 30s
  - id: check
    needs: [plan]
    command: echo check
    timeout: 500ms
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.timeout).toBe(7_200_000);
    expect(result.definition.steps.map((step) => step.timeout)).toEqual([30_000, 500]);
  });

  it('reports a timeout that is not a positive duration, and timeout on an inline workflow or a step with no action', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
timeout: soon
steps:
  - id: plan
    prompt: Plan it.
    timeout: 0s
  - id: check
    needs: [plan]
    workflow:
      timeout: 1m
      steps:
        - id: inner
          command: echo inner
  - id: done
    needs: [check]
    end: shipped
    timeout: 1m
ends: { shipped: succeeded }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:4: field "timeout": timeout must be a positive duration, such as 500ms, 30s, 10m, 2h, or 14d',
      'workflows/build.yaml:8: field "steps[0].timeout": steps[0].timeout must be a positive duration, such as 500ms, 30s, 10m, 2h, or 14d',
      expect.stringContaining('field "steps[1].workflow.timeout": step "check" runs an inline workflow'),
      expect.stringContaining('field "steps[2].timeout": step "done" has no action'),
    ]));
  });

  it('reads a token budget on the file and on a workflow step', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
budget: { tokens: 20000 }
steps:
  - id: check
    workflow:
      steps:
        - id: inner
          prompt: Check it.
    budget: { tokens: 500 }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.budget).toEqual({ tokens: 20000 });
    expect(result.definition.steps[0]?.budget).toEqual({ tokens: 500 });
  });

  it('reports a budget that is not a positive token count, a budget key this version does not know, and a budget on a step that runs no workflow', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
budget: { tokens: 0 }
steps:
  - id: plan
    prompt: Plan it.
    budget: { tokens: 10 }
  - id: check
    needs: [plan]
    workflow: check
    budget: { tokens: 10, dollars: 5 }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:4: field "budget.tokens": budget.tokens must be a positive whole number of tokens',
      'workflows/build.yaml:8: field "steps[0].budget": step "plan" budget is only allowed on a workflow step, or on a prompt step with on_limit: end_turn',
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'steps[1].budget.dollars', code: 'unknown_key' }));
  });

  it('reads setup on the file, and reports a setup without a command, an inline one, and a key this version does not know', () => {
    const ok = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
steps:
  - id: plan
    workspace: new
    prompt: Plan it.
`);
    expect(ok.ok && ok.definition.setup).toEqual({ command: 'npm ci', requires: { env: ['NPM_TOKEN'] } });
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
setup: { timeout: 1m, requires: { network: false } }
steps:
  - id: check
    workflow:
      setup: { command: npm ci }
      steps:
        - id: inner
          command: echo inner
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      expect.stringContaining('field "setup.command": setup.command'),
      expect.stringContaining('field "steps[0].workflow.setup": step "check" runs an inline workflow'),
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'setup.timeout', code: 'unknown_key' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ field: 'setup.requires.network', code: 'unknown_key' }));
  });

  it('reads max_turns on a prompt step, and reports it on another step or when it is not a positive whole number', () => {
    const ok = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    max_turns: 30
`);
    expect(ok.ok && ok.definition.steps[0]?.maxTurns).toBe(30);
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    max_turns: many
  - id: check
    needs: [plan]
    command: echo check
    max_turns: 3
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:7: field "steps[0].max_turns": step "plan" max_turns must be a positive whole number',
      'workflows/build.yaml:11: field "steps[1].max_turns": step "check" max_turns is only allowed on a prompt or prompt_file step',
    ]));
  });

  it('reads permissions: unattended on a prompt step, and reports another value or the key on another step', () => {
    const ok = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    permissions: unattended
`);
    expect(ok.ok && ok.definition.steps[0]?.permissions).toBe('unattended');
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    permissions: ask
  - id: check
    needs: [plan]
    command: echo check
    permissions: unattended
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:7: field "steps[0].permissions": step "plan" permissions must be unattended, which lets the tool edit and run commands without asking',
      'workflows/build.yaml:11: field "steps[1].permissions": step "check" permissions is only allowed on a prompt or prompt_file step',
    ]));
  });

  it('reads on_limit on a prompt step with a limit, a budget on that prompt, and on_limit on a workflow step with a timeout', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    timeout: 2m
    budget: { tokens: 5000 }
    on_limit: end_turn
  - id: check
    needs: [plan]
    workflow: check
    timeout: 10m
    on_limit: end_turn
  - id: ship
    needs: [check]
    prompt: Ship it.
    max_turns: 3
    on_limit: fail
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.onLimit)).toEqual(['end_turn', 'end_turn', 'fail']);
    expect(result.definition.steps[0]?.budget).toEqual({ tokens: 5000 });
  });

  it('reports on_limit on a step it cannot end, without a limit, with a value this version does not know, or on a for_each step, and a prompt budget without end_turn', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    on_limit: end_turn
  - id: check
    needs: [plan]
    command: echo check
    timeout: 1m
    on_limit: end_turn
  - id: review
    needs: [check]
    prompt: Review it.
    timeout: 1m
    on_limit: stop
  - id: ship
    needs: [review]
    workflow: ship
    max_turns: 3
    on_limit: end_turn
  - id: tidy
    needs: [ship]
    prompt: Tidy it.
    budget: { tokens: 10 }
  - id: each
    needs: [tidy]
    for_each: [a, b]
    workflow: ship
    timeout: 1m
    on_limit: end_turn
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual(expect.arrayContaining([
      'workflows/build.yaml:7: field "steps[0].on_limit": step "plan" on_limit needs a timeout, max_turns or budget to end the turn at',
      'workflows/build.yaml:12: field "steps[1].on_limit": step "check" on_limit is only allowed on a prompt, prompt_file or workflow step',
      'workflows/build.yaml:17: field "steps[2].on_limit": step "review" on_limit must be end_turn or fail',
      'workflows/build.yaml:22: field "steps[3].on_limit": step "ship" on_limit on a workflow step needs a timeout or budget, which its prompts spend',
      'workflows/build.yaml:26: field "steps[4].budget": step "tidy" budget is only allowed on a workflow step, or on a prompt step with on_limit: end_turn',
      'workflows/build.yaml:32: field "steps[5].on_limit": step "each" on_limit is not allowed on a for_each step',
    ]));
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


describe('step scorers', () => {
  it('reads the short and the long form on prompt and workflow steps, and defaults.scorers.batch', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  scorers: { batch: true }
steps:
  - id: plan
    prompt: Plan it.
    scorers: [quality, scope]
  - id: check
    needs: [plan]
    workflow:
      steps:
        - id: lint
          prompt: Lint it.
    scorers: { names: [quality], batch: false }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.defaults).toEqual({ scorers: { batch: true } });
    expect(result.definition.steps.map((step) => step.scorers)).toEqual([
      { names: ['quality', 'scope'] },
      { names: ['quality'], batch: false },
    ]);
  });

  it('lists a generated scorer, whose name holds a colon, beside a team one', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Fix it.
steps:
  - id: fix
    prompt: Fix it.
    scorers: { names: [quality, "teamai:correctness:fix"], sampling: all }
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.scorers?.names).toEqual(['quality', 'teamai:correctness:fix']);
  });

  it('reports scorers on a command step, an empty or repeated list, a name that is not a token, and a bad batch', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: compile
    command: npm run build
    scorers: [quality]
  - id: plan
    needs: [compile]
    prompt: Plan it.
    scorers: []
  - id: review
    needs: [plan]
    prompt: Review it.
    scorers: [quality, quality, "a b"]
  - id: ship
    needs: [review]
    prompt: Ship it.
    scorers: { names: [quality], batch: yes please }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].scorers": scorers is only allowed on a prompt, prompt_file, or workflow step',
      'workflows/build.yaml:11: field "steps[1].scorers": scorers must list scorer names, as [name, …] or { names: [name, …], batch: true }',
      'workflows/build.yaml:15: field "steps[2].scorers": scorers lists "quality" twice',
      'workflows/build.yaml:15: field "steps[2].scorers": scorer "a b" must be a token, the name of a file in scorers/',
      'workflows/build.yaml:19: field "steps[3].scorers.batch": batch must be true or false',
    ]);
  });

  it('reads sampling: all, which judges every pass, and refuses any other sampling', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    scorers: { names: [quality], sampling: all }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.scorers).toEqual({ names: ['quality'], sampling: 'all' });

    const refused = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    scorers: { names: [quality], sampling: 50 }
`);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].scorers.sampling": sampling must be all, which judges every pass; leave it out to use each scorer\'s samplingRate',
    ]);
  });

  it('reads who starts the scoring of a step\'s passes, start: auto or workflow, and refuses any other start', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: fix
    prompt: Fix it.
    scorers: { names: [quality], sampling: all, start: workflow }
  - id: review
    needs: [fix]
    prompt: Review it.
    scorers: { names: [quality], start: auto }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.scorers)).toEqual([
      { names: ['quality'], sampling: 'all', start: 'workflow' },
      { names: ['quality'], start: 'auto' },
    ]);

    const refused = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: fix
    prompt: Fix it.
    scorers: { names: [quality], start: later }
`);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].scorers.start": start must be auto, where teamai starts the scoring of each pass, or workflow, where the workflow\'s own steps score them',
    ]);
  });

  it('reports a long form without names, and a name that is not a scalar', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
steps:
  - id: plan
    prompt: Plan it.
    scorers: { sampling: all }
  - id: review
    needs: [plan]
    prompt: Review it.
    scorers: [[quality]]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:7: field "steps[0].scorers": scorers must list scorer names, as [name, …] or { names: [name, …], batch: true }',
      'workflows/build.yaml:11: field "steps[1].scorers": scorer names must be a token, the name of a file in scorers/',
    ]);
  });

  it('reports an unknown key under scorers and defaults.scorers as unknown_key', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build it.
defaults:
  scorers: { batch: true, every: 2 }
steps:
  - id: plan
    prompt: Plan it.
    scorers: { names: [quality], sample: 10 }
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ field: 'defaults.scorers.every', code: 'unknown_key' }),
      expect.objectContaining({ field: 'steps[0].scorers.sample', code: 'unknown_key' }),
    ]);
  });
});

describe('clone place', () => {
  const COMMIT = 'c'.repeat(40);
  const REVISION = 'd'.repeat(40);

  it('keeps a clone place as written', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Try it in clean clones.
steps:
  - id: bare
    workspace: { clone: { commit: ${COMMIT}, team: { treatment: none } } }
    workflow:
      steps:
        - id: work
          prompt: Do it.
  - id: pulled
    needs: []
    workspace:
      clone:
        commit: ${COMMIT}
        repo: https://git.example.com/acme/app.git
        team: { revision: ${REVISION}, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: { without: [lint] } }
    command: npm test
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.workspace)).toEqual([
      { clone: { commit: COMMIT, team: { treatment: 'none' } } },
      { clone: { commit: COMMIT, repo: 'https://git.example.com/acme/app.git', team: { revision: REVISION, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: { without: ['lint'] } } } },
    ]);
  });

  it('rejects a clone place without a full commit, or a team none with a revision', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Try it in clean clones.
steps:
  - id: short
    workspace: { clone: { commit: abc123, team: { treatment: none } } }
    command: npm test
  - id: revised
    needs: []
    workspace: { clone: { commit: ${COMMIT}, team: { revision: ${REVISION}, treatment: none } } }
    command: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].workspace": step "short" workspace must be read-only, new, continue, { team: { branch? } }, { confined: <dir> }, or { clone: { commit, repo?, team } } with a full commit and team { treatment: none } or { revision, selection, treatment }',
      'workflows/build.yaml:10: field "steps[1].workspace": step "revised" workspace must be read-only, new, continue, { team: { branch? } }, { confined: <dir> }, or { clone: { commit, repo?, team } } with a full commit and team { treatment: none } or { revision, selection, treatment }',
    ]);
  });
});

describe('team workspace', () => {
  it('reads the branch a step commits to in the team repo, from inputs and the outputs of steps it needs, or none for the run\'s own', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Tidy the team's rules.
inputs: { topic: string }
steps:
  - id: plan
    command: ./plan.sh
    output: { id: string }
  - id: named
    needs: [plan]
    workspace: { team: { branch: "teamai/tidy/{{ inputs.topic }}/{{ steps.plan.outputs.id }}" } }
    deliver: pr
    command: ./tidy.sh
  - id: own
    needs: [named]
    workspace: { team: {} }
    prompt: Tidy the rules.
`);
    expect(result.ok && result.definition.steps.map((step) => step.workspace)).toEqual([
      undefined,
      { team: { branch: 'teamai/tidy/{{ inputs.topic }}/{{ steps.plan.outputs.id }}' } },
      { team: {} },
    ]);
  });

  it('rejects a branch that reads a step\'s outcome, the run or a step it does not need, and a team workspace on a step that runs a workflow, runs per item, or is scored', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Tidy the team's rules.
inputs: { targets: [string] }
steps:
  - id: plan
    command: ./plan.sh
    output: { topic: string }
  - id: fromStep
    needs: [plan]
    workspace: { team: { branch: "teamai/tidy/{{ steps.plan.outcome }}" } }
    command: ./tidy.sh
  - id: perItem
    needs: []
    for_each: inputs.targets
    workspace: { team: {} }
    command: ./tidy.sh
  - id: scored
    needs: []
    workspace: { team: {} }
    scorers: [review-quality]
    prompt: Tidy the rules.
  - id: fromRun
    needs: []
    workspace: { team: { branch: "teamai/tidy/{{ run.id }}" } }
    command: ./tidy.sh
  - id: unneeded
    needs: []
    workspace: { team: { branch: "teamai/tidy/{{ steps.plan.outputs.topic }}" } }
    command: ./tidy.sh
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const READS = 'workspace team branch may read only inputs and the outputs of steps the step needs, so every run that drafts the same thing goes on with the same branch';
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      `workflows/build.yaml:11: field "steps[1].workspace": step "fromStep" ${READS}`,
      'workflows/build.yaml:16: field "steps[2].workspace": step "perItem" workspace team is only allowed on a command or prompt step that runs once: each step in the team workspace clones the team repo again',
      'workflows/build.yaml:20: field "steps[3].workspace": step "scored" workspace team is not allowed with scorers: the team clone is gone once the step reports, so a scorer could not read what it changed',
      `workflows/build.yaml:25: field "steps[4].workspace": step "fromRun" ${READS}`,
      'workflows/build.yaml:29: field "steps[5].workspace": step "unneeded" workspace team branch reads steps.plan, which is not a step it needs, directly or through its needs',
    ]);
  });

  it('reads a confined directory a prompt step names from its inputs, its item, or a step it needs', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Judge each change from its evidence.
inputs: { changes: [string] }
steps:
  - id: evidence
    command: ./evidence.sh
    output: { dir: string }
  - id: judge
    needs: [evidence]
    workspace: { confined: "{{ steps.evidence.outputs.dir }}" }
    model: "{{ inputs.changes }}"
    prompt: Judge the change from the files here.
    output: { verdict: pass | fail }
  - id: each
    needs: []
    for_each: inputs.changes
    workflow:
      steps:
        - id: judge
          workspace: { confined: "changes/{{ item }}" }
          prompt: Judge this change.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const each = stepWorkflow(result.definition.steps[2] ?? { id: 'each' });
    expect([result.definition.steps[1]?.workspace, each?.kind === 'inline' ? each.workflow.steps[0]?.workspace : undefined]).toEqual([
      { confined: '{{ steps.evidence.outputs.dir }}' },
      { confined: 'changes/{{ item }}' },
    ]);
  });

  it('rejects a confined directory on a step that is not one prompt, with requires.env or scorers, or read from what is not an output', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Judge the change.
inputs: { changes: [string] }
steps:
  - id: plan
    command: ./plan.sh
    output: { dir: string }
  - id: cmd
    needs: []
    workspace: { confined: evidence }
    command: ./judge.sh
  - id: perItem
    needs: []
    for_each: inputs.changes
    workspace: { confined: evidence }
    prompt: Judge it.
  - id: runs
    needs: []
    workspace: { confined: evidence }
    workflow: other
  - id: secret
    needs: []
    workspace: { confined: evidence }
    requires: { env: [API_KEY] }
    prompt: Judge it.
  - id: scored
    needs: []
    workspace: { confined: evidence }
    scorers: [review-quality]
    prompt: Judge it.
  - id: named
    needs: []
    workspace: { confined: evidence }
    tool: claude
    prompt: Judge it.
  - id: outcome
    needs: [plan]
    workspace: { confined: "{{ steps.plan.outcome }}" }
    prompt: Judge it.
  - id: unneeded
    needs: []
    workspace: { confined: "{{ steps.plan.outputs.dir }}" }
    prompt: Judge it.
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:11: field "steps[1].workspace": step "cmd" workspace confined is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:15: field "steps[2].for_each": step "perItem" workspace confined runs one prompt that reads only its directory, so it takes no for_each',
      'workflows/build.yaml:20: field "steps[3].workspace": step "runs" workspace confined is only allowed on a prompt or prompt_file step',
      'workflows/build.yaml:25: field "steps[4].requires.env": step "secret" workspace confined takes no requires.env: a confined prompt gets no team env or secrets',
      'workflows/build.yaml:30: field "steps[5].scorers": step "scored" workspace confined runs one prompt that reads only its directory, so it takes no scorers',
      'workflows/build.yaml:35: field "steps[6].tool": step "named" workspace confined runs one prompt that reads only its directory, so it takes no tool',
      'workflows/build.yaml:39: field "steps[7].workspace.confined": step "outcome" workspace.confined template {{ steps.plan.outcome }}: a confined directory template reads only inputs, item and the outputs of steps the step needs',
      'workflows/build.yaml:43: field "steps[8].workspace.confined": step "unneeded" workspace.confined reads steps.plan, which is not a step it needs, directly or through its needs',
    ]);
  });

  it('rejects a role on a step in the team workspace, which runs with no role\'s knowledge', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Tidy the team's rules.
steps:
  - id: tidy
    role: review
    workspace: { team: {} }
    prompt: Tidy the rules.
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].role": step "tidy" has role review but runs in the team workspace, which takes no role\'s knowledge; remove role',
    ]);
  });
});

describe('role on a clone step', () => {
  const COMMIT = 'c'.repeat(40);
  const REVISION = 'd'.repeat(40);
  const TEAM = `{ revision: ${REVISION}, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: pulled }`;

  it('keeps the role a clone step names, which the steps continuing its clone run with', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Review in a clean clone.
steps:
  - id: review
    role: review
    workspace: { clone: { commit: ${COMMIT}, team: ${TEAM} } }
    workflow:
      steps:
        - id: look
          workspace: continue
          prompt: Review the change.
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.role).toBe('review');
  });

  it('keeps a role on a prompt step that opens a copy, and on one that continues the copy around it', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Plan in one copy, review in another.
steps:
  - id: plan
    role: spec
    workspace: new
    prompt: Write the spec.
  - id: change
    needs: [plan]
    role: review
    workspace: new
    workflow:
      steps:
        - id: review
          role: review
          workspace: continue
          prompt: Review the change.
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    const [plan, change] = result.definition.steps;
    expect(plan?.role).toBe('spec');
    const inline = change && stepWorkflow(change);
    expect(inline?.kind === 'inline' ? inline.workflow.steps[0]?.role : undefined).toBe('review');
  });

  it('refuses a role on a step that runs in no copy, and on a step continuing a clone opened with another', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Review where no role reaches.
steps:
  - id: read
    role: review
    prompt: Review the change.
  - id: clone
    needs: []
    workspace: { clone: { commit: ${COMMIT}, team: ${TEAM} } }
    workflow:
      steps:
        - id: look
          role: review
          workspace: continue
          prompt: Review the change.
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:6: field "steps[0].role": step "read" has role review but neither opens nor continues a copy; give the prompt step workspace: new to open a copy that runs with the role, or workspace: continue to run with it in the copy around it' },
      { code: 'bad_role', message: 'workflows/build.yaml:14: field "steps[1].workflow.steps[0].role": step "look" has role review but continues a clone, which runs with the role of the step that opens it; set role on that step' },
    ]);
  });

  it('refuses a role on a command step', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Check as a reviewer.
steps:
  - id: check
    role: review
    workspace: new
    command: npm test
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:6: field "steps[0].role": step "check" has role review, but a command step launches no agent to take the role\'s knowledge; set role on the prompt step that opens or continues the copy' },
    ]);
  });

  it('refuses a role on a clone that installs no team, and a role that is not an id', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Review in a clean clone.
steps:
  - id: bare
    role: review
    workspace: { clone: { commit: ${COMMIT}, team: { treatment: none } } }
    prompt: Review the change.
  - id: listed
    needs: []
    role: [review]
    workspace: { clone: { commit: ${COMMIT}, team: ${TEAM} } }
    prompt: Review the change.
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:6: field "steps[0].role": step "bare" has role review but its clone installs no team (team: { treatment: none }); give the clone a team revision and selection, or remove role' },
      { code: 'bad_role', message: 'workflows/build.yaml:11: field "steps[1].role": step "listed" role must be the id of a role in manifest/roles.yaml, such as review' },
    ]);
  });
});

describe('a role for the steps inside a workflow step, and defaults.role', () => {
  const REVIEW_CONTAINER = `schemaVersion: v1alpha1
name: build
description: Fix the change and review it as a reviewer, then lint it.
steps:
  - id: review
    role: review
    workflow:
      steps:
        - id: change
          workspace: new
          workflow:
            steps:
              - id: fix
                prompt: Fix the change.
              - id: look
                needs: [fix]
                workspace: continue
                prompt: Review the fix.
              - id: lint
                needs: [look]
                workspace: continue
                command: npm run lint
`;

  it('keeps a role on a workflow step without a workspace, whose steps open and continue a copy, a command check without a role included', () => {
    const result = parse(REVIEW_CONTAINER);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.role).toBe('review');
  });

  it('refuses a role on a step continuing a copy that runs with another, and on a workflow step inside one whose steps continue it', () => {
    expect(rejected(REVIEW_CONTAINER.replace('                workspace: continue\n                prompt: Review the fix.', '                role: spec\n                workspace: continue\n                prompt: Review the fix.'))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:17: field "steps[0].workflow.steps[0].workflow.steps[1].role": step "look" has role spec but continues the copy step "change" opens with role review, which every step there runs with; remove role from step "look", or set it on step "change"' },
    ]);
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Plan in a reviewer's copy.
steps:
  - id: change
    role: review
    workspace: new
    workflow:
      steps:
        - id: plan
          role: spec
          workflow:
            steps:
              - id: write
                prompt: Write the plan.
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:11: field "steps[0].workflow.steps[0].role": step "plan" has role spec, but step "write" in it continues the copy step "change" opens with role review, which every step there runs with; remove role from step "plan", or set it on step "change"' },
    ]);
  });

  it('refuses a defaults.role and a workflow step\'s role that no step opening or continuing a copy takes', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Read as a reviewer.
defaults:
  role: review
steps:
  - id: read
    prompt: Read the change.
  - id: test
    needs: []
    command: npm test
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:5: field "defaults.role": defaults.role review is the role of no step: no step that names no role of its own opens or continues a copy, so none runs with it; give such a step workspace: new, or remove defaults.role' },
    ]);
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Check as a reviewer.
steps:
  - id: checks
    role: review
    workflow:
      steps:
        - id: test
          command: npm test
        - id: plan
          needs: []
          role: spec
          workspace: new
          prompt: Write the plan.
`)).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:6: field "steps[0].role": step "checks" has role review, but no step in it that names no role of its own opens or continues a copy, so none runs with it; give such a step workspace: new, or remove role' },
    ]);
  });

  it('refuses a session.from of a step that runs with another role', () => {
    expect(rejected(`schemaVersion: v1alpha1
name: build
description: Plan, then review in the planner's session.
steps:
  - id: plan
    role: spec
    workspace: new
    prompt: Write the plan.
  - id: review
    needs: [plan]
    role: review
    workspace: new
    session: { from: plan }
    prompt: Review the plan.
  - id: read
    needs: [plan]
    session: { from: plan }
    prompt: Read the plan.
`)).toEqual([
      { code: 'bad_session', message: 'workflows/build.yaml:13: field "steps[1].session.from": step "review" session.from names "plan", which runs with role spec, while step "review" runs with role review; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session' },
      { code: 'bad_session', message: 'workflows/build.yaml:17: field "steps[2].session.from": step "read" session.from names "plan", which runs with role spec, while step "read" runs with your roles; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session' },
    ]);
  });

  it('gives a step its own role over the nearest workflow step\'s, and that over defaults.role, and lets a new copy run with another', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Plan as a spec writer, fix as a reviewer, and audit on the way.
defaults:
  role: spec
steps:
  - id: plan
    workspace: new
    prompt: Write the plan.
  - id: review
    needs: [plan]
    role: review
    workflow:
      steps:
        - id: fix
          workspace: new
          prompt: Fix the change.
        - id: audit
          needs: [fix]
          role: audit
          workspace: new
          prompt: Audit the fix.
        - id: change
          needs: [audit]
          workspace: new
          workflow:
            steps:
              - id: again
                role: review
                prompt: Review it again.
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.defaults?.role).toBe('spec');
  });

  it("says to declare a role manifest/roles.yaml does not declare before setting it on the step that opens the copy", () => {
    const child = parse(`schemaVersion: v1alpha1
name: look
description: Look at the change.
steps:
  - id: note
    role: audit
    workspace: continue
    prompt: Note what you saw.
`, 'workflows/look.yaml');
    if (!child.ok) throw new Error(child.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'look' ? child.definition : null), cycle: () => undefined, roles: new Set(['review']) };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Review the change in a reviewer's copy.
steps:
  - id: change
    role: review
    workspace: new
    workflow: look
`, files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => ({ message: formatDiagnostic(diagnostic), code: diagnostic.code }))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:8: field "steps[0].workflow": step "change" runs workflow "look", whose step "note" has role audit but continues the copy step "change" opens with role review, which every step there runs with; remove role from step "note", or set it on step "change" once manifest/roles.yaml declares audit, which it does not: it declares review' },
    ]);
  });

  it('checks the steps of a workflow file a step runs by name against the copy that step opens, at that step', () => {
    const child = parse(`schemaVersion: v1alpha1
name: look
description: Look at the change.
defaults:
  role: spec
steps:
  - id: look
    workspace: continue
    prompt: Look at the change.
  - id: note
    needs: [look]
    role: audit
    workspace: continue
    prompt: Note what you saw.
`, 'workflows/look.yaml');
    if (!child.ok) throw new Error(child.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'look' ? child.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Review the change in a reviewer's copy.
defaults:
  role: review
steps:
  - id: change
    workspace: new
    workflow: look
`, files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => ({ message: formatDiagnostic(diagnostic), code: diagnostic.code }))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:9: field "steps[0].workflow": step "change" runs workflow "look", whose defaults.role spec is the role of step "look", but it continues the copy step "change" opens with role review, which every step there runs with; remove defaults.role, or set role spec on step "change"' },
      { code: 'bad_role', message: 'workflows/build.yaml:9: field "steps[0].workflow": step "change" runs workflow "look", whose step "note" has role audit but continues the copy step "change" opens with role review, which every step there runs with; remove role from step "note", or set it on step "change"' },
    ]);
  });

  it('names every workflow on the way when a step two workflow files down continues the copy with another role', () => {
    const look = parse(`schemaVersion: v1alpha1
name: look
description: Look at the change.
steps:
  - id: note
    role: audit
    workspace: continue
    prompt: Note what you saw.
`, 'workflows/look.yaml');
    if (!look.ok) throw new Error(look.diagnostics.map(formatDiagnostic).join('\n'));
    const lookFiles = { runnable: (name: string) => (name === 'look' ? look.definition : null), cycle: () => undefined };
    const outer = parseWorkflow('workflows/outer.yaml', `schemaVersion: v1alpha1
name: outer
description: Look through another workflow.
steps:
  - id: inner
    workflow: look
`, lookFiles);
    if (!outer.ok) throw new Error(outer.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'outer' ? outer.definition : name === 'look' ? look.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Review the change in a reviewer's copy.
steps:
  - id: change
    workspace: new
    role: review
    workflow: outer
`, files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => ({ message: formatDiagnostic(diagnostic), code: diagnostic.code }))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:8: field "steps[0].workflow": step "change" runs workflow "outer" > "look", whose step "note" has role audit but continues the copy step "change" opens with role review, which every step there runs with; remove role from step "note", or set it on step "change"' },
    ]);
  });

  it('lets a workflow step\'s role reach a workflow file it runs by name, whose steps open a copy', () => {
    const child = parse(`schemaVersion: v1alpha1
name: fix
description: Fix the change.
steps:
  - id: fix
    workspace: new
    prompt: Fix the change.
`, 'workflows/fix.yaml');
    if (!child.ok) throw new Error(child.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'fix' ? child.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Fix the change as a reviewer.
steps:
  - id: review
    role: review
    workflow: fix
`, files);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
  });
});

describe('a role per for_each item', () => {
  const REVIEW_PARTS = `schemaVersion: v1alpha1
name: build
description: Review each part of the change as the role that knows it.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    prompt: Review the change to {{ item.path }}.
`;

  it('keeps a role template that reads the item, which the lease of each item resolves', () => {
    const result = parse(REVIEW_PARTS);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.role).toBe('{{ item.role }}');
  });

  it('refuses a role template that reads more than the item, and one where no item is bound', () => {
    expect(rejected(REVIEW_PARTS.replace('{{ item.role }}', '{{ inputs.role }}'))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:9: field "steps[0].role": step "review" role must be the id of a role in manifest/roles.yaml, such as review, or a template that reads only its item, such as {{ item.role }}' },
    ]);
    expect(rejected(REVIEW_PARTS.replace('    for_each: inputs.parts\n', ''))).toEqual([
      { code: 'bad_role', message: 'workflows/build.yaml:8: field "steps[0].role": step "review" role must be the id of a role in manifest/roles.yaml, such as review' },
    ]);
  });

  it('leaves a copy or a session across a role template and an id to the lease, which knows what the template gives', () => {
    const header = `schemaVersion: v1alpha1
name: build
description: Review each part as the role that knows it, then sum it up as a reviewer.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
`;
    const continued = `${header}    role: "{{ item.role }}"
    workspace: new
    workflow:
      steps:
        - id: look
          prompt: Review the change to {{ item.path }}.
        - id: sum
          needs: [look]
          role: review
          workspace: continue
          prompt: Sum up the review.
`;
    const resumed = `${header}    workflow:
      steps:
        - id: look
          role: "{{ item.role }}"
          workspace: new
          prompt: Review the change to {{ item.path }}.
        - id: sum
          needs: [look]
          role: review
          workspace: new
          session: { from: look }
          prompt: Sum up the review.
`;
    for (const yaml of [continued, resumed]) {
      const result = parse(yaml);
      expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    }
  });
});

describe('finally', () => {
  const problems = (content: string): string[] => {
    const result = parse(content);
    return result.ok ? [] : result.diagnostics.map(formatDiagnostic);
  };

  it('keeps finally steps beside the steps, and lets the outputs read them', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Build, then report.
steps:
  - id: compile
    command: npm run build
finally:
  - id: report
    command: node report.js
    output: { text: string }
  - id: notify
    needs: [report]
    if: steps.report.outcome == 'succeeded'
    command: node notify.js
    env: { TEXT: "{{ steps.report.outputs.text }}" }
outputs:
  text: steps.report.outputs.text
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps.map((step) => step.id)).toEqual(['compile']);
    expect(result.definition.finally?.map((step) => step.id)).toEqual(['report', 'notify']);
  });

  it('refuses a finally step that does more than run a read-only command', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Build, then report.
steps:
  - id: compile
    command: npm run build
finally:
  - id: review
    prompt: Review it.
  - id: push
    needs: []
    command: git push
    workspace: new
`)).toEqual([
      'workflows/build.yaml:9: field "finally[0].prompt": a finally step runs a read-only command, so it carries only id, needs, if, command, env, output, timeout',
      'workflows/build.yaml:13: field "finally[1].workspace": a finally step runs a read-only command, so it carries only id, needs, if, command, env, output, timeout',
    ]);
  });

  it('runs finally only at the top level, with ids of its own', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Build, then report.
steps:
  - id: compile
    command: npm run build
  - id: inner
    needs: [compile]
    workflow:
      steps:
        - id: work
          command: npm test
      finally:
        - id: tidy
          command: rm -rf tmp
finally:
  - id: compile
    command: node report.js
`)).toEqual([
      'workflows/build.yaml:13: field "steps[1].workflow.finally": step "inner" runs an inline workflow, which carries only steps, outputs, ends, and loop',
      'workflows/build.yaml:17: field "finally": finally step id "compile" is also a step in steps',
    ]);
  });

  it('refuses a step that runs a workflow file with finally steps, which only a run of that file runs', () => {
    const report = parse(`schemaVersion: v1alpha1
name: report
description: Report, then tidy.
steps:
  - id: write
    command: node report.js
finally:
  - id: tidy
    command: rm -rf tmp
`, 'workflows/report.yaml');
    if (!report.ok) throw new Error(report.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'report' ? report.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Build, then report.
steps:
  - id: compile
    command: npm run build
  - id: report
    needs: [compile]
    workflow: report
`, files);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:9: field "steps[1].workflow": step "report" runs workflow "report", which has finally steps; only a run of that workflow runs them, so start it with teamai workflow start',
    ]);
  });

  it('lets a finally step read the inputs and the finally steps it needs, never the steps', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Build, then report.
inputs: { title: string }
steps:
  - id: compile
    command: npm run build
    output: { log: string }
finally:
  - id: report
    command: node report.js
    output: { text: string }
    env: { TITLE: "{{ inputs.title }}", LOG: "{{ steps.compile.outputs.log }}" }
  - id: notify
    needs: [report]
    command: node notify.js
    env: { TEXT: "{{ steps.report.outputs.text }}" }
`)).toEqual([
      'workflows/build.yaml:13: field "finally[0].env.LOG": step "report" env.LOG reads steps.compile, which is not a step it needs, directly or through its needs',
    ]);
  });
});

describe('workflow and json outputs', () => {
  const problems = (content: string): string[] => {
    const result = parse(content);
    return result.ok ? [] : result.diagnostics.map(formatDiagnostic);
  };

  it('keeps a workflow field and an opaque json field, which the outputs may pass whole, and reads their names in a union as literals', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Plan, then report.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow, plan: json, notes: [json], phase: "workflow | json" }
outputs:
  plan: steps.plan.outputs.plan
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    expect(result.definition.steps[0]?.output).toEqual({
      type: 'object', fields: {
        definition: { type: 'workflow' }, plan: { type: 'json' }, notes: { type: 'array', items: { type: 'json' } }, phase: { type: 'enum', values: ['workflow', 'json'] },
      },
    });
  });

  it('refuses a read into a json or workflow field', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan, then act.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow, plan: json }
  - id: act
    needs: [plan]
    if: steps.plan.outputs.plan.ready == true
    command: node act.js
    env: { NAME: "{{ steps.plan.outputs.definition.definition }}" }
`)).toEqual([
      'workflows/build.yaml:12: field "steps[1].env.NAME": step "act" env.NAME reads steps.plan.outputs.definition.definition, which is not in the output step "plan" declares',
      'workflows/build.yaml:10: field "steps[1].if": step "act" if reads steps.plan.outputs.plan.ready, which is not in the output step "plan" declares',
    ]);
  });

  it('takes a workflow only as one field of a step output, and neither type as an input', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan.
inputs: { suite: json, bundle: workflow }
steps:
  - id: whole
    command: node plan.js
    output: workflow
  - id: nested
    needs: []
    command: node plan.js
    output: { group: { definition: workflow }, list: [workflow] }
  - id: twice
    needs: []
    command: node plan.js
    output: { first: workflow, second: workflow }
`)).toEqual([
      'workflows/build.yaml:4: field "inputs.suite": an input cannot be json; only a step output can',
      'workflows/build.yaml:4: field "inputs.bundle": an input cannot be a workflow; only a field of a step output can',
      'workflows/build.yaml:8: field "steps[0].output": a workflow is only a field of a step output, such as output: { definition: workflow }',
      'workflows/build.yaml:12: field "steps[1].output.group.definition": a workflow is only a field of a step output, such as output: { definition: workflow }',
      'workflows/build.yaml:12: field "steps[1].output.list[]": a workflow is only a field of a step output, such as output: { definition: workflow }',
      'workflows/build.yaml:16: field "steps[2].output.second": a step output has at most one workflow field; "first" is one already',
    ]);
  });
});

describe('workflow: { from }', () => {
  const problems = (content: string): string[] => {
    const result = parse(content);
    return result.ok ? [] : result.diagnostics.map(formatDiagnostic);
  };

  it('runs the workflow output of a step it needs', () => {
    const result = parse(`schemaVersion: v1alpha1
name: build
description: Plan, then run the plan.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
`);
    expect(result.ok, result.ok ? '' : result.diagnostics.map(formatDiagnostic).join('\n')).toBe(true);
    if (!result.ok) return;
    const trials = result.definition.steps[1];
    expect(trials && stepWorkflow(trials)).toEqual({ kind: 'from', step: 'plan' });
  });

  it('refuses a from that names no step it needs, or one without a workflow output, or with other keys', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan, then run the plan.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow }
  - id: notes
    needs: []
    command: node notes.js
    output: { text: string }
  - id: unneeded
    needs: [notes]
    workflow: { from: plan }
  - id: untyped
    needs: [notes]
    workflow: { from: notes }
  - id: extra
    needs: [plan]
    workflow: { from: plan, steps: [] }
`)).toEqual([
      'workflows/build.yaml:20: field "steps[4].workflow": step "extra" workflow must be the name of a workflow in workflows/, an inline workflow, or { from: <step> }',
      'workflows/build.yaml:14: field "steps[2].workflow.from": step "unneeded" workflow.from names "plan", which is not a step it needs',
      'workflows/build.yaml:17: field "steps[3].workflow.from": step "untyped" workflow.from names "notes", whose output has no workflow field',
    ]);
  });

  it('refuses a from on the first step, which needs no step', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Run a plan first.
steps:
  - id: trials
    workflow: { from: plan }
  - id: plan
    needs: []
    command: node plan.js
    output: { definition: workflow }
`)).toEqual([
      'workflows/build.yaml:6: field "steps[0].workflow.from": step "trials" workflow.from names "plan", which is not a step it needs',
    ]);
  });

  it('refuses a workflow output on a step that can run more than once', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan in a loop and per item.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow }
  - id: check
    needs: [plan]
    command: node check.js
    loop: { back_to: plan, max_iterations: 2 }
  - id: each
    needs: []
    for_each: "[]"
    command: node plan.js
    output: { definition: workflow }
`)).toEqual([
      'workflows/build.yaml:7: field "steps[0].output": step "plan" outputs a workflow, so it runs once; it may not repeat in a loop or run per item of a for_each',
      'workflows/build.yaml:16: field "steps[2].output": step "each" outputs a workflow, so it runs once; it may not repeat in a loop or run per item of a for_each',
    ]);
  });

  it('refuses a workflow output on a step of an inline workflow that a loop around it runs again', () => {
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan inside a looping workflow and a looping step range.
loop:
  while: "steps.inner.outputs.done != 'yes'"
  max_iterations: 2
steps:
  - id: inner
    workflow:
      outputs: { done: steps.plan.outputs.definition }
      steps:
        - id: plan
          command: node plan.js
          output: { definition: workflow }
`)).toEqual([
      'workflows/build.yaml:14: field "steps[0].workflow.steps[0].output": step "plan" outputs a workflow, so it runs once; it may not repeat in a loop or run per item of a for_each',
    ]);
    expect(problems(`schemaVersion: v1alpha1
name: build
description: Plan inside a step loop.
steps:
  - id: inner
    workflow:
      steps:
        - id: plan
          command: node plan.js
          output: { definition: workflow }
  - id: check
    needs: [inner]
    command: node check.js
    loop: { back_to: inner, max_iterations: 2 }
`)).toEqual([
      'workflows/build.yaml:10: field "steps[0].workflow.steps[0].output": step "plan" outputs a workflow, so it runs once; it may not repeat in a loop or run per item of a for_each',
    ]);
  });

  it('refuses a workflow file that outputs a workflow, run by a step that a loop runs again or runs per item', () => {
    const planner = parseWorkflow('workflows/planner.yaml', `schemaVersion: v1alpha1
name: planner
description: Plan.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow }
`, { runnable: () => null, cycle: () => undefined });
    if (!planner.ok) throw new Error(planner.diagnostics.map(formatDiagnostic).join('\n'));
    const files = { runnable: (name: string) => (name === 'planner' ? planner.definition : null), cycle: () => undefined };
    const result = parseWorkflow(FILE, `schemaVersion: v1alpha1
name: build
description: Plan in a loop and per item.
steps:
  - id: again
    workflow: planner
  - id: check
    needs: [again]
    command: node check.js
    loop: { back_to: again, max_iterations: 2 }
  - id: each
    needs: []
    for_each: "[]"
    workflow: planner
  - id: once
    needs: []
    workflow: planner
`, files);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'workflows/build.yaml:6: field "steps[0].workflow": step "again" runs workflow "planner", whose step "plan" outputs a workflow, so it runs once; step "again" may not repeat in a loop or run per item of a for_each',
      'workflows/build.yaml:14: field "steps[2].workflow": step "each" runs workflow "planner", whose step "plan" outputs a workflow, so it runs once; step "each" may not repeat in a loop or run per item of a for_each',
    ]);
  });
});
