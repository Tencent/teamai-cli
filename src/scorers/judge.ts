import fs from 'node:fs/promises';
import path from 'node:path';
import { runConfined, type ConfinedResult } from '../tool-launch/confined.js';
import type { ConfinedTool } from '../tool-launch/tools.js';
import { resolveCliPath } from '../utils/cli-path.js';
import { JudgeAnswerSchema, type JudgeAnswer } from './batch.js';
import type { ConfinedLevel } from '../tool-launch/confined-level.js';
import type { ConfinedUsage } from '../tool-launch/confined-level.js';
import type { ScoreLabel } from './label.js';
import type { JsonValue } from '../types.js';

const JUDGE_TIMEOUT_MS = 10 * 60_000;

export interface JudgeInput {
  tool: ConfinedTool;
  model?: { name: string; effort?: string };
  evidence: string;
  /** The JSON Schema the judge's answer must follow. */
  schema: JsonValue;
  isolation?: ConfinedLevel;
  /** The directory the judge tool's process group is recorded in, where `stopRecordedGroup` finds it if its caller dies. */
  group?: string;
  /** Stops the judge tool, as its ten-minute limit does. */
  signal?: AbortSignal;
}

type JudgeFailureCode = 'judge_failed' | 'judge_answer_invalid' | 'judge_tool_unavailable';

export type LocalJudgeResult =
  | { ok: true; answer: JudgeAnswer; judge: Omit<Extract<ScoreLabel['judge'], { kind: 'model' }>, 'kind'> }
  | { ok: false; code: JudgeFailureCode; message: string; raw?: string; usage?: ConfinedUsage };

/** What a failed judge call leaves for its caller to keep: the tool's output, and what it spent. */
interface Saved {
  raw?: string;
  usage?: ConfinedUsage;
}

function saved(raw: string | undefined, usage: ConfinedUsage | undefined): Saved {
  const kept: Saved = {};

  if (raw !== undefined) kept.raw = raw;

  if (usage !== undefined) kept.usage = usage;

  return kept;
}

function answerInvalid(tool: ConfinedTool, kept: Saved): LocalJudgeResult {
  return { ok: false, code: 'judge_answer_invalid', message: `${tool} did not return JSON with label and reasoning. See the saved output, then retry.`, ...kept };
}

function judgeFailure(tool: ConfinedTool, failure: Extract<ConfinedResult, { ok: false }>): LocalJudgeResult {
  const kept = saved(failure.raw, failure.usage);

  switch (failure.code) {
    case 'confined_tool_unavailable':
      return { ok: false, code: 'judge_tool_unavailable', message: failure.message, ...kept };
    case 'confined_failed':
      return { ok: false, code: 'judge_failed', message: failure.reported === undefined ? failure.message : `${tool} reported an error: ${failure.reported.replace(/\.?$/, '.')} Fix that, then run teamai score again.`, ...kept };
    case 'confined_reply_invalid':
      return answerInvalid(tool, kept);
    default: {
      const unhandled: never = failure.code;
      throw new Error(`No judge failure for ${String(unhandled)}`);
    }
  }
}

/** Judges the evidence in `input.evidence` with its `prompt.md`, through the confined launcher. */
export async function runLocalJudge(input: JudgeInput, { resolveTool = resolveCliPath }: { resolveTool?: (tool: string) => string | null } = {}): Promise<LocalJudgeResult> {
  let prompt: string;

  try { prompt = await fs.readFile(path.join(input.evidence, 'prompt.md'), 'utf8'); }
  catch (error) { return { ok: false, code: 'judge_failed', message: `The judge could not run: ${error instanceof Error ? error.message : String(error)}. Fix that, then run teamai score again.` }; }

  const result = await runConfined({ tool: input.tool, model: input.model, dir: input.evidence, prompt, schema: input.schema, level: input.isolation ?? 'best-effort', timeoutMs: JUDGE_TIMEOUT_MS, group: input.group, signal: input.signal }, { resolveTool });

  if (!result.ok) return judgeFailure(input.tool, result);
  const answer = JudgeAnswerSchema.safeParse(result.reply);

  if (!answer.success) return answerInvalid(input.tool, saved(JSON.stringify(result.reply), result.run.usage));

  return { ok: true, answer: answer.data, judge: result.run };
}
