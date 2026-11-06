/**
 * An answer step on the local driver: the member's AI tool answers the lease's prompt on the one-shot launch every AI
 * call takes, in the managed read-only checkout, and the step reports the reply as text or as the JSON its output declares.
 */
import { CallError, type CallErrorKind } from '../../../tool-launch/member-tools.js';
import { createToolCaller, type CallOptions, type ToolCallerDeps } from '../../../tool-launch/call.js';
import { parseReply } from '../../../tool-launch/confined.js';
import type { LocalConfig } from '../../../types.js';
import type { ReportInput } from '../../engine.js';
import { expectedOutput } from '../../output.js';
import type { OutputSchema, WorkflowFailure } from '../../types.js';

export type AnswerReport = Pick<ReportInput, 'outcome' | 'outputs' | 'tool' | 'tokens' | 'durationMs' | 'message' | 'failure'>;

/** Whether the step takes its reply as text: its output is `{ text: string }`. */
function takesText(output: OutputSchema | undefined): boolean {
  if (output?.type !== 'object') return false;
  const fields = Object.entries(output.fields);

  return fields.length === 1 && fields[0][0] === 'text' && fields[0][1].type === 'string';
}

/** The prompt the tool answers: the step's, and for a JSON output, what the reply must be. */
function promptOf(prompt: string, output: OutputSchema | undefined): string {
  return takesText(output) ? prompt : `${prompt}\n\nReply with only a JSON value, with no other text: ${expectedOutput(output)}`;
}

const FAILURE_OF = {
  no_tool: 'tool_unavailable',
  override_invalid: 'tool_unconfigured',
  call_failed: 'tool_failed',
} as const satisfies Record<CallErrorKind, WorkflowFailure['code']>;

function failed(failure: WorkflowFailure): AnswerReport {
  return { outcome: 'failed', message: failure.message, failure };
}

/**
 * Answers `prompt` on the member's AI tool, the one `TEAMAI_AI_TOOL`, then `ai.tool`, names, else the first installed,
 * in `cwd`. It ends by `expiresAt` or when `signal` aborts, which a cancelled lease does.
 */
export async function runAnswerStep({ config, prompt, output, cwd, expiresAt, signal, resolveTool }: {
  config: LocalConfig;
  prompt: string;
  output: OutputSchema | undefined;
  cwd: string;
  expiresAt: string | undefined;
  signal: AbortSignal;
  resolveTool?: ToolCallerDeps['resolveTool'];
}): Promise<AnswerReport> {
  const caller = createToolCaller(resolveTool ? { resolveTool } : {});
  const options: CallOptions = { launchedBy: 'answer', scope: config, cwd, signal };

  // The lease expires at the step's timeout, which the call then keeps.
  if (expiresAt !== undefined) options.timeout = Math.max(1, Date.parse(expiresAt) - Date.now());
  const started = performance.now();

  try {
    const { text, tool, tokens } = await caller.callTool(promptOf(prompt, output), options);
    const durationMs = Math.round(performance.now() - started);
    const ran: AnswerReport = { outcome: 'success', tool, durationMs };

    if (tokens) ran.tokens = tokens;

    if (takesText(output)) return { ...ran, outputs: { text: text.trim() } };
    const reply = parseReply(text);

    if (reply === undefined) {
      return { ...ran, ...failed({ code: 'invalid_output', message: `${tool} replied with no JSON value, which this step's output needs: ${text.trim().slice(0, 200)}` }) };
    }

    return { ...ran, outputs: reply };
  } catch (cause) {
    if (cause instanceof CallError) return failed({ code: FAILURE_OF[cause.kind], message: cause.message });
    throw cause;
  }
}
