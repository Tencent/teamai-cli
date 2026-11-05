import { z } from 'zod';
import { JsonValueSchema, type JsonValue } from '../types.js';
import type { ConfinedAccess } from './confined-level.js';
import type { Evidence } from '../tools.js';
import { agyRun, readToolMetadata, type TokenUsage } from './stdout.js';

/** What a headless call printed: its answer, or the error the tool reported, when it reported one. */
export type CallReading = { ok: true; text: string; tokens?: TokenUsage } | { ok: false; message?: string };

/** What a finished call left: its stdout, and the last message it wrote to the file `args` named, if it wrote one. */
export interface CallOutput {
  stdout: string;
  lastMessage: string | undefined;
}

/** What a call's arguments may name: the prompt, and fresh paths in a scratch directory for its prompt and last message. */
export interface CallInput {
  prompt: string;
  /** Holds the prompt when the profile takes it from a file. */
  promptFile: string;
  /** For a tool that writes its last message to a file. */
  lastMessageFile: string;
}

/** How an adapter runs a prompt headless and reads the answer back. */
export interface CallLaunch {
  readonly evidence: Evidence;
  /** How the prompt reaches the tool: on stdin, in `promptFile`, or as an argument `args` places. */
  readonly prompt: 'stdin' | 'file' | 'argv';
  /** What goes on stdin for a `stdin` prompt, when the tool takes it wrapped rather than as is. */
  stdinOf?(prompt: string): string;
  args(input: CallInput): string[];
  read(output: CallOutput): CallReading;
}

/**
 * The tool's own mode for editing and running commands without asking, which a step with `permissions: unattended`
 * runs in: its arguments, and what they were checked against. `'none'`: teamai knows no such mode, so it launches no
 * such step on the tool.
 */
export type UnattendedLaunch = { readonly args: readonly string[]; readonly evidence: Evidence } | 'none';

/** A workflow step: a session the adapter starts and resumes, in `local-tool-adapter.ts`. */
export interface StepLaunch {
  readonly evidence: Evidence;
  readonly unattended: UnattendedLaunch;
}

/** A run confined to one directory, in `confined.ts`: what judges a scorer. */
export interface ConfinedLaunch {
  readonly evidence: Evidence;
  /** The member's variables the run keeps, beyond the common ones. */
  readonly env: readonly string[];
  /** The variable the tool reads its home from. A run started outside the member's shell, as background scoring is, gets the recorded one. */
  readonly homeEnv?: string;
  /** The versions whose confinement has been checked; any other version runs at best-effort. */
  readonly verified?: RegExp;
  /** What the run can do beyond answering. */
  readonly access: ConfinedAccess;
}

export interface LaunchAdapter {
  /** The command that starts the tool, when it is not the tool's id. */
  readonly executable?: string;
  readonly call: CallLaunch;
  readonly step?: StepLaunch;
  readonly confined?: ConfinedLaunch;
}

function jsonLines(stdout: string): JsonValue[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();

    if (!trimmed.startsWith('{')) return [];

    try {
      const value = JsonValueSchema.safeParse(JSON.parse(trimmed));

      return value.success ? [value.data] : [];
    } catch { return []; }
  });
}

/** A call that gave no answer, with the reason the tool reported when it reported one. */
function failed(message: string | undefined): CallReading {
  return message === undefined ? { ok: false } : { ok: false, message };
}

/** A call's answer, with the tokens it billed when the tool reported them. */
function answered(text: string, tokens: TokenUsage | undefined): CallReading {
  return tokens === undefined ? { ok: true, text } : { ok: true, text, tokens };
}

/** The counts a tool reported, or undefined when it reported none. */
function reportedTokens(counts: TokenUsage): TokenUsage | undefined {
  const tokens: TokenUsage = {};

  if (counts.input !== undefined) tokens.input = counts.input;

  if (counts.output !== undefined) tokens.output = counts.output;

  if (counts.cachedInput !== undefined) tokens.cachedInput = counts.cachedInput;

  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

const ClaudeResult = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional() }).partial().optional(),
});

/** Claude's `--output-format json` result record, which CodeBuddy prints too. */
function readClaudeResult({ stdout }: CallOutput): CallReading {
  const record = jsonLines(stdout).flatMap((line) => {
    const parsed = ClaudeResult.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  }).at(-1);

  if (!record) return { ok: false };

  // An error exits 1 with the reason in `result`; stderr carries only a tag such as `[claude-code:unrecognized_model]`.
  if (record.is_error || record.result === undefined) return failed(record.result || undefined);
  const usage = record.usage;

  return answered(record.result.trim(), reportedTokens({ input: usage?.input_tokens, output: usage?.output_tokens, cachedInput: usage?.cache_read_input_tokens }));
}

const CodexError = z.union([
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
]);

/** Codex writes its last message to the `-o` file, and prints its events, the turn's usage included, as JSON lines. */
function readCodexExec({ stdout, lastMessage }: CallOutput): CallReading {
  const text = lastMessage?.trim();

  if (!text) {
    const error = jsonLines(stdout).flatMap((line) => {
      const parsed = CodexError.safeParse(line);

      return parsed.success ? [parsed.data] : [];
    }).at(-1);

    return failed(error?.type === 'error' ? error.message : error?.error.message);
  }

  return answered(text, readToolMetadata(stdout)?.tokens);
}

const OpenCodeEvent = z.union([
  z.object({ type: z.literal('text'), part: z.object({ text: z.string() }) }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string() }) }),
]);

/** OpenCode prints the answer as `text` parts and an error as an `error` event; `step_finish` carries the tokens. */
function readOpenCodeRun({ stdout }: CallOutput): CallReading {
  const events = jsonLines(stdout).flatMap((line) => {
    const parsed = OpenCodeEvent.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const error = events.flatMap((event) => event.type === 'error' ? [event.error.message] : []).at(-1);
  const text = events.flatMap((event) => event.type === 'text' ? [event.part.text] : []).join('\n').trim();

  if (error !== undefined || !text) return failed(error);

  return answered(text, readToolMetadata(stdout)?.tokens);
}

const OpenClawEnvelope = z.object({
  ok: z.boolean(),
  final: z.string().optional(),
  usage: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** `openclaw agent exec --json` prints one envelope: `final` is the answer, `usage` the tokens, `error` the failure. */
function readOpenClawExec({ stdout }: CallOutput): CallReading {
  let candidate: unknown;

  try { candidate = JSON.parse(stdout.trim()); } catch { candidate = jsonLines(stdout).at(-1); }

  const parsed = OpenClawEnvelope.safeParse(candidate);

  if (!parsed.success) return { ok: false };
  const { ok, final, usage, error } = parsed.data;

  if (!ok || !final?.trim()) return failed(error?.message);

  return answered(final.trim(), reportedTokens({ input: usage?.input, output: usage?.output }));
}

const PiReply = z.object({
  type: z.literal('message_end'),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number() }).partial().optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
});

/** pi and omp print the turn's events; the assistant's `message_end` carries the reply, its usage and any error. */
function readPiJson({ stdout }: CallOutput): CallReading {
  const reply = jsonLines(stdout).flatMap((line) => {
    const parsed = PiReply.safeParse(line);

    return parsed.success ? [parsed.data.message] : [];
  }).at(-1);

  if (!reply) return { ok: false };

  // pi exits 0 on a provider error; the reply's stop reason says it failed.
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') return failed(reply.errorMessage || undefined);
  const text = reply.content.flatMap((part) => part.type === 'text' && part.text !== undefined ? [part.text] : []).join('\n').trim();

  if (!text) return { ok: false };
  const { usage } = reply;

  return answered(text, reportedTokens({ input: usage?.input, output: usage?.output, cachedInput: usage?.cacheRead }));
}

const MuseRecord = z.object({ payload_type: z.string(), payload: z.record(z.string(), z.unknown()) });
const MuseTerminal = z.object({ terminal: z.string(), text: z.string().nullable().optional(), reason: z.string().nullable().optional() });
const MuseUsage = z.object({ models: z.array(z.object({ input_tokens: z.number(), cached_tokens: z.number(), output_tokens: z.number() }).partial()) });

/** `muse exec --json` prints one record per event: the run's terminal record carries the answer, `run.usage` the tokens. */
function readMuseExec({ stdout }: CallOutput): CallReading {
  const records = jsonLines(stdout).flatMap((line) => {
    const parsed = MuseRecord.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });

  const terminal = records.flatMap((record) => {
    const parsed = record.payload_type.startsWith('run.terminal.') ? MuseTerminal.safeParse(record.payload) : undefined;

    return parsed?.success ? [parsed.data] : [];
  }).at(-1);

  if (!terminal) return { ok: false };
  const text = terminal.text?.trim();

  if (terminal.terminal !== 'completed' || !text) return failed(terminal.reason || undefined);

  const models = records.flatMap((record) => {
    const parsed = record.payload_type === 'run.usage' ? MuseUsage.safeParse(record.payload) : undefined;

    return parsed?.success ? parsed.data.models : [];
  });

  const sum = (key: 'input_tokens' | 'cached_tokens' | 'output_tokens') => models.some((model) => model[key] !== undefined) ? models.reduce((total, model) => total + (model[key] ?? 0), 0) : undefined;

  return answered(text, reportedTokens({ input: sum('input_tokens'), output: sum('output_tokens'), cachedInput: sum('cached_tokens') }));
}

/** agy's stream-json output ends with a `result` event: the response on SUCCESS, else the error, and the turn's usage. */
function readAgyStream({ stdout }: CallOutput): CallReading {
  const { result, tokens } = agyRun(stdout);

  if (!result) return { ok: false };
  const text = result.response?.trim();

  if (result.status !== 'SUCCESS' || !text) return failed(result.error || undefined);

  return answered(text, tokens);
}

/** A tool that prints only its reply, as plain text. */
function readPlainReply({ stdout }: CallOutput): CallReading {
  const text = stdout.trim();

  return text ? { ok: true, text } : { ok: false };
}

/** How teamai launches each family of tools headless. A tool picks its adapter with the `launch` facet in `TOOLS`. */
// oxlint-disable-next-line teamai/tool-facts -- keyed by launch adapter id, which this table defines; a tool picks one with TOOLS.launch
export const LAUNCH_ADAPTERS = {
  claude: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
    // Claude Code 2.1.312 ran a strict-sandbox benchmark trial in this mode (2026-10-30, `teamai benchmark run --sandbox`).
    step: { evidence: 'verified', unattended: { args: ['--permission-mode', 'bypassPermissions'], evidence: 'verified' } },
    confined: {
      evidence: 'verified',
      env: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
      homeEnv: 'CLAUDE_CONFIG_DIR',
      verified: /^2\.1\.308 \(Claude Code\)$/,
      access: 'read',
    },
  },
  codex: {
    call: { evidence: 'verified', prompt: 'stdin', args: ({ lastMessageFile }) => ['exec', '--json', '--skip-git-repo-check', '-o', lastMessageFile, '-'], read: readCodexExec },
    // `codex exec --help` of codex-cli 0.165.0: "Intended solely for running in environments that are externally sandboxed".
    step: { evidence: 'verified', unattended: { args: ['--dangerously-bypass-approvals-and-sandbox'], evidence: 'docs' } },
    // Codex also signs in with CODEX_API_KEY ("run codex login or set CODEX_API_KEY").
    confined: { evidence: 'verified', env: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'], homeEnv: 'CODEX_HOME', verified: /^codex-cli 0\.163\.0$/, access: 'read' },
  },
  opencode: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['run', '--format', 'json'], read: readOpenCodeRun },
    // `opencode run --help` of 2.1.2 and opencode.ai/docs/permissions: approves every request a rule does not deny.
    step: { evidence: 'verified', unattended: { args: ['--auto'], evidence: 'docs' } },
    confined: { evidence: 'verified', env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY'], verified: /^opencode v2\.1\.2$/, access: 'read' },
  },
  codebuddy: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json'], read: readClaudeResult },
    // Claude's flags and stream, without --effort. Its unattended mode is codebuddy.ai/docs/cli/permission-modes.
    step: { evidence: 'docs', unattended: { args: ['--permission-mode', 'bypassPermissions'], evidence: 'docs' } },
    // CodeBuddy lists about 70 tools whatever `--tools` says.
    confined: { evidence: 'docs', env: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'CODEBUDDY_CONFIG_DIR'], homeEnv: 'CODEBUDDY_CONFIG_DIR', access: 'full' },
  },
  // One embedded turn with ephemeral state, so no call leaves a session in the member's conversations (#1308):
  // after calls on OpenClaw 2026.8.1 (the first with `agent exec`) and 2026.10.9, `openclaw sessions --all-agents --json` counts 0.
  openclaw: {
    call: { evidence: 'verified', prompt: 'stdin', args: () => ['agent', 'exec', '--json', '--message-file', '-'], read: readOpenClawExec },
  },
  cursor: {
    executable: 'cursor-agent',
    // Ask mode answers without editing.
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'], read: readClaudeResult },
    confined: { evidence: 'docs', env: ['CURSOR_API_KEY', 'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR'], access: 'full' },
  },
  // `-s` prints only the reply. Copilot 0.0.x has no JSON output to read tokens from.
  copilot: {
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['-p', prompt, '-s'], read: readPlainReply },
  },
  pi: {
    call: { evidence: 'source', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
    confined: {
      evidence: 'docs',
      env: ['PI_CODING_AGENT_DIR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY'],
      homeEnv: 'PI_CODING_AGENT_DIR',
      access: 'full',
    },
  },
  // pi's fork: the same call and events, with flags of its own elsewhere.
  omp: {
    call: { evidence: 'docs', prompt: 'stdin', args: () => ['-p', '--mode', 'json', '--no-session'], read: readPiJson },
  },
  // muse reads no prompt from stdin: `--prompt-file` takes a regular file only.
  muse: {
    call: { evidence: 'verified', prompt: 'file', args: ({ promptFile }) => ['exec', '--json', '--no-session-log', '--prompt-file', promptFile], read: readMuseExec },
  },
  qoder: {
    executable: 'qodercli',
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['-p', prompt], read: readPlainReply },
  },
  kiro: {
    executable: 'kiro-cli',
    call: { evidence: 'docs', prompt: 'argv', args: ({ prompt }) => ['chat', '--no-interactive', prompt], read: readPlainReply },
  },
  hermes: {
    call: { evidence: 'source', prompt: 'argv', args: ({ prompt }) => ['-z', prompt], read: readPlainReply },
  },
  // agy reads stdin only as stream-json user events. `--print=` is print mode with the prompt left to them; a bare
  // `-p` would take the next flag as its prompt.
  agy: {
    // `agy --help` of 1.4.10.
    step: { evidence: 'verified', unattended: { args: ['--dangerously-skip-permissions'], evidence: 'docs' } },
    // Plan mode with the sandbox reads files but runs no shell and writes nothing in the workspace (agy 1.4.10).
    confined: { evidence: 'verified', env: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'], access: 'read' },
    call: {
      evidence: 'verified',
      prompt: 'stdin',
      stdinOf: (prompt) => `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`,
      args: () => ['--input-format=stream-json', '--output-format=stream-json', '--print='],
      read: readAgyStream,
    },
  },
} as const satisfies Record<string, LaunchAdapter>;

export type LaunchAdapterId = keyof typeof LAUNCH_ADAPTERS;
