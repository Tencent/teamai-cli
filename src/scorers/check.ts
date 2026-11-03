/**
 * What a check is, written in a benchmark task or a scorer, and how it ended, classified once, by `teamai benchmark check`
 * (benchmark/trial.ts), which prints the result as its step's output, and by a scorer's check (scoring-stages.ts). Pure.
 * benchmark/result.ts maps the output its step stored: nothing classifies a check a second time, and no result is read
 * back from a failure code.
 */
import { z } from 'zod';
import { CommitSchema } from '../workflow/clone.js';
import type { CommandExit } from '../workflow/shell-command.js';

/** What a check says about the repo it ran in. */
export type CheckVerdict =
  | { verdict: 'passed' }
  /** It ran to the end and failed: the check's own answer. */
  | { verdict: 'failed'; exitCode: number }
  /** It says nothing about the repo: it could not start, was killed, or ran out of time. */
  | { verdict: 'could_not_run'; cause: 'not_found' | 'not_executable' | 'spawn_failed' | 'signal' | 'timeout'; detail?: string };

/** The `result` a check step outputs: the verdict, without its detail. */
export const CHECK_RESULTS = ['passed', 'failed', 'could_not_run'] as const satisfies ReadonlyArray<CheckVerdict['verdict']>;
export const CheckOutputSchema = z.object({ result: z.enum(CHECK_RESULTS) });

export type CheckResult = (typeof CHECK_RESULTS)[number];

/** Whether `value` is a relative path written segment by segment, so joined to a directory it stays inside it. */
export function isRelativePath(value: string): boolean {
  return !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * A git pathspec relative to the repo; globs allowed (`test/**`). Passed to git as an argv element, never through a shell.
 * Written as git lists paths, segment by segment and with no glob escape, so a protected path is compared with a
 * submodule's as git would.
 */
export const RepoPathSchema = z.string().min(1).refine(
  (value) => !value.startsWith(':') && isRelativePath(value),
  'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment',
);

/**
 * One segment of a glob pathspec as a regular expression, undefined when its `[` class never closes. A class stays a
 * class, `[!a]` as `[^a]`, whose `*` and `?` are literal, and so is a `]` right after `[` or `[!`; a `^` that opens no
 * class is literal, as git reads it.
 */
export function segmentPattern(segment: string): RegExp | undefined {
  const pattern = segment.replace(/\[(!?)(\]?[^\]]*)\]|[*?.+^${}()|\\]/g, (token, negated: string | undefined, members: string | undefined) => {
    if (members !== undefined) return `[${negated ? '^' : ''}${members.replace(/[\\\]]/g, '\\$&')}]`;

    return token === '*' ? '[^/]*' : token === '?' ? '.' : `\\${token}`;
  });

  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return undefined;
  }
}

const ProtectedPathSchema = RepoPathSchema.refine((value) => value.split('/').every((segment) => segmentPattern(segment) !== undefined), 'has a [ class with no closing ]')
  .refine((value) => !/\[:[a-z]+:\]/.test(value), 'has a named class such as [:digit:], which a check cannot read; list its characters, such as [0-9]');

/**
 * What a check runs and the paths it reads that the agent must not supply: a benchmark task's check (#1180), which adds
 * `add`, and a scorer's (#1247). Strict, so a key either does not know is reported.
 */
export const CheckRunSchema = z.object({
  run: z.string().trim().min(1, 'check.run is a command'),
  protect: z.array(ProtectedPathSchema).nonempty('check.protect lists every path the check reads and the agent must not supply')
    .pipe(z.tuple([ProtectedPathSchema], ProtectedPathSchema)),
}).strict();

/**
 * Files a check task's `check.add` writes before each run of its check, as `commit` has them: its `solutionCommit`, or
 * the commit start made of the files it names in the suite directory, as `kind` says.
 */
export const AddedSchema = z.object({ kind: z.enum(['solution', 'suite']), commit: CommitSchema, paths: z.array(z.string().min(1)).nonempty() }).strict();

export type Added = z.infer<typeof AddedSchema>;

const SHELL_SIGNAL_BASE = 128;

/** The highest signal number on Linux, whose real-time signals go up to 64; other POSIX systems stop below it. */
const MAX_SIGNAL = 64;

/**
 * The only check classification. Exit 0 passes. 126 (found, not executable) and 127 (not found) are the POSIX shell's
 * own answers that the command never ran; on win32, cmd.exe answers 9009 for a command it cannot find. A spawn
 * failure, a signal and a timeout could not run either, and so does an exit from 129 to 192 outside win32: that is
 * how a POSIX shell reports a command a signal killed, as 128 plus the signal's number, when it does not exec the
 * command itself. Every other exit is the check's own answer: failed.
 */
export function checkVerdict(exit: CommandExit, platform: NodeJS.Platform): CheckVerdict {
  switch (exit.kind) {
    case 'exited':
      if (exit.code === 0) return { verdict: 'passed' };

      if (exit.code === 127 || (platform === 'win32' && exit.code === 9009)) return { verdict: 'could_not_run', cause: 'not_found' };

      if (exit.code === 126) return { verdict: 'could_not_run', cause: 'not_executable' };

      if (platform !== 'win32' && exit.code > SHELL_SIGNAL_BASE && exit.code <= SHELL_SIGNAL_BASE + MAX_SIGNAL) {
        return { verdict: 'could_not_run', cause: 'signal', detail: `exit ${exit.code}` };
      }

      return { verdict: 'failed', exitCode: exit.code };
    case 'signal':
      return { verdict: 'could_not_run', cause: 'signal', detail: exit.signal };
    case 'timeout':
      return { verdict: 'could_not_run', cause: 'timeout' };
    case 'spawn_failed':
      return { verdict: 'could_not_run', cause: 'spawn_failed', detail: exit.message };
    default: {
      const unhandled: never = exit;

      return unhandled;
    }
  }
}
