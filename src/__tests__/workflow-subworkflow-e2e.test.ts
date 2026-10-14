import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCLI(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('file sub-workflow real-CLI E2E', () => {
  it('runs command-only parent and file sub-workflow through real CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-wf-e2e-'));
    dirs.push(root);

    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: root });

    fs.mkdirSync(path.join(root, '.teamai', 'workflows'), { recursive: true });

    fs.writeFileSync(
      path.join(root, '.teamai', 'teamai.yaml'),
      ['schemaVersion: v1alpha1', 'team: e2e-team', 'mode: self', 'repo: local'].join('\n'),
    );

    fs.writeFileSync(
      path.join(root, '.teamai', 'config.yaml'),
      [
        'schemaVersion: v1alpha1',
        'repo:',
        `  localPath: "${path.join(root, '.teamai')}"`,
        '  remote: local',
        '  kind: self',
        'username: tester',
        'scope: project',
        `projectRoot: "${root}"`,
      ].join('\n'),
    );

    const childYaml = `schemaVersion: v1alpha1
name: child
description: Sub-workflow.
inputs:
  msg:
    type: string
steps:
  - id: step_child
    command: node child.js
    env:
      CHILD_MSG: "{{ inputs.msg }}"
    output:
      received: string
outputs:
  echoed: steps.step_child.outputs.received
`;

    const parentYaml = `schemaVersion: v1alpha1
name: parent
description: Parent calling child workflow.
steps:
  - id: invoke_child
    workflow: child
    with:
      msg: "hello-from-parent"
  - id: final_step
    needs: [invoke_child]
    command: node parent.js
    env:
      FROM_CHILD: "{{ steps.invoke_child.outputs.echoed }}"
`;

    fs.writeFileSync(path.join(root, '.teamai', 'workflows', 'child.yaml'), childYaml);
    fs.writeFileSync(path.join(root, '.teamai', 'workflows', 'parent.yaml'), parentYaml);

    fs.writeFileSync(
      path.join(root, 'child.js'),
      "process.stdout.write(JSON.stringify({ received: process.env.CHILD_MSG }));\n",
    );
    fs.writeFileSync(
      path.join(root, 'parent.js'),
      "require('fs').writeFileSync('e2e-output.txt', process.env.FROM_CHILD);\n",
    );

    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

    // 1. Run pull to populate workflow cache
    const pullResult = await runCLI(['pull'], root);
    expect(pullResult.code).toBe(0);

    // 2. Run workflow start parent --driver local
    const startResult = await runCLI(['workflow', 'start', 'parent', '--driver', 'local'], root);
    expect(startResult.code).toBe(0);

    const parsedEnvelope = JSON.parse(startResult.stdout.trim());
    expect(parsedEnvelope).toMatchObject({
      data: {
        done: {
          outcome: 'succeeded',
        },
      },
    });

    // 3. Verify side effect of final_step: e2e-output.txt has received child's echoed output
    const outputContent = fs.readFileSync(path.join(root, 'e2e-output.txt'), 'utf8');
    expect(outputContent).toBe('hello-from-parent');
  });
});
