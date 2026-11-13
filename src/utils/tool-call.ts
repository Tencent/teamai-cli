/**
 * The tool-call classifier (#884): the one place that maps an agent's
 * PostToolUse to what the call did, the files it read, and whether it
 * succeeded. Recall adoption builds on it.
 *
 *   tool_name ── normalizeToolName ── CATEGORY_OF ─┬─ read    the path field
 *                                                  ├─ search  its output_mode, shownFiles(content)
 *                                                  ├─ list    nothing: it shows paths, not a file's lines
 *                                                  └─ shell   classifyShellCommand(command), shownFiles(output) for a search
 *   responseOf ── statusOf (or a bridge's tool_status), outputOf, searchOutputOf
 *   status unknown: withoutErrors(output), a shell call that printed only its command's errors failed,
 *                   and a read did not read a file an error names
 *
 * Paths are resolved and compared by agent-path, the same on every OS, so a
 * Windows member's `C:\kb\x.md` is one file however it is written. A new
 * agent adds its tool names to CATEGORY_OF and its output fields to
 * responseOf. A name not listed here is `unknown` and never counts.
 */
import { isAbsolutePath, isWithin, resolvePath, samePath, withoutReadSelector } from './agent-path.js';
import { getUserHome } from './home.js';
import { resolveHookCwd } from './hook-cwd.js';
import { classifyShellCommand } from './shell-command.js';
import { normalizeToolName } from './tool-names.js';
import { z } from 'zod';
import { HookPayloadSchema, type HookPayload } from '../types.js';
import { baseDescriptorOf } from '../tool-registry.js';

/** What a call did: `read`/`search`/`list` whether a tool or a shell command did it; `shell` for any other shell call. */
export type ToolCategory = 'read' | 'shell' | 'search' | 'list' | 'unknown';

export type ToolStatus = 'success' | 'failure' | 'unknown';

export interface ToolCall {
  category: ToolCategory;
  /**
   * The files it read, or a search's output showed lines of: absolute when
   * the call had a cwd to resolve them against, as written otherwise.
   */
  paths: string[];
  status: ToolStatus;
  /** True when the read or search was the call's only command: a tool, or a shell command neither in a pipeline nor an item of a list. */
  simple: boolean;
  /** A shell call's command line. */
  command?: string;
  /** The text output the agent sent, when it sent one. */
  output?: string;
}

/**
 * Tool names by what they do, after normalizeToolName (which turns
 * `search_content` into `Grep` and `list_dir` into `Glob`).
 */
const CATEGORY_OF = new Map<string, Exclude<ToolCategory, 'unknown'>>([
  ['Read', 'read'],
  // OpenCode's (`filePath`).
  ['read', 'read'],
  // Copilot's; Qoder IDE's PascalCase spelling of `read_file` (unverified).
  ['view', 'read'],
  ['ReadFile', 'read'],
  ['Bash', 'shell'],
  // Copilot's (and the bridges' lowercase name), Cursor's, Qoder IDE's.
  ['bash', 'shell'],
  ['Shell', 'shell'],
  ['run_in_terminal', 'shell'],
  // Claude's and CodeBuddy's PowerShell tool, and Copilot's.
  ['PowerShell', 'shell'],
  ['powershell', 'shell'],
  ['Grep', 'search'],
  ['grep_code', 'search'],
  ['grep', 'search'],
  ['rg', 'search'],
  ['Glob', 'list'],
  ['glob', 'list'],
  ['search_file', 'list'],
  ['list_files', 'list'],
  ['LS', 'list'],
  ['ls', 'list'],
  ['find', 'list'],
]);

/**
 * Search tools whose `output_mode` defaults to listing files (Claude's Grep
 * and the agents that copy it). The lowercase `grep` of OpenCode and Pi has
 * no mode: it always prints lines.
 */
const LISTS_BY_DEFAULT = new Set(['Grep', 'grep_code']);

/** Agents whose read path can carry a selector inline (OMP's `x.md:50-200`, `x.md:raw`). */
const READ_SELECTORS = new Set(['omp']);

/** Whether a line rule reads `agent`'s search tool output (`searchEvidence`); an unknown agent's is read. */
function readsSearchEvidence(agent: string | undefined): boolean {
  return agent === undefined || (baseDescriptorOf(agent)?.searchEvidence ?? true);
}

/** A string, or undefined for any other value. */
const OptionalTextSchema = z.string().optional().catch(undefined);

/** The fields of a response object the classifier reads; an `exitCode` or `result_type` of another type reads as absent. */
const ResponseFieldsSchema = z.looseObject({
  exitCode: z.number().optional().catch(undefined),
  result_type: z.string().optional().catch(undefined),
  stdout: z.unknown().optional(),
  text_result_for_llm: z.unknown().optional(),
  content: z.unknown().optional(),
  results: z.unknown().optional(),
  mode: z.unknown().optional(),
});

/** The agent's response to the call: its text when it is a string, its fields when it is an object, neither otherwise. */
interface ToolResponse {
  text?: string;
  fields?: z.infer<typeof ResponseFieldsSchema>;
}

const ToolResponseSchema = z.union([
  z.string().transform((text): ToolResponse => ({ text })),
  ResponseFieldsSchema.transform((fields): ToolResponse => ({ fields })),
]).catch(() => ({}));

/**
 * The agent's response to the call: `tool_response` (Claude and the agents
 * that copy it), Cursor's `tool_output` (the result as a JSON string, kept as
 * text when it is not an object's), or Copilot's `tool_result`.
 */
function responseOf(stdin: HookPayload): ToolResponse {
  if (stdin.tool_response !== undefined) return ToolResponseSchema.parse(stdin.tool_response);

  if (stdin.tool_output !== undefined) {
    try {
      const fields = ResponseFieldsSchema.safeParse(JSON.parse(stdin.tool_output));

      return fields.success ? { fields: fields.data } : { text: stdin.tool_output };
    } catch {
      return { text: stdin.tool_output };
    }
  }

  return ToolResponseSchema.parse(stdin.tool_result);
}

/**
 * The call's status from the agent's response. Claude sends PostToolUse only
 * on success; an `exitCode` (Cursor's Shell, CodeBuddy IDE, Qoder, ZCode)
 * tells a failure apart, and so does Copilot's `result_type`. Codex sends its
 * output as a plain string with no exit code: unknown. A generated bridge
 * (OpenCode, Pi, OMP) sends the status it normalized from the host as `tool_status`.
 */
function statusOf(stdin: HookPayload, response: ToolResponse): ToolStatus {
  const bridged = stdin.tool_status;

  if (bridged !== undefined) return bridged;
  const r = response.fields;

  if (!r) return 'unknown';

  if (r.exitCode !== undefined) return r.exitCode !== 0 ? 'failure' : 'success';

  if (r.result_type !== undefined) return r.result_type === 'success' ? 'success' : 'failure';

  return 'success';
}

/** Claude's and Cursor's response is `{ stdout, … }`; Codex's is the output string; Copilot's is its text result. */
function outputOf(response: ToolResponse): string | undefined {
  const r = response.fields;

  return response.text ?? OptionalTextSchema.parse(r?.stdout ?? r?.text_result_for_llm);
}

/**
 * A search tool's text output: the string itself (OpenCode, Pi), Claude's
 * and ZCode's `content`, Qoder's `results`, or Copilot's text result. A
 * `filenames` list is a listing and is never read.
 */
function searchOutputOf(response: ToolResponse): string | undefined {
  if (response.text !== undefined) return response.text;
  const r = response.fields;

  return OptionalTextSchema.parse(r?.content ?? r?.results ?? r?.text_result_for_llm);
}

/** Whether `file` is `root` or under it; always, when `root` has no base to place it. */
function within(file: string, root: string): boolean {
  if (!isAbsolutePath(root)) return true;

  return isAbsolutePath(file) && isWithin(file, root);
}

/** Whether a path ends in a file name: a name with an extension (`redis-timeout.md`, `SKILL.md`), not a word of text. */
function endsInFileName(p: string): boolean {
  return /[^\\/\s.][^\\/]*\.[A-Za-z0-9]+$/.test(p);
}

/**
 * A search tool's line that stands for its matches or sums them up, never a
 * line of a file: OpenCode's `No files found` and `Found N matches`, Pi's
 * and CodeBuddy's `No matches found`. A shell search prints none.
 */
const STATUS_LINE = /^(?:No (?:files|matches) found|Found \d+ match(?:es)?\b.*)$/;

/**
 * Whether a search's output shows a line of a file: a line that is neither
 * blank nor, from a search tool, its status line. Content has no shape to
 * look for (`grep` without `-n`, `Grep` with `-n: false` print the bare
 * line), so this names what is not content, which is only what a host
 * prints in place of or above its matches.
 */
function showsLines(output: string, plain: boolean): boolean {
  return output.split('\n').some((line) => line.trim() !== '' && (plain || !STATUS_LINE.test(line.trim())));
}

/**
 * The files a search's output shows lines of, never its text. A search of
 * one file (a `target` that ends in a file name) prints no path on its lines
 * (Pi prints the basename), so no line names a file: the target counts when
 * the output shows a line of it (showsLines). Otherwise a line counts when it starts with a
 * path under one of the search `roots` that ends in a file name, followed by
 * `:<line>:` (`path:12:text`), or by `:` in the formats without line numbers:
 * a shell search's `path:text` (`plain`: grep and rg without `-n`) and
 * OpenCode's `path:` header, alone on its line. Paths resolve against
 * `base`; a Windows path's drive colon (`C:\kb\x.md:12:`) is part of it. A
 * bare path line is a listing. A lone operand that names no file may be a
 * directory: it counts when the output shows a line and names nothing
 * under it. Only the output held in memory is scanned: no file is read.
 */
function shownFiles(output: string, roots: string[], base: string | undefined, target: string | undefined, plain: boolean): string[] {
  if (target !== undefined && endsInFileName(target)) return showsLines(output, plain) ? [target] : [];
  const files = new Set<string>();
  let under = false;

  for (const line of output.split('\n')) {
    const colon = line.indexOf(':', /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0);

    if (colon <= 0) continue;
    const prefix = line.slice(0, colon);

    // Text before a colon (`Cause: …`, `12:text`, OpenCode's `  Line 12: text`) is no path.
    if (/^\s/.test(prefix) || !endsInFileName(prefix)) continue;
    const rest = line.slice(colon);

    if (!plain && !/^:\d+:/.test(rest) && rest.trimEnd() !== ':') continue;
    const file = resolvePath(prefix, base);

    if (!roots.some((root) => within(file, root))) continue;
    files.add(file);

    if (target !== undefined && !samePath(file, target)) under = true;
  }

  if (target !== undefined && !under && showsLines(output, plain)) files.add(target);

  return [...files];
}

/** A POSIX shell's own diagnostic: `bash: line 1: cat: command not found`, `sh: 1: head: not found`, `/bin/bash: …`. */
const SHELL_DIAGNOSTIC = /^(?:\S*\/)?(?:ba|z)?sh: /;

/** What {@link withoutErrors} keeps of a shell call's output, and the files its error lines name. */
interface OutputWithoutErrors {
  content: string | null;
  named: string[];
}

/**
 * A shell call's output without the lines its command printed as errors:
 * those that start with its command word, as written or by name, and `: `
 * (`cat: x.md: No such file or directory`, `/bin/cat: …`, `grep: …`), and the
 * shell's own diagnostics. `content` is null when those lines were all it
 * printed, as when the call failed. `named` holds the file each such
 * `<verb>: <file>: …` line names, unquoted.
 */
function withoutErrors(output: string, verb: string): OutputWithoutErrors {
  const prefixes = [...new Set([verb, verb.split(/[\\/]/).pop()!])].map((name) => `${name}: `);
  const lines = output.split('\n');
  const named: string[] = [];

  const kept = lines.filter((line) => {
    if (SHELL_DIAGNOSTIC.test(line)) return false;
    const prefix = prefixes.find((p) => line.startsWith(p));

    if (prefix === undefined) return true;
    const file = /^(.+?): /.exec(line.slice(prefix.length))?.[1];

    if (file !== undefined) named.push(file.replace(/^'(.*)'$/, '$1'));

    return false;
  });

  if (kept.length === lines.length) return { content: output, named };

  return { content: kept.some((line) => line.trim() !== '') ? kept.join('\n') : null, named };
}

/** Classify one PostToolUse payload from `agent` (the dispatch tool id). */
export function classifyToolCall(stdin: HookPayload, agent?: string): ToolCall {
  // Parsed again: a caller may hand over a payload read without the schema.
  const payload = HookPayloadSchema.parse(stdin);
  const name = normalizeToolName(payload.tool_name ?? '');
  const category = CATEGORY_OF.get(name);
  const input = payload.tool_input;
  const response = responseOf(payload);
  const status = statusOf(payload, response);
  const cwd = resolveHookCwd(payload);
  const unknown: ToolCall = { category: 'unknown', paths: [], status, simple: false };

  if (!input || !category) return unknown;

  if (category === 'read') {
    // `filePath`: CodeBuddy IDE's `read_file` (unverified); `path`: Copilot's `view`, and Cursor's Read too.
    const file = OptionalTextSchema.parse(input.file_path ?? input.filePath ?? input.path);

    if (file === undefined || !file.trim()) return unknown;
    const spelled = READ_SELECTORS.has(agent ?? '') ? withoutReadSelector(file) : file;

    return { category, paths: [resolvePath(spelled, cwd)], status, simple: true };
  }

  if (category === 'list') return { category, paths: [], status, simple: true };

  if (category === 'search') {
    const given = OptionalTextSchema.parse(input.output_mode ?? response.fields?.mode);
    const mode = given ?? (LISTS_BY_DEFAULT.has(name) ? 'files_with_matches' : 'content');

    if (mode === 'files_with_matches') return { category: 'list', paths: [], status, simple: true };
    const output = searchOutputOf(response);

    if (mode !== 'content' || output === undefined || !readsSearchEvidence(agent)) {
      return { category, paths: [], status, simple: true };
    }

    // Relative output paths are relative to the searched path (Pi), else to the cwd.
    const searched = OptionalTextSchema.parse(input.path);
    const root = searched?.trim() ? resolvePath(searched, cwd) : undefined;
    const base = root ?? cwd;
    const target = root !== undefined && isAbsolutePath(root) ? root : undefined;

    return { category, paths: shownFiles(output, base ? [base] : [], base, target, false), status, simple: true };
  }

  const command = OptionalTextSchema.parse(input.command);

  if (command === undefined) return unknown;
  const shell = classifyShellCommand(command, { powershell: name.toLowerCase() === 'powershell', home: getUserHome() }, status === 'success');
  const output = outputOf(response);
  const optional = output !== undefined ? { output } : {};

  // With no status, only the command's own error lines tell a failure apart.
  const errors = status === 'unknown' && output !== undefined && shell.verb !== undefined
    ? withoutErrors(output, shell.verb)
    : { content: output, named: [] };

  const content = errors.content;

  if (content === null) return { category: shell.category, paths: [], status: 'failure', simple: shell.simple, command, ...optional };

  if (shell.category === 'search') {
    // A shell search prints paths as its operands wrote them: relative to the cwd.
    const roots = shell.paths.map((f) => resolvePath(f, cwd));
    // Only a lone search prints its output; after a pipe, what shows may no longer be the file's lines.
    const target = shell.target !== undefined && shell.simple ? resolvePath(shell.target, cwd) : undefined;
    const paths = content !== undefined ? shownFiles(content, roots, cwd, target, true) : [];

    return { category: 'search', paths, status, simple: shell.simple, command, ...optional };
  }

  // A read did not read a file its command's error names.
  const failed = errors.named.map((f) => resolvePath(f, cwd));

  return {
    category: shell.category,
    paths: shell.paths.map((f) => resolvePath(f, cwd)).filter((f) => !failed.some((e) => samePath(e, f))),
    status,
    simple: shell.simple,
    command,
    ...optional,
  };
}
