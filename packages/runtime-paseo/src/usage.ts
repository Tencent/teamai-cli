import path from 'node:path';
import { HOST_PROCESSES } from '@teamai/shared/exec';
import { FsFailureSchema, isPermissionDenied } from '@teamai/shared/fs-failure';
import { ClaudeCodeAdapter } from '@teamai/tool-core/formats/claude-code';
import { CodexAdapter } from '@teamai/tool-core/formats/codex';
import type { AgentAdapter } from '@teamai/tool-core/sessions/base';
import type { SessionHost } from '@teamai/tool-core/sessions/platform';
import { stepUsage, type StepTokenFormat, type StepUsage, type Unmeasured } from '@teamai/tool-core/step-usage';
import type { PaseoTool } from './providers.js';

// ─── The tokens a step's agent billed ────────────────────
//
//  Paseo reports a turn's usage without the tokens written to the prompt cache, so the runtime reads them where the
//  agent's tool keeps them: the transcript of its session, in the tool home the session was found in, on a daemon on this
//  machine. OpenCode's steps report none.
//

/** Where a tool's session transcripts are under a tool home, and the format they record tokens in. */
type Transcript = { sessions(toolHome: string, host: SessionHost): AgentAdapter; tokens: StepTokenFormat };

/** The transcript each tool's sessions record their tokens in, or undefined when the runtime reads none. */
const TRANSCRIPTS: Record<PaseoTool, Transcript | undefined> = {
  claude: { sessions: (toolHome) => new ClaudeCodeAdapter('claude-code', path.join(toolHome, 'projects')), tokens: 'claude-jsonl' },
  codex: { sessions: (toolHome, host) => new CodexAdapter('codex', path.join(toolHome, 'sessions'), host), tokens: 'codex-rollout' },
  // OpenCode keeps its sessions in a database only its tool family reads.
  opencode: undefined,
};

/** Whether a step on `tool` can report its tokens, read from its session's transcript on this machine. */
export function readsTokens(tool: PaseoTool): boolean {
  return TRANSCRIPTS[tool] !== undefined;
}

/** Why teamai cannot read the step's tokens in `folders` of `tool`'s store, which it has no permission to list. */
function unlistable(tool: PaseoTool, folders: readonly string[]): Unmeasured {
  const named = folders.join(', ');

  return {
    cause: `teamai cannot list ${named}, where ${tool} keeps its sessions, because it has no permission to read ${folders.length > 1 ? 'them' : 'it'}.`,
    next: `Let the user teamai runs as read ${named}, then retry the step.`,
  };
}

/**
 * The transcript of session `sessionId` of `tool` in `toolHome`, or why teamai cannot find it, as a folder the daemon's
 * tool can write and teamai cannot read: the step it ran finished all the same.
 */
async function transcriptOf(format: Transcript, { tool, toolHome, cwd, sessionId }: { tool: PaseoTool; toolHome: string; cwd: string; sessionId: string }): Promise<{ kind: 'found'; transcript: string } | Extract<StepUsage, { kind: 'unmeasured' }>> {
  const skipped: string[] = [];

  // The runtime only reads sessions, and only writing one runs a tool's CLI, so each tool is its own command here and no
  // tool's command starts in a home.
  const host: SessionHost = {
    processes: HOST_PROCESSES, executablesOf: (name) => [name], skippedFolder: (folder) => skipped.push(folder),
    homeEnvAt: (name, dir) => { throw new Error(`The Paseo runtime only reads ${name} sessions, so it starts no ${name} command in ${dir}.`); },
  };

  let transcript: string | undefined;

  try {
    transcript = (await format.sessions(toolHome, host).listConversations(cwd)).find((session) => session.sessionId === sessionId)?.filePath;
  } catch (error) {
    const failure = FsFailureSchema.safeParse(error);

    if (failure.success && isPermissionDenied(failure.data)) return { kind: 'unmeasured', why: unlistable(tool, [failure.data.path ?? toolHome]) };

    return { kind: 'unmeasured', why: { cause: `Listing the ${tool} sessions in ${toolHome} failed (${failure.success ? failure.data.message : String(error instanceof Error ? error.message : error)}).`, next: 'Retry the step.' } };
  }

  if (transcript !== undefined) return { kind: 'found', transcript };

  if (skipped.length > 0) return { kind: 'unmeasured', why: unlistable(tool, skipped) };

  return { kind: 'unmeasured', why: { cause: `${tool} lists no session ${sessionId} for ${cwd} in ${toolHome}, where teamai reads the step's tokens.`, next: 'Retry the step.' } };
}

/**
 * The tokens a step billed in session `sessionId` of `tool`, kept in `toolHome` for `cwd`, as `stepUsage` reads them
 * (`turnSentAt` for a turn sent to an agent that already ran), or why teamai read none: the step then reports no usage,
 * never zero. Undefined for a tool whose transcript records no tokens.
 */
export async function sessionUsage({ tool, toolHome, cwd, sessionId, turnSentAt }: { tool: PaseoTool; toolHome: string; cwd: string; sessionId: string; turnSentAt?: number }): Promise<StepUsage | undefined> {
  const format = TRANSCRIPTS[tool];

  if (format === undefined) return undefined;
  const found = await transcriptOf(format, { tool, toolHome, cwd, sessionId });

  return found.kind === 'found' ? stepUsage({ format: format.tokens, transcriptPath: found.transcript, sessionId, ...(turnSentAt !== undefined && { turnSentAt }) }) : found;
}
