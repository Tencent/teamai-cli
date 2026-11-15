/**
 * Tests that passed only on a retry, which a run's result does not show: E2E retries a failed test once, and a test
 * that then passes counts as passed under every reporter. This module is both halves of the record:
 *
 *   setup file     each attempt of a test that failed, and each test that passed after one, as a line in a file of
 *                  its worker under the run's directory
 *   global setup   that directory, and at the end of the run a summary of each test that passed only on a retry, with
 *                  its failed attempts' first error, on stdout and, on GitHub Actions, as a warning annotation
 *
 * It holds whatever reporter the run uses, since one given on the command line replaces those of the config.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, inject } from 'vitest';
import type { TestProject } from 'vitest/node';
import { z } from 'zod';

declare module 'vitest' {
  export interface ProvidedContext {
    retriedTestsDir: string;
  }
}

const AttemptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('failed'), test: z.string(), attempt: z.number(), error: z.string() }),
  z.object({ kind: z.literal('passed'), test: z.string(), retries: z.number() }),
]);

type Attempt = z.infer<typeof AttemptSchema>;

/** Registers the record of each test's attempts, from a setup file. */
export function recordRetriedTests(): void {
  const dir = inject('retriedTestsDir');
  const file = path.join(dir, `${process.pid}.jsonl`);

  beforeEach(({ task, onTestFinished }) => {
    onTestFinished(() => {
      const { result } = task;
      const test = task.fullName;
      const retries = result?.retryCount ?? 0;
      let line: Attempt | undefined;

      // Vitest keeps each attempt's errors in `errors`, so this attempt's is the last.
      if (result?.state === 'fail') line = { kind: 'failed', test, attempt: retries + 1, error: result.errors?.at(-1)?.message ?? 'no error message' };
      else if (result?.state === 'pass' && retries > 0) line = { kind: 'passed', test, retries };

      if (line) fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    });
  });
}

/** The summary of each test that passed only on a retry, from the lines the workers wrote; empty when there is none. */
function retriedSummary(lines: readonly string[]): string[] {
  const attempts = lines.filter(Boolean).map((line) => AttemptSchema.parse(JSON.parse(line)));
  const failures = (test: string) => attempts.flatMap((attempt) => (attempt.kind === 'failed' && attempt.test === test ? [attempt] : []));

  return attempts.flatMap((attempt) => (attempt.kind === 'passed'
    ? [`${attempt.test} passed on retry ${attempt.retries}`, ...failures(attempt.test).map(({ attempt: tried, error }) => `  attempt ${tried} failed: ${error.split('\n')[0]}`)]
    : []));
}

export default function setup(project: TestProject): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-retried-tests-'));
  project.provide('retriedTestsDir', dir);

  return () => {
    const lines = fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
    const summary = retriedSummary(lines);

    if (summary.length === 0) return;
    const passed = summary.filter((line) => !line.startsWith(' '));
    console.log(`\nTests that passed only on a retry (${passed.length}):\n${summary.join('\n')}\n`);

    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const test of passed) console.log(`::warning title=Passed only on a retry::${test}`);
    }
  };
}
