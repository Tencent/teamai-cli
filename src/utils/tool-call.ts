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
import { classifyShellCommand, classifySimpleShellCommand, commandWords, simpleCommands } from './shell-command.js';
import type { SimpleCommand, ShellFlavor } from './shell-command.js';
import { normalizeToolName } from './tool-names.js';

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
  /** True when the read or search was the call's only command: a tool, or a shell command outside a pipeline. */
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
const CATEGORY_OF: Record<string, Exclude<ToolCategory, 'unknown'>> = {
  Read: 'read',
  // OpenCode's (`filePath`).
  read: 'read',
  // Copilot's; Qoder IDE's PascalCase spelling of `read_file` (unverified).
  view: 'read',
  ReadFile: 'read',
  Bash: 'shell',
  // Copilot's (and the bridges' lowercase name), Cursor's, Qoder IDE's.
  bash: 'shell',
  Shell: 'shell',
  run_in_terminal: 'shell',
  // Claude's and CodeBuddy's PowerShell tool, and Copilot's.
  PowerShell: 'shell',
  powershell: 'shell',
  Grep: 'search',
  grep_code: 'search',
  grep: 'search',
  rg: 'search',
  Glob: 'list',
  glob: 'list',
  search_file: 'list',
  list_files: 'list',
  LS: 'list',
  ls: 'list',
  find: 'list',
};

/**
 * Search tools whose `output_mode` defaults to listing files (Claude's Grep
 * and the agents that copy it). The lowercase `grep` of OpenCode and Pi has
 * no mode: it always prints lines.
 */
const LISTS_BY_DEFAULT = new Set(['Grep', 'grep_code']);

/**
 * Agents whose search tool output no line rule reads yet: OMP's grep prints
 * a markdown tree, Cursor's Grep format is unverified. Their shell searches
 * still count.
 */
const NO_SEARCH_EVIDENCE = new Set(['omp', 'cursor']);

/** Agents whose read path can carry a selector inline (OMP's `x.md:50-200`, `x.md:raw`). */
const READ_SELECTORS = new Set(['omp']);

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The agent's response to the call: `tool_response` (Claude and the agents
 * that copy it), Cursor's `tool_output` (the result as a JSON string, kept as
 * text when it is not an object's), or Copilot's `tool_result`.
 */
function responseOf(stdin: Record<string, unknown>): unknown {
  if (stdin.tool_response !== undefined) return stdin.tool_response;
  if (typeof stdin.tool_output === 'string') {
    try {
      return asObject(JSON.parse(stdin.tool_output)) ?? stdin.tool_output;
    } catch {
      return stdin.tool_output;
    }
  }
  return stdin.tool_result;
}

/**
 * The call's status from the agent's response. Claude sends PostToolUse only
 * on success; an `exitCode` (Cursor's Shell, CodeBuddy IDE, Qoder, ZCode)
 * tells a failure apart, and so does Copilot's `result_type`. Codex sends its
 * output as a plain string with no exit code: unknown. A generated bridge
 * (OpenCode, Pi, OMP) sends the status it normalized from the host as `tool_status`.
 */
function statusOf(stdin: Record<string, unknown>, response: unknown): ToolStatus {
  const bridged = stdin.tool_status;
  if (bridged === 'success' || bridged === 'failure' || bridged === 'unknown') return bridged;
  const r = asObject(response);
  if (!r) return 'unknown';
  if (typeof r.exitCode === 'number') return r.exitCode !== 0 ? 'failure' : 'success';
  if (typeof r.result_type === 'string') return r.result_type === 'success' ? 'success' : 'failure';
  return 'success';
}

/** Claude's and Cursor's response is `{ stdout, … }`; Codex's is the output string; Copilot's is its text result. */
function outputOf(response: unknown): string | undefined {
  const r = asObject(response);
  const output = typeof response === 'string' ? response : r?.stdout ?? r?.text_result_for_llm;
  return typeof output === 'string' ? output : undefined;
}

/**
 * A search tool's text output: the string itself (OpenCode, Pi), Claude's
 * and ZCode's `content`, Qoder's `results`, or Copilot's text result. A
 * `filenames` list is a listing and is never read.
 */
function searchOutputOf(response: unknown): string | undefined {
  if (typeof response === 'string') return response;
  const r = asObject(response);
  const output = r?.content ?? r?.results ?? r?.text_result_for_llm;
  return typeof output === 'string' ? output : undefined;
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

function shellDiagnosticCommand(line: string): string | undefined {
  const command = /^(?:\S*\/)?(?:ba|z)?sh: (?:(?:-c: )?line \d+: |\d+: )(.+?): /.exec(line)?.[1];
  return command?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * A shell call's output without the lines its command printed as errors:
 * those that start with its command word, as written or by name, and `: `
 * (`cat: x.md: No such file or directory`, `/bin/cat: …`, `grep: …`), and the
 * shell's own diagnostics. `content` is null when those lines were all it
 * printed, as when the call failed. `named` holds the file each such
 * `<verb>: <file>: …` line names, unquoted. `hadCommandError` records whether
 * an error line attributable to this command was removed.
 */
function withoutErrors(output: string, verb: string): { content: string | null; named: string[]; hadCommandError: boolean } {
  const prefixes = [...new Set([verb, verb.split(/[\\/]/).pop()!])].map((name) => `${name}: `);
  const commandName = verb.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  const lines = output.split('\n');
  const named: string[] = [];
  let hadCommandError = false;
  const kept = lines.filter((line) => {
    if (SHELL_DIAGNOSTIC.test(line)) {
      if (shellDiagnosticCommand(line) === commandName) hadCommandError = true;
      return false;
    }
    const prefix = prefixes.find((p) => line.startsWith(p));
    if (prefix === undefined) return true;
    hadCommandError = true;
    const file = /^(.+?): /.exec(line.slice(prefix.length))?.[1];
    if (file !== undefined) named.push(file.replace(/^'(.*)'$/, '$1'));
    return false;
  });
  if (kept.length === lines.length) return { content: output, named, hadCommandError };
  return { content: kept.some((line) => line.trim() !== '') ? kept.join('\n') : null, named, hadCommandError };
}

type ShellExitCode = 0 | 1;

interface ExecutionState {
  status: ShellExitCode;
  reached: boolean;
}

const UNSUPPORTED_COMPOUND_COMMANDS = new Set([
  '.', 'alias', 'break', 'cd', 'continue', 'declare', 'eval', 'exec', 'exit', 'export', 'function', 'local',
  'popd', 'pushd', 'read', 'readonly', 'return', 'set', 'shopt', 'source', 'trap', 'typeset', 'unalias', 'unset',
  'until', 'while', 'for', 'in', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', 'case', 'esac', 'select',
  'coproc', 'time', 'builtin', 'command',
]);

const UNSAFE_COMPOUND_WORD = /[$`*?[\]{}()]/;

/** Reject shell grammar the flat tokenizer cannot safely model. */
function hasUnsupportedCompoundSyntax(command: string): boolean {
  let quote: string | null = null;
  let wordStarted = false;
  let segmentHasToken = false;
  let waitingForAndOrCommand = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === quote) quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || (c === '$' && next === '(')) return true;
      else if (c === '$') {
        const homeRef = /^\$(?:HOME|\{HOME\})(?=[\\/])/.exec(command.slice(i))?.[0];
        if (homeRef) i += homeRef.length - 1;
      } else if (c === '\\' && (next === '"' || next === '\\' || next === '$')) i++;
      continue;
    }
    if (/\s/.test(c)) {
      wordStarted = false;
      if (c === '\n') {
        if (waitingForAndOrCommand) return true;
        segmentHasToken = false;
      }
      continue;
    }
    if (c === '#' && !wordStarted) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      if (!segmentHasToken || waitingForAndOrCommand) return true;
      waitingForAndOrCommand = true;
      segmentHasToken = false;
      wordStarted = false;
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&') {
      if (waitingForAndOrCommand || !segmentHasToken) return true;
      segmentHasToken = false;
      wordStarted = false;
      continue;
    }
    if (c === "'" || c === '"') {
      segmentHasToken = true;
      waitingForAndOrCommand = false;
      wordStarted = true;
      quote = c;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') {
        i++;
        continue;
      }
      segmentHasToken = true;
      waitingForAndOrCommand = false;
      wordStarted = true;
      if (next !== undefined) i++;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(')) return true;
    if (c === '$') {
      const homeRef = /^\$(?:HOME|\{HOME\})(?=[\\/])/.exec(command.slice(i))?.[0];
      if (homeRef) i += homeRef.length - 1;
    } else if (c === '(' || c === ')' || c === '{' || c === '}') return true;
    segmentHasToken = true;
    waitingForAndOrCommand = false;
    wordStarted = true;
  }
  return quote !== null || waitingForAndOrCommand;
}

function statusBuiltin(command: SimpleCommand): ShellExitCode | undefined {
  if (command.redirects.length > 0 || command.words.length !== 1) return undefined;
  switch (command.words[0]) {
    case 'true':
    case ':':
      return 0;
    case 'false':
      return 1;
    default:
      return undefined;
  }
}

function commandVerb(command: SimpleCommand): string | undefined {
  const [word] = commandWords(command.words);
  return word?.split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase();
}

function supportedCompoundCommands(command: string, commands: SimpleCommand[]): boolean {
  if (commands.length === 0 || hasUnsupportedCompoundSyntax(command)) return false;
  if (commands.length === 1 && commands[0].op !== ';') return false;
  if (commands.at(-1)?.op === '&&' || commands.at(-1)?.op === '||') return false;
  return commands.every((segment) => {
    if (segment.op !== null && segment.op !== ';' && segment.op !== '&&' && segment.op !== '||') return false;
    if (segment.redirects.length > 0 || segment.words.length === 0) return false;
    // Leading NAME=value assignments can replace PATH or change a later expansion.
    if (commandWords(segment.words).length !== segment.words.length) return false;
    if (segment.words.some((word) => UNSAFE_COMPOUND_WORD.test(word))) return false;
    const verb = commandVerb(segment);
    return verb !== undefined && !UNSUPPORTED_COMPOUND_COMMANDS.has(verb);
  });
}

/** Whether every possible status trace consistent with the event reaches a reader command. */
function mustReachCommand(
  commands: SimpleCommand[],
  outcomes: ShellExitCode[][],
  target: number,
  finalStatus: ToolStatus,
): boolean {
  let states: ExecutionState[] = [{ status: 1, reached: false }];
  for (let i = 0; i < commands.length; i++) {
    const next: ExecutionState[] = [];
    for (const state of states) {
      const operator = i === 0 ? null : commands[i - 1].op;
      const runs = operator === null || operator === ';'
        || (operator === '&&' && state.status === 0)
        || (operator === '||' && state.status === 1);
      if (!runs) {
        next.push(state);
      } else {
        for (const status of outcomes[i]) next.push({ status, reached: state.reached || i === target });
      }
    }
    states = [...new Map(next.map((state) => [`${state.status}:${state.reached}`, state])).values()];
  }
  const expected = finalStatus === 'success' ? 0 : finalStatus === 'failure' ? 1 : undefined;
  const feasible = expected === undefined ? states : states.filter((state) => state.status === expected);
  return feasible.length > 0 && feasible.every((state) => state.reached);
}

/**
 * The files in a Codex Bash command list that an installed-skill hook may
 * consider. This is intentionally separate from `classifyToolCall`: recall
 * adoption must keep seeing its existing category and path contract.
 */
export function codexCompoundReadPaths(stdin: Record<string, unknown>): string[] {
  if (typeof stdin.tool_name !== 'string' || normalizeToolName(stdin.tool_name) !== 'Bash') return [];
  const input = asObject(stdin.tool_input);
  const command = input?.command;
  if (typeof command !== 'string') return [];
  const cwd = resolveHookCwd(stdin);
  const flavor: ShellFlavor = { home: getUserHome() };
  const segments = simpleCommands(command, flavor.home);
  if (!supportedCompoundCommands(command, segments)) return [];

  const reads = segments.map((segment, index) => {
    const classified = classifySimpleShellCommand(segment, flavor);
    return classified.category === 'read'
      ? { index, verb: classified.verb!, paths: classified.paths.map((file) => resolvePath(file, cwd)) }
      : undefined;
  }).filter((read): read is { index: number; verb: string; paths: string[] } => read !== undefined);
  if (reads.length === 0) return [];

  const response = responseOf(stdin);
  const output = outputOf(response);
  const finalStatus = statusOf(stdin, response);
  const verbCounts = new Map<string, number>();
  for (const read of reads) verbCounts.set(read.verb, (verbCounts.get(read.verb) ?? 0) + 1);
  const diagnostics = new Map<string, { content: string | null; named: string[]; hadCommandError: boolean }>();
  if (output !== undefined) {
    for (const read of reads) {
      if (!diagnostics.has(read.verb)) diagnostics.set(read.verb, withoutErrors(output, read.verb));
    }
  }
  const hasReaderDiagnostic = [...diagnostics.values()].some((diagnostic) =>
    diagnostic.hadCommandError || diagnostic.named.length > 0 || diagnostic.content === null);
  if (reads.length > 1 && hasReaderDiagnostic) return [];

  const outcomes: ShellExitCode[][] = segments.map((segment, index): ShellExitCode[] => {
    const known = statusBuiltin(segment);
    if (known !== undefined) return [known];
    const read = reads.find((candidate) => candidate.index === index);
    if (read && (verbCounts.get(read.verb) ?? 0) === 1) {
      const diagnostic = diagnostics.get(read.verb);
      if (diagnostic && (diagnostic.hadCommandError || diagnostic.named.length > 0 || diagnostic.content === null)) return [1];
    }
    return [0, 1];
  });

  const result: string[] = [];
  for (const read of reads) {
    if (!mustReachCommand(segments, outcomes, read.index, finalStatus)) continue;
    const diagnostic = diagnostics.get(read.verb);
    if (diagnostic?.content === null) continue;
    const onlySilentNeighbors = reads.length === 1 && segments.every((segment, index) =>
      index === read.index || statusBuiltin(segment) !== undefined);
    if (diagnostic?.named.length && !onlySilentNeighbors) continue;
    const failed = diagnostic?.named.map((file) => resolvePath(file, cwd)) ?? [];
    const hasFailedOperand = failed.some((file) => read.paths.some((candidate) => samePath(file, candidate)));

    // A filtered error without an exact operand may be an option/usage failure,
    // even when a later command makes the whole compound list succeed.
    if (diagnostic?.hadCommandError && !hasFailedOperand) continue;

    if (finalStatus === 'failure') {
      const outputBelongsToReader = onlySilentNeighbors && diagnostic !== undefined
        && diagnostic.content !== null && diagnostic.content.trim() !== ''
        && hasFailedOperand;
      if (!outputBelongsToReader) continue;
    }

    for (const file of read.paths) {
      const repeated = reads.flatMap((candidate) => candidate.paths).filter((candidate) => samePath(candidate, file)).length > 1;
      const failedHere = failed.some((candidate) => samePath(candidate, file));
      if (failedHere) continue;
      if (repeated && hasFailedOperand) continue;
      result.push(file);
    }
  }
  return [...new Set(result)];
}

/** Classify one PostToolUse payload from `agent` (the dispatch tool id). */
export function classifyToolCall(stdin: Record<string, unknown>, agent?: string): ToolCall {
  const name = normalizeToolName(typeof stdin.tool_name === 'string' ? stdin.tool_name : '');
  const category = CATEGORY_OF[name];
  const input = asObject(stdin.tool_input);
  const response = responseOf(stdin);
  const status = statusOf(stdin, response);
  const cwd = resolveHookCwd(stdin);
  const unknown: ToolCall = { category: 'unknown', paths: [], status, simple: false };
  if (!input || !category) return unknown;

  if (category === 'read') {
    // `filePath`: CodeBuddy IDE's `read_file` (unverified); `path`: Copilot's `view`, and Cursor's Read too.
    const file = input.file_path ?? input.filePath ?? input.path;
    if (typeof file !== 'string' || !file.trim()) return unknown;
    const spelled = READ_SELECTORS.has(agent ?? '') ? withoutReadSelector(file) : file;
    return { category, paths: [resolvePath(spelled, cwd)], status, simple: true };
  }
  if (category === 'list') return { category, paths: [], status, simple: true };

  if (category === 'search') {
    const given = input.output_mode ?? asObject(response)?.mode;
    const mode = typeof given === 'string' ? given : LISTS_BY_DEFAULT.has(name) ? 'files_with_matches' : 'content';
    if (mode === 'files_with_matches') return { category: 'list', paths: [], status, simple: true };
    const output = searchOutputOf(response);
    if (mode !== 'content' || output === undefined || NO_SEARCH_EVIDENCE.has(agent ?? '')) {
      return { category, paths: [], status, simple: true };
    }
    // Relative output paths are relative to the searched path (Pi), else to the cwd.
    const root = typeof input.path === 'string' && input.path.trim() ? resolvePath(input.path, cwd) : undefined;
    const base = root ?? cwd;
    const target = root !== undefined && isAbsolutePath(root) ? root : undefined;
    return { category, paths: shownFiles(output, base ? [base] : [], base, target, false), status, simple: true };
  }

  const command = input.command;
  if (typeof command !== 'string') return unknown;
  const shell = classifyShellCommand(command, { powershell: name.toLowerCase() === 'powershell', home: getUserHome() });
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
