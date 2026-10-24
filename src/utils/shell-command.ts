/**
 * The one shell command-line parser (#884): an agent's shell call split into
 * simple commands, and what the call did with files.
 *
 * Only a call that surely ran its reader or search is one: one simple command,
 * a pipeline that starts with it, or a command list in the small grammar
 * classifyList reads. Whether an item of any other list ran cannot be known
 * without running the shell, so such a call is neither. The files are the
 * command's file operands only: never a flag's value, a sed script, a search
 * pattern or a redirect target.
 */
import { isAbsolutePath } from './agent-path.js';

/** An operator that ends a simple command. A newline is a `;`. */
export type ShellOperator = ';' | '&&' | '||' | '|' | '&';

export interface Redirect {
  /** The operator, with the file descriptor written before it: `>`, `2>`, `2>&`, `<`, `&>`, `<<`… */
  op: string;
  /** The word after it: a file, or the descriptor a `>&` duplicates. */
  target: string;
}

export interface SimpleCommand {
  /** Its words with the quotes removed, redirects left out. */
  words: string[];
  redirects: Redirect[];
  /** The operator after it; null for the last command. */
  op: ShellOperator | null;
}

/** What a shell call did with files. */
export interface ShellClassification {
  category: 'read' | 'search' | 'list' | 'shell';
  /**
   * As written in the command. A read: the files it read. A search: where it
   * searched, the part of each operand before any glob (`.` for the cwd), or
   * none when it prints counts, not lines.
   */
  paths: string[];
  /** A search's only file or directory operand, when it has one with nothing to expand. */
  target?: string;
  /** True when the reader or search is the call's only command, not the head of a pipeline or an item of a list. */
  simple: boolean;
  /** A read's or search's command word, as written: `cat`, `/bin/cat`. A list's is the first one it counts. */
  verb?: string;
}

const REDIRECT = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/;

/** The characters an unquoted backslash escapes: whitespace and those the shell gives a meaning. */
const ESCAPABLE = /[\s'"\\$`()&;|<>*?#!]/;

const HOME_REF = /(?:~|\$HOME|\$\{HOME\})(?=[\\/])/y;

function homeRefLength(line: string, at: number): number {
  HOME_REF.lastIndex = at;
  return HOME_REF.exec(line)?.[0].length ?? 0;
}

/**
 * The simple commands of a shell command line, split on `;`, `&&`, `||`, `|`,
 * `&` and newlines outside quotes, each with the operator after it. A
 * redirect (`2>&1`, `> out`, `<in`) is kept apart with its target. An
 * unquoted `#` at the start of a word begins a comment that runs to the end
 * of the line. Outside quotes a backslash escapes whitespace or a character
 * the shell gives a meaning (`my\ doc.md`), and joins a line to the next;
 * before any other character it is kept, so an unquoted Windows path
 * (`C:\kb\x.md`) stays whole. Inside double quotes it escapes only `"`,
 * `\` or `$`, and inside single quotes nothing. Given `home`, `$HOME/` and
 * `${HOME}/` expand outside single quotes; `~/` expands only unquoted.
 */
export function simpleCommands(command: string, home?: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], op: null };
  let word: string | null = null;
  let quote: string | null = null;
  let redirect: string | null = null;
  const endWord = (): void => {
    if (word === null) return;
    if (redirect !== null) current.redirects.push({ op: redirect, target: word });
    else current.words.push(word);
    word = null;
    redirect = null;
  };
  const endCommand = (op: ShellOperator | null): void => {
    endWord();
    if (redirect !== null) current.redirects.push({ op: redirect, target: '' });
    redirect = null;
    // An empty command (a blank line, a doubled `;`) ends nothing: the previous command keeps its operator.
    if (current.words.length === 0 && current.redirects.length === 0) return;
    current.op = op;
    commands.push(current);
    current = { words: [], redirects: [], op: null };
  };
  const line = command.trimEnd();
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (next === '"' || next === '\\' || next === '$')) word += line[++i];
      else if (quote === '"' && c === '$' && home !== undefined && homeRefLength(line, i) > 0) {
        i += homeRefLength(line, i) - 1;
        word += home;
      } else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && next === '\n') {
      i++;
    } else if (c === '\\' && next !== undefined && ESCAPABLE.test(next)) {
      word = (word ?? '') + next;
      i++;
    } else if (c === '#' && word === null) {
      // A `#` that starts a word starts a comment, up to the newline; `a#b` is a word.
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A file descriptor written just before the operator belongs to it: `2>&1`.
      const fd = word !== null && /^\d+$/.test(word) ? word : '';
      if (fd) word = null;
      else endWord();
      const op = REDIRECT.exec(line.slice(i))![0];
      i += op.length - 1;
      redirect = fd + op;
    } else if (c === '|') {
      if (next === '|' || next === '&') i++;
      endCommand(next === '|' ? '||' : '|');
    } else if (c === '&') {
      if (next === '&') i++;
      endCommand(next === '&' ? '&&' : '&');
    } else if (c === ';' || c === '\n') {
      endCommand(';');
    } else if (/\s/.test(c)) {
      endWord();
    } else if (word === null && home !== undefined && homeRefLength(line, i) > 0) {
      i += homeRefLength(line, i) - 1;
      word = home;
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand(null);
  return commands;
}

/** A command's words from its command word on, after any `NAME=value` assignments. */
export function commandWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return words.slice(i);
}

/**
 * The operands of `args`, skipping flags and the values of `valueFlags`.
 * After `--` every word is an operand; a lone `-` (stdin) is none.
 */
function operands(args: string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (valueFlags.includes(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out.filter((a) => a !== '-');
}

/** A sed script that only prints a line or a range of lines: `5p`, `1,80p`. */
const SED_PRINT = /^\d+(?:,\d+)?p$/;

/**
 * The files `sed` reads when it only prints lines: quiet (`-n`), never in
 * place (`-i`), and every script a line or a range print. The first operand
 * is the script unless `-e` gave one.
 */
function sedPrintFiles(args: string[]): string[] {
  let quiet = false;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('-')) rest.push(a);
    else if (a === '--in-place' || a.startsWith('--in-place=') || (!a.startsWith('--') && a.includes('i'))) return [];
    else if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice('--expression='.length));
    // A script from a file is unknown.
    else if (a === '-f' || a === '--file' || a.startsWith('--file=')) return [];
    else if (a === '-l' || a === '--line-length') i++;
    else if (a === '--quiet' || a === '--silent') quiet = true;
    else if (!a.startsWith('--')) {
      // A cluster of short flags, such as `-nE`; a trailing `e` takes the next word as the script.
      if (a.includes('n')) quiet = true;
      if (a.endsWith('e')) scripts.push(args[++i] ?? '');
    }
  }
  if (!quiet) return [];
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!);
  return scripts.length > 0 && scripts.every((s) => SED_PRINT.test(s)) ? operands(rest) : [];
}

const HEAD_TAIL_VALUE_FLAGS = ['-n', '-c', '--lines', '--bytes'];
const BAT_VALUE_FLAGS = ['-l', '--language', '-H', '--highlight-line', '-r', '--line-range', '-m', '--map-syntax',
  '--theme', '--style', '--tabs', '--terminal-width', '--wrap', '--color', '--italic-text', '--decorations',
  '--paging', '--pager', '--file-name'];

/**
 * The reader verbs, each giving the files a call reads. Ported from the
 * classification in Codex's codex-rs/shell-command/src/parse_command.rs
 * (Apache-2.0).
 */
const READERS: Record<string, (args: string[]) => string[]> = {
  cat: (args) => operands(args),
  bat: (args) => operands(args, BAT_VALUE_FLAGS),
  batcat: (args) => operands(args, BAT_VALUE_FLAGS),
  less: (args) => operands(args, ['-p', '-P', '-x', '-y', '-z', '-j', '-b', '-h', '-o', '-O', '-t', '-T',
    '--pattern', '--prompt', '--tabs', '--shift', '--jump-target']),
  more: (args) => operands(args, ['-n', '--lines']),
  head: (args) => operands(args, HEAD_TAIL_VALUE_FLAGS),
  tail: (args) => operands(args, [...HEAD_TAIL_VALUE_FLAGS, '-s', '--sleep-interval', '--pid', '--max-unchanged-stats']),
  nl: (args) => operands(args, ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w',
    '--body-numbering', '--section-delimiter', '--footer-numbering', '--header-numbering', '--line-increment',
    '--join-blank-lines', '--number-format', '--number-separator', '--starting-line-number', '--number-width']),
  sed: sedPrintFiles,
};

/** Get-Content's parameters that name its files, and its switches: every other parameter takes a value. */
const GET_CONTENT_PATHS = new Set(['path', 'literalpath', 'pspath', 'lp']);
const GET_CONTENT_SWITCHES = new Set(['raw', 'wait', 'force', 'asbytestream', 'verbose', 'debug']);

/**
 * The files PowerShell's Get-Content reads: its positional operands and the
 * values of `-Path` and `-LiteralPath`, written `-Path x` or `-Path:x`.
 * Parameter names are case-insensitive; an unknown one takes the next word as
 * its value, so the word is never taken for a file.
 */
function getContentFiles(args: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const param = /^-([A-Za-z]+)(:?)(.*)$/.exec(args[i]);
    if (!param) {
      files.push(args[i]);
      continue;
    }
    const [, name, colon, inline] = param;
    if (GET_CONTENT_SWITCHES.has(name.toLowerCase())) continue;
    const value = colon ? inline : args[++i];
    if (GET_CONTENT_PATHS.has(name.toLowerCase()) && value) files.push(value);
  }
  return files;
}

/**
 * PowerShell's readers, looked up in lowercase since PowerShell ignores case:
 * Get-Content and its aliases `gc`, `type` (cmd's too) and `cat`. `cat` as
 * written in lowercase is POSIX cat's, which reads `cat -Path x` the same.
 */
const POWERSHELL_READERS: Record<string, (args: string[]) => string[]> = {
  'get-content': getContentFiles,
  gc: getContentFiles,
  type: getContentFiles,
  cat: getContentFiles,
};

/**
 * The aliases that read only in PowerShell or cmd: in a POSIX shell `type` is
 * a builtin that prints what a name is, and `gc` is no command. They count
 * under a PowerShell tool, or when every file is a Windows path.
 */
const WINDOWS_ONLY_READERS = new Set(['type', 'gc']);

/** A Windows path: a drive letter, or any `\` (`.\x.md`, a UNC `\\server\share\x.md`). */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]|\\/;

/** The shell the call ran in, when the tool names it. */
export interface ShellFlavor {
  /** The agent's PowerShell tool ran it. */
  powershell?: boolean;
  /** The home directory the shell expands a leading `~`, `$HOME` or `${HOME}` before `/` or `\` to (`simpleCommands`). */
  home?: string;
}

/**
 * A search verb's flags, each written `-x` or `--name`: those that take a
 * value, those whose value is the pattern (so no operand is), and those that
 * make it print file names or counts instead of lines.
 */
interface SearchVerb {
  values: readonly string[];
  patterns: readonly string[];
  lists: readonly string[];
  counts: readonly string[];
}

const GREP: SearchVerb = {
  values: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context',
    '--before-context', '--context', '--directories', '--devices', '--include', '--exclude', '--exclude-dir',
    '--exclude-from', '--label', '--binary-files', '--group-separator'],
  patterns: ['-e', '-f', '--regexp', '--file'],
  lists: ['-l', '-L', '--files-with-matches', '--files-without-match'],
  counts: ['-c', '--count'],
};

/**
 * The search verbs, each with its flags; `git grep` is `git-grep`. Ported from
 * the same Codex classification as the readers.
 */
const SEARCHERS: Record<string, SearchVerb> = {
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  'git-grep': {
    values: ['-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file', '--max-count', '--after-context',
      '--before-context', '--context', '--max-depth', '--threads'],
    patterns: GREP.patterns,
    lists: [...GREP.lists, '-O', '--name-only', '--open-files-in-pager'],
    counts: GREP.counts,
  },
  rg: {
    values: ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-M', '-j', '-r', '-E', '-d', '--regexp', '--file',
      '--glob', '--iglob', '--type', '--type-not', '--type-add', '--type-clear', '--max-count', '--after-context',
      '--before-context', '--context', '--max-columns', '--threads', '--replace', '--encoding', '--max-depth',
      '--max-filesize', '--sort', '--sortr', '--pre', '--pre-glob', '--ignore-file', '--context-separator',
      '--path-separator', '--field-match-separator', '--field-context-separator', '--colors', '--color', '--engine'],
    patterns: GREP.patterns,
    // rg's -L follows symlinks.
    lists: ['-l', '--files', '--files-with-matches', '--files-without-match', '--type-list'],
    counts: ['-c', '--count', '--count-matches'],
  },
  ag: {
    values: ['-A', '-B', '-C', '-G', '-g', '-m', '-p', '--after', '--before', '--context', '--file-search-regex',
      '--max-count', '--ignore', '--ignore-dir', '--depth', '--path-to-ignore', '--pager', '--workers'],
    patterns: [],
    lists: ['-g', '-l', '-L', '--files-with-matches', '--files-without-matches', '--filename-pattern', '--list-file-types'],
    counts: ['-c', '--count'],
  },
  ack: {
    values: ['-A', '-B', '-C', '-g', '-m', '--after-context', '--before-context', '--context', '--max-count', '--match',
      '--type', '--ignore-dir', '--output', '--pager'],
    patterns: ['--match'],
    lists: ['-f', '-g', '-l', '-L', '--files-with-matches', '--files-without-matches'],
    counts: ['-c', '--count'],
  },
};

/** The list verbs: they show paths, never a file's lines. `git ls-files` is `git-ls-files`. */
const LISTERS = new Set(['ls', 'find', 'fd', 'tree', 'git-ls-files']);

/** A word the shell would expand, so it names no file as written. */
const EXPANDS = /[$`*?[\]{}()]/;

/** What a search prints, from its flags, and its file or directory operands. */
function searchArgs(args: string[], verb: SearchVerb): { shows: 'lines' | 'paths' | 'counts'; operands: string[] } {
  let shows: 'lines' | 'paths' | 'counts' = 'lines';
  let pattern = false;
  const words: string[] = [];
  const flag = (f: string): void => {
    if (verb.lists.includes(f)) shows = 'paths';
    else if (verb.counts.includes(f) && shows === 'lines') shows = 'counts';
    if (verb.patterns.includes(f)) pattern = true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      flag(name);
      if (eq === -1 && verb.values.includes(name)) i++;
    } else if (a.startsWith('-') && a.length > 1) {
      // A cluster of short flags, such as `-rn`: one that takes a value takes the rest of it, or the next word.
      for (let j = 1; j < a.length; j++) {
        const f = `-${a[j]}`;
        flag(f);
        if (verb.values.includes(f)) {
          if (j === a.length - 1) i++;
          break;
        }
      }
    } else {
      words.push(a);
    }
  }
  return { shows, operands: pattern ? words : words.slice(1) };
}

/**
 * Where a search operand points: its part before the first segment with a
 * glob or a variable, split on `/` or `\\`. A root (`/`, `C:\\`) keeps its
 * separator.
 */
function searchRoot(operand: string): string {
  const glob = /(?:^|[\\/])[^\\/]*[$`*?[\]{}()]/.exec(operand);
  if (!glob) return operand;
  const dir = operand.slice(0, glob.index + (glob.index === 0 && !/^[\\/]/.test(operand) ? 0 : 1));
  if (/^(?:[A-Za-z]:)?[\\/]$/.test(dir)) return dir;
  return dir.replace(/[\\/]$/, '') || '.';
}

const SHELL: ShellClassification = { category: 'shell', paths: [], simple: false };

/**
 * What one simple command did with files. Only a stderr redirect
 * (`2>/dev/null`, `2>&1`) is allowed: with its input or output redirected,
 * what the agent saw is not the file.
 */
function classifySimple(command: SimpleCommand, simple: boolean, flavor: ShellFlavor): ShellClassification {
  const [verb, ...rest] = commandWords(command.words);
  if (verb === undefined || !command.redirects.every((r) => r.op.startsWith('2>'))) return SHELL;
  // By path on either platform, `.exe` too: `C:\\…\\cat.exe`, `Microsoft.PowerShell.Management\\Get-Content`.
  const base = verb.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
  const name = base === 'git' && rest.length > 0 ? `git-${rest[0]}` : base;
  const args = name === base ? rest : rest.slice(1);

  // Own keys only: a verb like `constructor` must not hit Object.prototype.
  const read = (Object.hasOwn(READERS, name) ? READERS[name] : undefined)
    ?? (Object.hasOwn(POWERSHELL_READERS, name.toLowerCase()) ? POWERSHELL_READERS[name.toLowerCase()] : undefined);
  if (read) {
    const files = read(args);
    if (WINDOWS_ONLY_READERS.has(name.toLowerCase()) && !flavor.powershell && !files.every((f) => WINDOWS_PATH.test(f))) return SHELL;
    return files.length > 0 && !files.some((f) => EXPANDS.test(f)) ? { category: 'read', paths: files, simple, verb } : SHELL;
  }
  if (LISTERS.has(name)) return { category: 'list', paths: [], simple };
  const search = Object.hasOwn(SEARCHERS, name) ? SEARCHERS[name] : undefined;
  if (!search) return SHELL;
  const { shows, operands: roots } = searchArgs(args, search);
  if (shows === 'paths') return { category: 'list', paths: [], simple };
  if (shows === 'counts') return { category: 'search', paths: [], simple, verb };
  const target = roots.length === 1 && !EXPANDS.test(roots[0]) ? roots[0] : undefined;
  return { category: 'search', paths: roots.length > 0 ? roots.map(searchRoot) : ['.'], ...(target ? { target } : {}), simple, verb };
}

/**
 * What a shell command line did with files: a read, a search or a listing
 * when it is one such command, or a pipeline that starts with one; a read
 * when it is a list classifyList reads; otherwise just a shell call.
 * `succeeded`: the call exited 0.
 */
export function classifyShellCommand(command: string, flavor: ShellFlavor = {}, succeeded = false): ShellClassification {
  const commands = simpleCommands(command, flavor.home);
  const pipeline = commands.every((c, i) => c.op === (i === commands.length - 1 ? null : '|'));
  if (commands.length === 0) return SHELL;
  return pipeline ? classifySimple(commands[0], commands.length === 1, flavor) : classifyList(command, commands, flavor, succeeded);
}

/**
 * The files each reader among a command line's simple commands names (`sed -n 1,200p a/SKILL.md` on one line of many),
 * whether or not it ran (`false && cat a/SKILL.md; true`), for a caller that confirms each from the call's output.
 * None when a heredoc feeds a command, since its body is no command, and none relative after a `cd`.
 */
export function namedReads(command: string, flavor: ShellFlavor = {}): string[] {
  const commands = simpleCommands(command, flavor.home);
  if (commands.some((c) => c.redirects.some((r) => r.op.startsWith('<<') && r.op !== '<<<'))) return [];
  const files: string[] = [];
  let moved = false;
  for (const c of commands) {
    moved ||= c.words[0] === 'cd';
    const read = classifySimple(c, false, flavor);
    if (read.category === 'read') files.push(...read.paths.filter((file) => !moved || isAbsolutePath(file)));
  }
  return files;
}

/** A character a plain list has nowhere, quoted or not. */
const NOT_PLAIN = /[|$`(){}<#]|[^\S \t\n]/;

/**
 * Whether the shell reads `command` as plain words and the operators `;`,
 * `&&` and newline: every quote closed, no command left empty before an
 * operator or after a final `&&`, and none of `|`, a lone `&`, `$` (but a
 * `$HOME` or `${HOME}` path prefix), a backtick, `(`, `)`, `{`, `}`, `<`, `#`,
 * a line continuation, or whitespace other than a space, a tab or a newline,
 * quoted or not.
 */
function isPlainList(command: string): boolean {
  let quote: string | null = null;
  // No word since the start or the last operator, and an `&&` still waiting for its command.
  let empty = true;
  let pending = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '$' && homeRefLength(command, i) > 0) {
      i += homeRefLength(command, i) - 1;
    } else if (NOT_PLAIN.test(c)) {
      return false;
    } else if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
      continue;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '\\') {
      if (command[i + 1] === '\n') return false;
      i++;
    } else if (c === ';' || (c === '&' && command[i + 1] === '&')) {
      if (empty) return false;
      if (c === '&') i++;
      pending = c === '&';
      empty = true;
      continue;
    } else if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      return false;
    } else if (/\s/.test(c)) {
      if (c === '\n') empty = true;
      continue;
    }
    empty = false;
    pending = false;
  }
  return quote === null && !pending;
}

/** A `test` or `[` check of one file: it exists, is a file, a directory, readable, or not empty. */
const FILE_TESTS = new Set(['-e', '-f', '-d', '-r', '-s']);

/**
 * One command of a list: a read classifySimple accepts, by its bare name, or
 * a guard that cannot end, replace or reconfigure the shell. `fails`: whether
 * the guard can exit non-zero.
 */
type ListItem =
  | { kind: 'read'; read: ShellClassification }
  | { kind: 'cd'; dir: string }
  | { kind: 'guard'; fails: boolean };

/** A list's command, when it is a read or a guard with no redirect but one that cannot fail: `2>/dev/null`, `2>&1`. */
function listItem(command: SimpleCommand, flavor: ShellFlavor): ListItem | undefined {
  const [name, ...args] = command.words;
  const redirects = command.redirects.every((r) => (r.op === '2>' && r.target === '/dev/null') || (r.op === '2>&' && r.target === '1'));
  if (name === undefined || !redirects) return undefined;
  if (['pwd', 'true', ':'].includes(name) && args.length === 0) return { kind: 'guard', fails: false };
  if (name === 'echo') return { kind: 'guard', fails: false };
  if (name === 'ls') return { kind: 'guard', fails: true };
  if (name === 'test' && args.length === 2 && FILE_TESTS.has(args[0])) return { kind: 'guard', fails: true };
  if (name === '[' && args.length === 3 && FILE_TESTS.has(args[0]) && args[2] === ']') return { kind: 'guard', fails: true };
  if (name === 'cd') return args.length === 1 && /^[^-+~]/.test(args[0]) && !EXPANDS.test(args[0]) ? { kind: 'cd', dir: args[0] } : undefined;
  // A name with a path, an extension or an assignment may be no reader at all.
  if (/[\\/.=]/.test(name)) return undefined;
  const read = classifySimple(command, false, flavor);
  return read.category === 'read' ? { kind: 'read', read } : undefined;
}

/** `file` under the relative or absolute directory `dir` (`''`: the call's cwd). */
function under(dir: string, file: string): string {
  return isAbsolutePath(file) || dir === '' ? file : `${dir}/${file}`;
}

/**
 * A list of reads and guards (listItem) joined by `;`, `&&` or newlines in a
 * plain command line (isPlainList): a read, never a simple one, of the files
 * the reads of its last `&&` chain read. A read earlier in the list may have
 * failed with the call still exiting 0, so it counts for nothing. Without
 * `succeeded` only the chain's first read counts, and only when no command
 * before it in the chain can fail. A `cd` in the chain moves its later
 * relative paths; after one in an earlier chain, which may have failed, only
 * absolute paths count.
 */
function classifyList(command: string, commands: SimpleCommand[], flavor: ShellFlavor, succeeded: boolean): ShellClassification {
  if (!isPlainList(command)) return SHELL;
  let paths = new Set<string>();
  let verb: string | undefined;
  // The chain's directory from the call's cwd, null when unknown; whether it moved; whether nothing before can fail.
  let dir: string | null = '';
  let moved = false;
  let sure = true;
  for (const [i, c] of commands.entries()) {
    const item = listItem(c, flavor);
    if (item === undefined) return SHELL;
    if (item.kind === 'read' && (succeeded || sure)) {
      for (const file of item.read.paths) if (dir !== null || isAbsolutePath(file)) paths.add(under(dir ?? '', file));
      verb ??= item.read.verb;
    }
    if (item.kind === 'cd') {
      dir = dir === null && !isAbsolutePath(item.dir) ? null : under(dir ?? '', item.dir);
      moved = true;
    }
    if (item.kind !== 'guard' || item.fails) sure = false;
    if (c.op === ';' && i < commands.length - 1) {
      paths = new Set();
      verb = undefined;
      if (moved) dir = null;
      moved = false;
      sure = true;
    }
  }
  return paths.size > 0 ? { category: 'read', paths: [...paths], simple: false, verb } : SHELL;
}
