/** The built CLI that conformance runners call, and a scenario's client over its `workflow` calls. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ConformanceClient } from '../../workflow/conformance-interpreter.js';
import type { NextPrepare } from '../../workflow/protocol.js';
import type { WorkflowEnvelope } from '../../workflow/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/** Runs the built CLI with `args` in `cwd`, `input` on its stdin, and `node` as Node's own options. */
export function runCLI(
  args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, options: { input?: string; node?: string[] } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(options.node ?? []), CLI, ...args], {
      cwd,
      env: { ...env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

const EnvelopeSchema: z.ZodType<WorkflowEnvelope> = z.union([
  z.object({ data: z.record(z.unknown()) }),
  z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() }),
]);

/** The last JSON envelope a call printed. */
export function envelope(stdout: string): WorkflowEnvelope {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

/** `relative` in the data home of the one project `home` has, undefined when it has no such file. */
export function fileUnder(home: string, relative: string): string | undefined {
  const projects = path.join(home, '.teamai', 'projects');
  const [project, ...more] = fs.readdirSync(projects);
  if (project === undefined || more.length > 0) throw new Error(`expected one project under ${projects}`);
  const file = path.join(projects, project, relative);
  return fs.existsSync(file) ? file : undefined;
}

/** The `next` flags that ask for `prepare`. */
function prepareArgs(prepare: NextPrepare | undefined): string[] {
  if (prepare === undefined) return [];
  if (prepare === true) return ['--prepare'];
  return ['--prepare', '--attempt', prepare.attempt, ...(prepare.adopt !== undefined ? ['--adopt', prepare.adopt] : [])];
}

/** A scenario's client over the `workflow` calls `call` makes with the built CLI, each with `extra` added to its env. */
export function cliConformanceClient(call: (args: string[], extra?: Record<string, string>) => Promise<WorkflowEnvelope>): ConformanceClient {
  return {
    start: (name, options = {}) => call(['start', name, ...(options.driver !== undefined ? ['--driver', options.driver] : []), ...(options.confirmed ? ['--confirmed'] : [])], options.env),
    next: (run, body, options) => call(['next', run, ...prepareArgs(options?.prepare), '--json', JSON.stringify(body)]),
    report: (run, body) => call(['report', run, '--json', JSON.stringify(body)]),
    respond: (run, step, choice, options) => call(['respond', run, step, choice, ...(options.note !== undefined ? ['--note', options.note] : []), ...(options.pass !== undefined ? ['--pass', String(options.pass)] : []), ...(options.json !== undefined ? ['--json', JSON.stringify(options.json)] : [])], options.env),
    retry: (run, step) => call(['retry', run, step]),
    cancel: (run, step) => call(['cancel', run, ...(step !== undefined ? [step] : [])]),
  };
}
