import path from 'node:path';
import { pathExists, readFileSafe } from './fs.js';
import { getUserHome } from './home.js';
import { TEAMAI_ENV_START, TEAMAI_ENV_END } from '../types.js';

/** Every profile file `detectShellProfile()` could ever have resolved to, across platforms and CLI versions. */
export const SHELL_PROFILE_CANDIDATE_NAMES = ['.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];

/**
 * Detect the shell profile file `teamai`'s env block should be injected into.
 *
 * Shared by `EnvHandler.detectShellProfile` (resources/env.ts) and
 * `teamai uninstall` so both resolve the same file — a second, independent
 * copy previously drifted (#682) and left `uninstall` unable to find the
 * block `pull` had written.
 *
 * `platform` is injectable because CI only runs ubuntu/macos: hardcoding
 * `process.platform` would leave the Windows branch permanently uncovered,
 * which is how #682 went unnoticed. Same pattern as `resolveCliPath` in
 * `utils/cli-path.ts`.
 *
 * `SHELL` is checked before the platform branch, on every platform: a zsh
 * installed via MSYS2/Cygwin on Windows sets `SHELL` just like it does on
 * POSIX, and native Windows Node still reports `platform === 'win32'` in
 * that case. Deferring to the Windows branch unconditionally would silently
 * stop loading `.zshrc` for that setup, even though `SHELL`-based detection
 * already got it right.
 *
 * On Windows, when `SHELL` does not indicate zsh, `SHELL` is otherwise never
 * set, so the POSIX logic below always fell back to `~/.bashrc` — but Git
 * Bash starts as a *login* shell, which reads `~/.bash_profile`,
 * `~/.bash_login` or `~/.profile`, never `~/.bashrc`. The block was written
 * correctly and looked correct on inspection, yet no shell ever sourced it.
 * This mirrors Git for Windows' own fallback in
 * `/etc/profile.d/bash_profile.sh`: it only generates a `.bash_profile` that
 * sources `.bashrc` when none of the three files exist, so preferring an
 * existing one of them — and falling back to `.bashrc` only when none exist —
 * agrees with what Git for Windows itself will end up sourcing.
 */
export async function detectShellProfile(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const home = getUserHome();
  const shell = process.env.SHELL ?? '';

  if (shell.includes('zsh')) {
    return path.join(home, '.zshrc');
  }

  if (platform === 'win32') {
    for (const name of ['.bash_profile', '.bash_login', '.profile']) {
      const candidate = path.join(home, name);
      if (await pathExists(candidate)) return candidate;
    }
  }

  return path.join(home, '.bashrc');
}

/**
 * True for a path a shell must read the Windows way: a drive-letter path
 * (`C:\...` or `C:/...`) or a UNC path (`\\server\share`).
 *
 * A POSIX path is deliberately excluded: there a backslash is an ordinary
 * filename character, not a separator, so collapsing every one of them would
 * silently point the shell at a different directory.
 *
 * Shape-based, not `path.sep`-based: `envShPath` was built by `path.join` on
 * whichever host wrote it, and a check that reads the *current* host's
 * separator is a no-op for a Windows-shaped path inspected from a POSIX host
 * (or vice versa) — the very thing this file's own tests need to exercise,
 * since CI only runs ubuntu/macos (#693 review round 4).
 */
export function isWindowsFormPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** `envShPath` rewritten to the forward-slash form the generator writes, regardless of which host built it. */
function toGeneratedForm(envShPath: string): string {
  return isWindowsFormPath(envShPath) ? envShPath.replace(/\\/g, '/') : envShPath;
}

/**
 * Whether two paths name the same file on disk, independent of separator
 * style or (on Windows) case.
 *
 * Resolved with `path.win32`/`path.posix` explicitly rather than the ambient
 * `path` — both normalize `/` and `\` to one separator either way, but only
 * an explicit choice lets a test exercise the win32 branch on ubuntu/macos CI
 * (same reason `platform` is injectable elsewhere in this file). An override
 * written as `C:/Users/me/.profile` then compares equal to the generated
 * candidate `path.join(home, '.profile')`, which is backslash-separated on
 * win32. Windows filesystems are case-insensitive, so a case difference alone
 * must not make two paths look distinct there either (#693 review round 6).
 */
export function sameFile(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  const left = resolve(a);
  const right = resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Quote a string so it is safe to interpolate into a POSIX shell (bash/zsh/sh).
 * Wraps the value in single quotes and encodes any embedded single quote as
 * `'\''`, leaving all other characters (including `"`, `$`, `` ` ``, `\`)
 * literal. Used both when generating env.sh (env.ts) and when checking
 * whether a block on disk matches that same generated form.
 */
export function shellQuoteValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The TeamAI-managed block of a shell profile, or null when it is absent. */
export function extractEnvBlock(profileContent: string): string | null {
  const start = profileContent.indexOf(TEAMAI_ENV_START);
  if (start === -1) return null;
  const end = profileContent.indexOf(TEAMAI_ENV_END, start);
  return end === -1 ? profileContent.slice(start) : profileContent.slice(start, end);
}

/**
 * Whether an env block's `source` line actually points at `envShPath`.
 *
 * A profile can carry more than one teamai-managed block over its lifetime —
 * one per data home that ever injected into it (a different project scope,
 * or a stale one #682 left in a file the current platform/version no longer
 * resolves to). Matching on the marker alone would let one scope's uninstall
 * delete another scope's still-active block just because it also happens to
 * be a teamai block; comparing against this scope's own `env.sh` path scopes
 * the match to blocks this run is actually responsible for.
 *
 * The block is generated by joining paths with the platform separator, so on
 * Windows it carries backslashes. An unquoted `\` is an escape character in a
 * POSIX shell, so the generator rewrites it to `/` before writing — compare
 * against that same rewritten form, not the raw OS path.
 */
export function envBlockSourcesPath(block: string, envShPath: string): boolean {
  const posixPath = toGeneratedForm(envShPath);

  // The generator (generateShellBlock) always wraps the path in single
  // quotes via shellQuoteValue, which escapes an embedded apostrophe as
  // `'\''` — a path like `/home/O'Brien/.teamai/env.sh` never appears as a
  // contiguous raw substring in the block, only in this escaped form.
  if (block.includes(shellQuoteValue(posixPath))) return true;

  // Fall back to a raw/loosely-quoted match for anything not in the
  // generator's own format — e.g. #661's legacy unconverted backslash path,
  // which must still fail this check.
  if (!block.includes(posixPath)) return false;
  if (!/\s/.test(posixPath)) return true;
  return block.includes(`"${posixPath}"`) || block.includes(`'${posixPath}'`);
}

/**
 * Every on-disk spelling of `envShPath` a teamai block — current or legacy —
 * might contain.
 *
 * A CLI predating a given fix wrote the source path differently: the raw
 * OS-native form with unconverted backslashes (pre-#661), or the MSYS/Cygwin
 * drive form (`/d/Users/...`, what Git Bash's own `$PWD` shows) from a
 * locally-built or hand-patched install. Those blocks are broken — a POSIX
 * shell cannot read either form — but they still name this scope's own
 * `env.sh`, and a plain string match against only the current format leaves
 * them permanently invisible to both `doctor` and `uninstall` (#693 review).
 */
function candidateSpellings(envShPath: string): string[] {
  const spellings = new Set<string>([envShPath, toGeneratedForm(envShPath)]);

  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(envShPath);
  if (drive) {
    spellings.add(`/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`);
  }

  return [...spellings];
}

/**
 * Whether a block's `source` line names `envShPath` under any spelling
 * teamai has ever written it in — current or legacy, quoted or not,
 * forward- or back-slashed, drive- or MSYS-form — regardless of whether that
 * spelling actually loads in a shell.
 *
 * This answers a different question than `envBlockSourcesPath`: "does this
 * block belong to this scope" (ownership, for `uninstall` cleanup and for
 * `doctor` flagging a stray leftover) rather than "does this block actually
 * work" (correctness, for `doctor`'s #661 does-it-load check). A genuinely
 * broken legacy block still belongs to this scope and still needs to be
 * found and removed — conflating the two would make `doctor` stop reporting
 * a real #661-style break just because the path happens to match.
 */
export function envBlockReferencesDataHome(block: string, envShPath: string): boolean {
  for (const spelling of candidateSpellings(envShPath)) {
    if (
      block.includes(spelling)
      || block.includes(shellQuoteValue(spelling))
      || block.includes(`"${spelling}"`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `~/name` (never quoted — a shell does not tilde-expand inside any quotes)
 * or `$HOME/name` / `${HOME}/name` (unquoted or double-quoted — a shell
 * does not variable-expand inside single quotes) as a token this scanner
 * accepts as a reference to `name`. `source "~/.bashrc"` and
 * `source '$HOME/.bashrc'` both source a literal, near-certainly
 * nonexistent path, not `name` — a reference that "looks right" but would
 * never actually reach the file must not be trusted (#693 review round 12).
 */
function homeRelativeRef(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = `${escaped}(?![\\w.-])`;
  return `(?:~/${suffix}|\\$\\{?HOME\\}?/${suffix}|"\\$\\{?HOME\\}?/${suffix}")`;
}

/**
 * Whether `line` opens, or closes, a construct whose body either isn't
 * guaranteed to run (`if`/`for`/`while`/`until`/`case`/`select`, a function)
 * or runs in a subshell whose exports never reach the caller even when it
 * always runs (`(...)`, a brace group) — content inside never counts as
 * reaching a candidate, no matter how it looks (#693 review rounds 11-15).
 */
function opensUnverifiedBlock(line: string): boolean {
  return /^(?:if|for|while|until|case|select)\b/.test(line)
    || /^function\s+\S/.test(line)
    || /^\S+\s*\(\)\s*\{?\s*$/.test(line)
    || line === '{'
    || line === '(';
}
function closesUnverifiedBlock(line: string): boolean {
  return /^(?:fi|done|esac)\b/.test(line) || /^\}(?:\s|$)/.test(line) || /^\)(?:\s|$)/.test(line);
}

/**
 * Splits `content` into logical lines: joins a line ending in `\`, or in a
 * dangling `&&`/`||` awaiting its next operand (both are real, unremarkable
 * shell continuation — a trailing binary operator implicitly continues onto
 * the next line with no backslash needed, and treating that next line as an
 * independent, unconditional statement is a real false-"reachable" risk, not
 * an edge case), joins a lone `{` onto the header line it opens, and drops
 * heredoc bodies entirely — their text is data, never executed statements.
 * A `<<<` here-string is not mistaken for a `<<` heredoc, a non-`-` heredoc's
 * terminator is matched literally (only `<<-` strips leading tabs), and a
 * heredoc delimiter may contain `-`/`_` as well as alphanumerics — all three
 * were real detection gaps (#693 review round 15), not narrowed away.
 */
function logicalLines(content: string): string[] {
  const result: string[] = [];
  const rawLines = content.split('\n');
  const heredocQueue: { terminator: string; stripTabs: boolean }[] = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    if (heredocQueue.length > 0) {
      const { terminator, stripTabs } = heredocQueue[0];
      const withoutCR = rawLines[i].replace(/\r$/, '');
      const candidate = stripTabs ? withoutCR.replace(/^\t+/, '') : withoutCR;
      if (candidate === terminator) heredocQueue.shift();
      continue;
    }

    let line = rawLines[i].trim();
    while (i + 1 < rawLines.length && (
      (line.endsWith('\\') && !line.endsWith('\\\\')) || line.endsWith('&&') || line.endsWith('||')
    )) {
      i += 1;
      const next = rawLines[i].trim();
      line = line.endsWith('\\') ? `${line.slice(0, -1).trimEnd()} ${next}`.trim() : `${line} ${next}`.trim();
    }
    if (!line) continue;

    // A self-contained one-liner (`if ...; then ...; fi`, `case ... esac`,
    // `for ...; do ...; done`) opens and closes on the same line — net zero
    // depth change, not an unclosed open that corrupts tracking for every
    // real statement after it (#693 review round 13/15).
    if (/^(?:if|for|while|until|case)\b.*;\s*(?:fi|done|esac)\s*$/.test(line)) continue;

    if (line === '{' && result.length > 0) {
      result[result.length - 1] += ' {';
      continue;
    }

    for (const heredoc of line.matchAll(/(?<!<)<<(-?)(?!<)\s*(['"]?)([\w-]+)\2/g)) {
      heredocQueue.push({ terminator: heredoc[3], stripTabs: heredoc[1] === '-' });
    }

    result.push(line);
  }
  return result;
}

/**
 * Whether `content` runs a `source`/`.` command reaching `name`, restricted
 * to exactly two forms, each matched as a complete logical line with nothing
 * else on it:
 *
 * - **Bare unconditional**: `. REF` / `source REF`, alone.
 * - **Self-referential existence guard**: `test -f REF && . REF` /
 *   `[ -f REF ] && . REF` — the literal line Git for Windows itself
 *   generates.
 *
 * Earlier rounds (#693 review rounds 11-14) grew this into a much larger
 * ad-hoc grammar chasing one adversarial shell construct at a time —
 * `;`/`&&`/`||` statement splitting, quote- and escape-aware tokenizing,
 * N-way `||` fallback chains, trailing arguments and redirections on the
 * source itself. Round 15 correctly called that out as exactly the kind of
 * unbounded, speculative parser this repo's engineering guidance rejects:
 * matching arbitrary shell semantics without a real shell is undecidable in
 * general, and no amount of one-more-regex ever finishes it. Recognizing
 * only these two literal, common, machine-generated-or-standard forms keeps
 * the same safety property — nothing outside them is ever trusted, so the
 * worst outcome is a harmless duplicate block (the pre-#693-fix behavior),
 * never a false "reachable" that would reintroduce #682 — without the
 * unbounded grammar, or the endless stream of parsing bugs that came with
 * it (quoted/escaped separators, pipes, backgrounding, heredoc edge cases).
 *
 * Nothing inside an `if`/`for`/`while`/`until`/`case`/`select`, a function,
 * or a `(...)`/`{...}` group counts (`logicalLines`/`opensUnverifiedBlock`
 * skip it), and nothing textually after an unconditional, top-level
 * `return`/`exit` counts either (tracked below as a single flag — cheap
 * enough to keep without reopening the general-parser question).
 */
async function referencesCandidate(content: string, name: string): Promise<boolean> {
  const ref = homeRelativeRef(name);
  const bareSource = new RegExp(`^(?:\\.|source)\\s+${ref}$`);
  const existenceGuard = new RegExp(
    `^(?:test\\s+-f\\s+${ref}|\\[\\s+-f\\s+${ref}\\s*\\])\\s*&&\\s*(?:\\.|source)\\s+${ref}$`,
  );

  let depth = 0;
  let halted = false;
  for (const line of logicalLines(content)) {
    if (opensUnverifiedBlock(line)) { depth += 1; continue; }
    if (closesUnverifiedBlock(line)) { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;

    if (/^(?:return|exit)(?:\s+\S+)?$/.test(line)) { halted = true; continue; }
    if (halted) continue;

    if (bareSource.test(line) || existenceGuard.test(line)) return true;
  }
  return false;
}

/**
 * Resolve which shell profile file this scope's env block belongs in.
 *
 * Starts from `detectShellProfile`'s order-based pick — the file the current
 * environment actually reads — and searches every file it actually `source`s
 * (transitively, breadth-first, with cycle protection) for one that already
 * carries this scope's block. A candidate the search never reaches is never
 * preferred, regardless of what it contains: earlier versions matched any
 * candidate with a block anywhere (#693 review round 8: a stale pre-#682
 * block in `.bashrc` then outranked a genuinely unwritten, currently-read
 * `.profile`, reintroducing #682 for exactly the installs upgrading through
 * this fix), checked only one hop of sourcing (#693 review round 9:
 * `.bash_profile` sourcing `.profile` sourcing `.bashrc` — the common Debian
 * `.profile` pattern — would miss a block sitting in `.bashrc` two hops away
 * and inject a duplicate into `.bash_profile`), and followed only the first
 * referenced candidate in a fixed priority order rather than every one
 * (#693 review round 10: `.bash_profile` sourcing both `.bashrc` and
 * `.profile`, with the block actually sitting in `.profile`, would commit to
 * the dead-end `.bashrc` branch first — earlier in `SHELL_PROFILE_CANDIDATE_
 * NAMES` — and give up without ever trying `.profile`).
 *
 * The common real case this exists for: Git for Windows'
 * `/etc/profile.d/bash_profile.sh` auto-generates `~/.bash_profile`
 * (`test -f ~/.bashrc && . ~/.bashrc`, a plain file, not a symlink) the
 * first time a login shell starts with `~/.bashrc` present but none of
 * `~/.bash_profile`, `~/.bash_login` or `~/.profile`. `detectShellProfile`
 * then prefers that newly-existing file on the *next* pull; without
 * following the chain it opens, injecting a second block there would leave
 * the still-loading `.bashrc` one reported as a stray leftover, even though
 * nothing ever stopped working.
 */
export async function resolveActiveShellProfile(
  envShPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const home = getUserHome();
  const activePick = await detectShellProfile(platform);

  const visited = new Set<string>();
  const queue: string[] = [activePick];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);

    const content = await readFileSafe(current);
    const block = content ? extractEnvBlock(content) : null;
    if (block && envBlockReferencesDataHome(block, envShPath)) return current;
    if (!content) continue;

    for (const name of SHELL_PROFILE_CANDIDATE_NAMES) {
      const candidate = path.join(home, name);
      if (candidate !== current && !visited.has(candidate) && await referencesCandidate(content, name)) {
        queue.push(candidate);
      }
    }
  }

  return activePick;
}
