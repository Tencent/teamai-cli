/**
 * The one shell command-line parser (#884): an agent's shell call split into
 * simple commands, and what the call did with files.
 *
 * Only a call that surely ran its reader or search is one: one simple command,
 * or a pipeline that starts with it. Any `;`, `&&`, `||` or `&` means it may
 * never have run, so the call is neither. The files are the command's file
 * operands only: never a flag's value, a sed script, a search pattern or a
 * redirect target.
 */

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
  /** True when the reader or search is the call's only command, not the head of a pipeline. */
  simple: boolean;
  /** A read's or search's command word, as written: `cat`, `/bin/cat`. */
  verb?: string;
}

const REDIRECT = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/;

/** The characters an unquoted backslash escapes: whitespace and those the shell gives a meaning. */
const ESCAPABLE = /[\s'"\\$`()&;|<>*?#!]/;

/**
 * The simple commands of a shell command line, split on `;`, `&&`, `||`, `|`,
 * `&` and newlines outside quotes, each with the operator after it. A
 * redirect (`2>&1`, `> out`, `<in`) is kept apart with its target. An
 * unquoted `#` at the start of a word begins a comment that runs to the end
 * of the line. Outside quotes a backslash escapes whitespace or a character
 * the shell gives a meaning (`my\ doc.md`), and joins a line to the next;
 * before any other character it is kept, so an unquoted Windows path
 * (`C:\kb\x.md`) stays whole. Inside double quotes it escapes only `"` or
 * `\`, and inside single quotes nothing.
 */
export function simpleCommands(command: string): SimpleCommand[] {
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
      else if (c === '\\' && quote === '"' && (next === '"' || next === '\\')) word += line[++i];
      else word += c;
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
 * when it is one such command, or a pipeline that starts with one; otherwise
 * just a shell call.
 */
export function classifyShellCommand(command: string, flavor: ShellFlavor = {}): ShellClassification {
  const commands = simpleCommands(command);
  const pipeline = commands.every((c, i) => c.op === (i === commands.length - 1 ? null : '|'));
  return pipeline && commands.length > 0 ? classifySimple(commands[0], commands.length === 1, flavor) : SHELL;
}
