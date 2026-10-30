/**
 * CodeBuddy project-scoped team hooks on Windows (#1446).
 *
 * CodeBuddy IDE runs one shared settings.json entry through cmd.exe while the
 * CodeBuddy CLI runs that same entry through Git Bash.  A POSIX `$PWD` gate
 * therefore cannot live in the entry itself.  The renderer puts the project
 * gate and the actual team command into base64url arguments of the explicit
 * Git-Bash launcher; this module applies the gate after the launcher has
 * started teamai, then runs the payload with the same Git Bash.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runHookCommand } from './hook-command.js';

export interface CodebuddyProjectGate {
  root: string;
  children: string[];
}

/** Encode path data as one shell-safe argument (base64url has no shell metacharacters). */
export function encodeCodebuddyProjectGate(root: string, children: readonly string[] = []): string {
  return Buffer.from(JSON.stringify({ root, children }), 'utf8').toString('base64url');
}

/** Decode a rendered project-gate argument without trusting arbitrary JSON. */
export function decodeCodebuddyProjectGate(value: string): CodebuddyProjectGate | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { root, children } = parsed as { root?: unknown; children?: unknown };
    if (typeof root !== 'string' || !Array.isArray(children) || !children.every((child) => typeof child === 'string')) return null;
    return { root, children };
  } catch {
    return null;
  }
}

/** The literal command shape teamai writes for a CodeBuddy Windows project gate. */
const CODEBUDDY_TEAM_GATE_RE = /\bhook-dispatch\s+(\S+)\s+--tool\s+codebuddy\s+--team-hooks\s+--team-hook-id\s+([a-z0-9-]+)\s+--team-hook-gate\s+([A-Za-z0-9_-]+)\s+--team-hook-command\s+([A-Za-z0-9_-]+)(?:\s+--team-hook-timeout\s+(\d+(?:\.\d+)?))?$/;

export interface RenderedCodebuddyTeamGate {
  event: string;
  id: string;
  gate: CodebuddyProjectGate;
  encodedGate: string;
  encodedCommand: string;
  timeout?: number;
}

/** Parse only a complete teamai-rendered CodeBuddy project dispatcher command. */
export function parseCodebuddyTeamGate(command: string): RenderedCodebuddyTeamGate | null {
  const match = CODEBUDDY_TEAM_GATE_RE.exec(command);
  if (!match) return null;
  const gate = decodeCodebuddyProjectGate(match[3]);
  if (!gate) return null;
  const timeout = match[5] === undefined ? undefined : Number(match[5]);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) return null;
  return {
    event: match[1],
    id: match[2],
    gate,
    encodedGate: match[3],
    encodedCommand: match[4],
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/** Replace a rendered gate's encoded root/children while preserving its payload. */
export function regateCodebuddyTeamHookCommand(
  command: string,
  root: string,
  children: readonly string[] = [],
): string | null {
  const rendered = parseCodebuddyTeamGate(command);
  if (!rendered) return null;
  return command.replace(`--team-hook-gate ${rendered.encodedGate}`, `--team-hook-gate ${encodeCodebuddyProjectGate(root, children)}`);
}

/** Resolve a path as the hook process does, without requiring the project still exists. */
function resolvedPath(value: string): string {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

/** Whether `cwd` is `root` or one of its descendants. */
function isInProject(root: string, cwd: string): boolean {
  const relative = path.relative(resolvedPath(root), resolvedPath(cwd));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Decide whether a rendered gate belongs to a project root.  The settings file
 * is shared by all projects, so callers use this while replacing/removing only
 * the entries their own project owns.
 */
export function isCodebuddyTeamGateForProject(command: string, root: string): boolean {
  const rendered = parseCodebuddyTeamGate(command);
  return rendered !== null && resolvedPath(rendered.gate.root) === resolvedPath(root);
}

/** Read the host payload before forwarding it to the declared team command. */
async function readHookPayload(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  })();
  void read.catch(() => {});
  try {
    await Promise.race([
      read,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, 1_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut && !process.stdin.destroyed) process.stdin.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run one encoded CodeBuddy team hook.  Outside the selected project (or inside
 * one of its child scopes) this deliberately does nothing and returns zero.
 * Inside it forwards stdout, stderr, and the payload's exit status unchanged.
 */
export async function runCodebuddyTeamHook(
  encodedGate: string,
  encodedCommand: string,
  timeout?: number,
): Promise<number> {
  const gate = decodeCodebuddyProjectGate(encodedGate);
  if (!gate) {
    process.stderr.write('teamai: invalid CodeBuddy project hook gate\n');
    return 1;
  }
  const cwd = process.cwd();
  if (!isInProject(gate.root, cwd) || gate.children.some((child) => isInProject(child, cwd))) return 0;

  let command: string;
  try {
    command = Buffer.from(encodedCommand, 'base64url').toString('utf8');
  } catch {
    process.stderr.write('teamai: invalid CodeBuddy team hook command\n');
    return 1;
  }
  if (!command) return 0;

  const result = await runHookCommand(command, { cwd, timeout: timeout ?? 60, stdin: await readHookPayload() });
  if (result.stdout) await new Promise<void>((resolve) => process.stdout.write(result.stdout, () => resolve()));
  if (result.stderr) await new Promise<void>((resolve) => process.stderr.write(result.stderr, () => resolve()));
  if (result.timedOut) {
    process.stderr.write(`teamai: CodeBuddy team hook timed out after ${timeout ?? 60}s\n`);
    return 1;
  }
  return result.code ?? 1;
}