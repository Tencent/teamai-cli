/** The brief a child agent works one prompt step from, and the result it leaves for the attempt's report. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../../../types.js';
import { readFileSafe, writeFileAtomic } from '../../../utils/fs.js';
import { redact } from '../../../utils/redact.js';
import { attemptDir, attemptResultPath, type AttemptId, type RunId } from '../../store.js';
import type { Literal } from './literals.js';

/** `attempts/<a>/result.json`, as the child writes it: what the step produced, or why it could not. */
const ChildResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('output'), output: z.unknown() }),
  z.object({ kind: z.literal('failure'), failure: z.object({ code: z.string().min(1), message: z.string() }) }),
]);
export type ChildResult = z.infer<typeof ChildResultSchema>;


/**
 * Writes `attempts/<a>/brief.md`, masked with `secrets`, and returns its path. It carries the step's prompt, where to
 * work, the result to write and the report to run, and no env value.
 */
export async function writeChildBrief(input: {
  config: LocalConfig;
  run: RunId;
  attempt: AttemptId;
  step: string;
  dir: string;
  /**
   * What becomes of what the step changes in `dir`: `commit`, TeamAI commits it; `keep`, an interactive step in the
   * checkout, it stays there and TeamAI commits nothing; `none`, the step only reads, and must change nothing.
   */
  changes: 'commit' | 'keep' | 'none';
  prompt: string;
  /**
   * Who works the step: a `child` agent the orchestrator started; the orchestrator, with the `person`, in an interactive
   * step; or the orchestrator alone (`self`), on a host that starts no child. Only a child ends when it reports.
   */
  by: 'child' | 'person' | 'self';
  /** The step's output schema, when it declares one. */
  output?: unknown;
  report: Literal;
  secrets: Record<string, string>;
}): Promise<string> {
  const { config, run, attempt, step, dir, changes, prompt, by, output, report, secrets } = input;
  const shape = output === undefined ? 'a short summary of what you did, as a JSON string' : `a value that matches the JSON schema \`${JSON.stringify(output)}\``;
  const brief = [
    `# Step ${step}, attempt ${attempt} of run ${run}`,
    '',
    {
      child: 'You work this one step of a team workflow. Another agent orchestrates the run, and your part ends when you report.',
      person: 'You work this one step of a team workflow with the person, in this session: ask them what the step needs, and do it together. Your part in it ends when you report.',
      self: 'You orchestrate this team workflow, and you work this one step of it yourself, in this session. Your part in the step ends when you report.',
    }[by],
    '',
    '## The step',
    '',
    prompt.trim(),
    '',
    '## How to work',
    '',
    ...{
      commit: [`- Work in \`${dir}\`: every file the step reads or changes is there.`, '- Leave git to TeamAI. It commits and pushes that directory after you report.'],
      keep: [`- Work in \`${dir}\`, the person's checkout: every file the step reads or changes is there. What you change stays there; TeamAI commits nothing.`, '- Leave git to the person.'],
      none: [`- Work in \`${dir}\`: every file the step reads is there. Do not change files here: the step only reads them, and TeamAI fails a step that leaves a change.`, '- Leave git to TeamAI.'],
    }[changes],
    '- Run one teamai command, the report below, once, at the end.',
    '',
    '## Finish',
    '',
    `1. Write \`${attemptResultPath(config, run, attempt)}\` with one JSON object:`,
    `   - When the step is done: \`{"kind":"output","output":...}\`, where \`output\` is ${shape}.`,
    '   - When you cannot do it: `{"kind":"failure","failure":{"code":"blocked","message":"..."}}`, with a short code and a message that says what stopped you.',
    by === 'child'
      ? `2. Run \`${report}\` once, and end with its reply as your last message. The orchestrator learns from TeamAI that you reported.`
      : `2. Run \`${report}\` once, then go on with the run.`,
    '',
  ].join('\n');
  const file = path.join(attemptDir(config, run, attempt), 'brief.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, redact(brief, { envSecrets: secrets, patterns: false }));
  return file;
}

/** The result the child of `attempt` wrote. A missing or unreadable one is a `tool_failed` failure. */
export async function readChildResult(input: { config: LocalConfig; run: RunId; attempt: AttemptId }): Promise<ChildResult> {
  const file = attemptResultPath(input.config, input.run, input.attempt);
  const raw = await readFileSafe(file);
  if (raw === null) {
    return { kind: 'failure', failure: { code: 'tool_failed', message: `The child of attempt ${input.attempt} wrote no ${file}, so the step has no result.` } };
  }
  let parsed: z.SafeParseReturnType<unknown, ChildResult>;
  try {
    parsed = ChildResultSchema.safeParse(JSON.parse(raw));
  } catch (error) {
    return { kind: 'failure', failure: { code: 'tool_failed', message: `The child of attempt ${input.attempt} wrote ${file}, which is not JSON: ${error instanceof Error ? error.message : String(error)}.` } };
  }
  if (parsed.success) return parsed.data;
  return { kind: 'failure', failure: { code: 'tool_failed', message: `The child of attempt ${input.attempt} wrote ${file}, which is not a result: ${parsed.error.issues[0]?.message ?? 'invalid'}.` } };
}
