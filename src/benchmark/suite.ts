/**
 * Benchmark suites and their tasks, as team files: `benchmarks/<suite>/suite.yaml` and
 * `benchmarks/<suite>/tasks/<task>.yaml`. Each file is parsed once, here, into the domain types below.
 *
 * `syncTeamDefinitions` calls `parseSuite` right after it syncs scorers and workflows, and returns suites as
 * `result.benchmarks` with their diagnostics in `result.invalid`. Nothing after this module validates a suite again.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { isYamlNode, locate } from '../workflow/parse-context.js';
import { durationMs } from '../workflow/parse.js';
import { SetupSchema, type Setup } from '../workflow/requirements.js';
import type { WorkflowDiagnostic } from '../workflow/types.js';
import { CommitSchema, TeamPathSchema } from '../workflow/clone.js';
import { BENCHMARK_NAME, BenchmarkNameSchema, type TrialLimits } from './terms.js';

/** The project the tasks start from. A URL, never a local path or a URL with credentials: it travels in plan and record. */
const RepoUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'ssh:', 'git:'].includes(url.protocol) && url.username === '' && url.password === '';
}, 'must be an https, ssh or git URL without credentials');

/** Whether `value` is a relative path written segment by segment, so joined to a directory it stays inside it. */
function isRelativePath(value: string): boolean {
  return !value.includes('\\') && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * A git pathspec relative to the repo; globs allowed (`test/**`). Passed to git as an argv element, never through a shell.
 * Written as git lists paths, segment by segment and with no glob escape, so a protected path is compared with a
 * submodule's as git would.
 */
const RepoPathSchema = z.string().min(1).refine(
  (value) => !value.startsWith(':') && isRelativePath(value),
  'must be a path relative to the repo, with no backslash and no ".", ".." or empty segment',
);

/** A file or directory of the suite directory, `benchmarks/<suite>/`, read as bytes by the sync. */
const SuitePathSchema = z.string().min(1).refine(isRelativePath, 'must be a path inside the suite directory, with no backslash and no ".", ".." or empty segment');

const TOKENS = 'must be a positive whole number of tokens';
const WHOLE = 'must be a positive whole number';
/** The run's last step waits on every lane, in one expression, which nests at most 100 levels. */
const MAX_LANES = 32;
const LANES = `must be a whole number from 1 to ${MAX_LANES}`;

const DurationSchema = z.string({ error: (issue) => issue.input === undefined ? 'timeout is required: the run\'s timeout, such as 6h' : undefined }).transform((text, ctx): number => {
  const ms = durationMs(text);
  if (ms !== undefined) return ms;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a positive duration, such as 30m or 6h' });
  return z.NEVER;
});

/**
 * The team assets an arm's trials get: the team revision this checkout pulled, none at all, a branch, tag or commit of
 * the team repo that start resolves, or the pulled revision without some of its files and directories, each a path in
 * the team repo, sorted.
 */
export type TeamChoice =
  | { kind: 'pulled' }
  | { kind: 'none' }
  | { kind: 'ref'; ref: string }
  | { kind: 'without'; paths: [string, ...string[]] };

const PULLED: TeamChoice = { kind: 'pulled' };
/** A workflow file's name, as `workflows/<name>.yaml` names it. */
const WorkflowNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be the name of a workflow, as workflows/<name>.yaml names it');
const TEAM_HELP = 'must be pulled, none, a branch, tag or commit of the team repo, or { without: [<path>, ...] }';
/** A ref as git names one, which a plan and a record carry: no leading "-", no "..", "//" or trailing "/" or ".". */
const TEAM_REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![/.])$/;

const TeamValueSchema = z.union([
  z.string().regex(TEAM_REF, TEAM_HELP),
  z.object({
    without: z.array(TeamPathSchema).nonempty('lists the team repo paths the arm runs without, at least one').superRefine((paths, ctx) => {
      const twice = paths.find((one, index) => paths.indexOf(one) !== index);
      if (twice !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lists ${twice} twice; list each path once` });
      const [nested] = paths.flatMap((inner) => paths.filter((outer) => inner.startsWith(`${outer}/`)).map((outer) => ({ inner, outer })));
      if (nested !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lists ${nested.inner}, which is inside ${nested.outer}; list only ${nested.outer}` });
    }),
  }).strict(),
]).transform((value): TeamChoice => {
  if (typeof value !== 'string') {
    const [first, ...rest] = [...value.without].sort();
    return { kind: 'without', paths: [first, ...rest] };
  }
  if (value === 'pulled') return PULLED;
  return value === 'none' ? { kind: 'none' } : { kind: 'ref', ref: value };
});

/**
 * The keys a suite's `defaults` sets and an arm or the matrix may change. Arm validation reads the key list from this
 * schema, so a new key is added here and in `MatrixSchema`. Not a workflow's `defaults`.
 */
const ArmValuesSchema = z.object({
  tool: z.string().min(1),
  /** A model alias from models/aliases.yaml, or a model name. An alias resolves per tool; a name does not. */
  model: z.string().min(1).optional(),
  /** Absent: the team revision this checkout pulled. */
  team: TeamValueSchema.optional(),
  /** A team workflow each trial runs on the task, as its input `task`, instead of one prompt. Absent: one prompt. */
  workflow: WorkflowNameSchema.optional(),
}).strict();
export type ArmValues = z.infer<typeof ArmValuesSchema>;
type ArmKey = keyof ArmValues;
const ARM_KEYS = ArmValuesSchema.keyof().options;

const ArmFileSchema = ArmValuesSchema.partial().extend({ name: BenchmarkNameSchema }).strict();

/** Every value of each key crossed with every value of the others, one arm each: what the page compares one key over. */
const MatrixSchema = z.object({
  tool: z.array(z.string().min(1)).nonempty().optional(),
  model: z.array(z.string().min(1)).nonempty().optional(),
  team: z.array(TeamValueSchema).nonempty().optional(),
  workflow: z.array(WorkflowNameSchema).nonempty().optional(),
}).strict() satisfies z.ZodType<Partial<Record<ArmKey, unknown>>>;
type Matrix = z.infer<typeof MatrixSchema>;
const MAX_MATRIX_ARMS = 12;

const SuiteFileSchema = z.object({
  schemaVersion: z.literal('v1alpha1'),
  name: BenchmarkNameSchema,
  description: z.string().optional(),
  repo: RepoUrlSchema,
  defaults: ArmValuesSchema,
  arms: z.array(ArmFileSchema).nonempty('a suite has 1 to 6 arms').max(6, 'a suite has 1 to 6 arms').optional(),
  matrix: MatrixSchema.optional(),
  repetitions: z.number().int().min(1).max(10).default(3),
  /** The lanes the baselines and trials run in, one at a time each. */
  parallel: z.number().int(LANES).min(1, LANES).max(MAX_LANES, LANES).default(1),
  /** Required: the run's timeout. */
  timeout: DurationSchema,
  /** The limits of every trial's prompt. */
  trial: z.object({
    timeout: DurationSchema.optional(),
    budget: z.object({ tokens: z.number().int(TOKENS).positive(TOKENS) }).strict().optional(),
    max_turns: z.number().int(WHOLE).positive(WHOLE).optional(),
  }).strict().transform((trial): TrialLimits => ({
    ...(trial.timeout !== undefined ? { timeoutMs: trial.timeout } : {}),
    ...(trial.budget ? { tokens: trial.budget.tokens } : {}),
    ...(trial.max_turns !== undefined ? { maxTurns: trial.max_turns } : {}),
  })).optional(),
  setup: SetupSchema.optional(),
  scorers: z.array(z.string().min(1)).default([]),
}).strict().superRefine((suite, ctx) => {
  if (suite.trial?.timeoutMs !== undefined && suite.trial.timeoutMs >= suite.timeout) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trial', 'timeout'], message: 'trial.timeout must be shorter than timeout, which bounds the whole run' });
  }
  if ((suite.arms === undefined) === (suite.matrix === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'a suite has exactly one of arms and matrix' });
    return;
  }
  if (suite.matrix) {
    const problem = matrixProblem(suite.defaults, suite.matrix);
    if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matrix'], message: problem });
    return;
  }
  const seen = new Set<string>();
  let unchanged: string | undefined;
  suite.arms?.forEach((arm, index) => {
    if (seen.has(arm.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index, 'name'], message: `arm "${arm.name}" is named twice; arm names are unique` });
    }
    seen.add(arm.name);
    const changed = changedKeys(suite.defaults, arm);
    if (changed.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index], message: `arm "${arm.name}" changes ${changed.join(' and ')}; an arm changes at most one of the defaults keys` });
    } else if (changed.length === 0 && unchanged !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['arms', index], message: `arm "${arm.name}" changes none of the defaults keys, and neither does arm "${unchanged}"; at most one arm changes none` });
    } else if (changed.length === 0) {
      unchanged = arm.name;
    }
  });
});

/** The defaults keys `arm` sets to a value other than the defaults'. An absent team is the pulled revision. */
function changedKeys(defaults: ArmValues, arm: Partial<ArmValues>): ArmKey[] {
  const resolved = { ...defaults, team: defaults.team ?? PULLED };
  return ARM_KEYS.filter((key) => arm[key] !== undefined && JSON.stringify(arm[key]) !== JSON.stringify(resolved[key]));
}

/** The arms `matrix` crosses over `defaults`, tool outermost, each named after the values of the keys it varies. */
function matrixArms(defaults: ArmValues, matrix: Matrix): Arm[] {
  const tools = matrix.tool ?? [defaults.tool];
  const models = matrix.model ?? [defaults.model];
  const teams = matrix.team ?? [defaults.team ?? PULLED];
  const workflows = matrix.workflow ?? [defaults.workflow];
  return tools.flatMap((tool) => models.flatMap((model) => teams.flatMap((team) => workflows.map((workflow): Arm => {
    const segments = [
      ...(tools.length > 1 ? [tool] : []),
      ...(models.length > 1 && model !== undefined ? [model] : []),
      ...(teams.length > 1 ? [teamSegment(team)] : []),
      ...(workflows.length > 1 && workflow !== undefined ? [workflow] : []),
    ];
    return { name: segments.map(nameSegment).join('-'), tool, ...(model !== undefined ? { model } : {}), team, ...(workflow !== undefined ? { workflow } : {}) };
  }))));
}

function teamSegment(team: TeamChoice): string {
  switch (team.kind) {
    case 'pulled':
    case 'none':
      return team.kind;
    case 'ref':
      return team.ref;
    case 'without':
      return ['without', ...team.paths].join('-');
    default: {
      const unhandled: never = team;
      return unhandled;
    }
  }
}

function nameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** Why `matrix` makes no usable set of arms, or undefined when it does. */
function matrixProblem(defaults: ArmValues, matrix: Matrix): string | undefined {
  if (!ARM_KEYS.some((key) => (matrix[key]?.length ?? 0) > 1)) return 'the matrix varies no key; list two values or more under tool, model, team or workflow';
  const arms = matrixArms(defaults, matrix);
  if (arms.length > MAX_MATRIX_ARMS) return `the matrix makes ${arms.length} arms; a suite has 1 to ${MAX_MATRIX_ARMS}`;
  const names = new Set<string>();
  for (const { name } of arms) {
    if (!BENCHMARK_NAME.test(name)) return `the matrix names an arm "${name}", which must be letters, digits, "-" or "_"; list values that start with a letter or digit`;
    if (names.has(name)) return `the matrix names two arms "${name}"; list values whose names differ`;
    names.add(name);
  }
  return undefined;
}

/**
 * One segment of a glob pathspec as a regular expression, undefined when its `[` class never closes. A class stays a
 * class, `[!a]` as `[^a]`, whose `*` and `?` are literal; a `^` that opens no class is literal, as git reads it.
 */
function segmentPattern(segment: string): RegExp | undefined {
  const pattern = segment.replace(/\[(!?)([^\]]*)\]|[*?.+^${}()|\\]/g, (token, negated: string | undefined, members: string | undefined) => {
    if (members !== undefined) return `[${negated ? '^' : ''}${members.replace(/\\/g, '\\\\')}]`;
    return token === '*' ? '[^/]*' : token === '?' ? '.' : `\\${token}`;
  });
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return undefined;
  }
}

const AddedPathSchema = RepoPathSchema.refine((value) => !/[*?[]/.test(value), 'must name one file, without glob characters');

const ProtectedPathSchema = RepoPathSchema.refine((value) => value.split('/').every((segment) => segmentPattern(segment) !== undefined), 'has a [ class with no closing ]')
  .refine((value) => !/\[:[a-z]+:\]/.test(value), 'has a named class such as [:digit:], which a check cannot read; list its characters, such as [0-9]');

const CheckFileSchema = z.object({
  run: z.string().trim().min(1, 'check.run is a command'),
  protect: z.array(ProtectedPathSchema).nonempty('check.protect lists every path the check reads and the agent must not supply')
    .pipe(z.tuple([ProtectedPathSchema], ProtectedPathSchema)),
  /**
   * Files written before the check whether or not the starting commit has them, so the agent never sees them: a path of
   * `source.fix`, such as its test, or `{ from, to }`, a file or directory of the suite directory written at `to`.
   */
  add: z.array(z.union([AddedPathSchema, z.object({ from: SuitePathSchema, to: AddedPathSchema }).strict()], {
    error: 'must be a path of source.fix, or { from, to }: a file or directory of the suite directory, and where the check reads it',
  })).nonempty().optional(),
}).strict();

/**
 * Whether glob pathspec `spec` names `file`, as git matches `:(glob)` pathspecs: `*` and `?` within one segment, a
 * `**` segment for any number of them, and a spec that names a directory for everything under it.
 */
function pathspecMatches(spec: readonly string[], file: readonly string[]): boolean {
  const [head, ...rest] = spec;
  if (head === undefined) return true;
  if (head === '**') return rest.length === 0 || file.some((_, at) => pathspecMatches(rest, file.slice(at)));
  const [name, ...below] = file;
  if (name === undefined) return false;
  return segmentPattern(head)?.test(name) === true && pathspecMatches(rest, below);
}

/**
 * A task file, in a suite whose directory holds `files`, keyed by their path in it. A `{ from, to }` entry of check.add
 * names one of them, or a directory of them, whose files it writes under `to`.
 */
function taskFileSchema(files: ReadonlyMap<string, SuiteFile>) {
  return z.object({
    schemaVersion: z.literal('v1alpha1'),
    title: z.string().min(1),
    prompt: z.string().min(1),
    startingCommit: CommitSchema,
    check: CheckFileSchema.optional(),
    successCriteria: z.string().trim().min(1).optional(),
    /** The session the task came from, and the commit that fixed it there, which `--try` checks the check passes at. */
    source: z.object({ platform: z.string().min(1), sessionId: z.string().min(1), fix: CommitSchema.optional() }).strict().optional(),
  }).strict().transform(({ check, successCriteria, ...task }, ctx) => {
    if (successCriteria !== undefined && !check) return { ...task, judge: { kind: 'criteria', successCriteria } satisfies TaskJudge };
    if (!check || successCriteria !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['check'], message: 'a task has exactly one of check and successCriteria' });
      return z.NEVER;
    }
    const { add = [], ...rest } = check;
    const [firstFixed, ...otherFixed] = add.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
    const fix = task.source?.fix;
    if (firstFixed !== undefined && fix === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['check', 'add'], message: 'check.add writes its files from source.fix; add source.fix, the full commit that brought them' });
      return z.NEVER;
    }
    const issues: Array<{ path: Array<string | number>; message: string }> = [];
    // Each path check.add writes, with the entry and field a diagnostic names, and for a `{ from, to }` entry its bytes.
    const written = add.flatMap((entry, index): Array<{ at: Array<string | number>; path: string; file?: CheckFile }> => {
      if (typeof entry === 'string') return [{ at: ['check', 'add', index], path: entry }];
      const copied = filesAt(files, entry);
      if (copied.length === 0) issues.push({ path: ['check', 'add', index, 'from'], message: `"${entry.from}" is no file or directory of the suite directory; a symlink is not one` });
      return copied.map((file) => ({ at: ['check', 'add', index, 'to'], path: file.path, file }));
    });
    const seen = new Set<string>();
    // Each directory of a path written so far, with the first path written under it.
    const under = new Map<string, string>();
    for (const { at, path: target } of written) {
      const parts = target.split('/');
      const directories = parts.slice(1).map((_, end) => parts.slice(0, end + 1).join('/'));
      if (!rest.protect.some((spec) => pathspecMatches(spec.split('/'), target.split('/')))) {
        issues.push({ path: at, message: `check.add "${target}" is not under check.protect, so the agent could supply it; add a protect path that covers it` });
      } else if (seen.has(target)) {
        issues.push({ path: at, message: `check.add writes "${target}" twice; write each path once` });
      } else {
        // git keeps one of a file and a directory of the same name, and drops the other without an error.
        const outer = directories.find((directory) => seen.has(directory));
        const inner = under.get(target);
        const [file, nested] = outer !== undefined ? [outer, target] : [target, inner];
        if (outer !== undefined || inner !== undefined) {
          issues.push({ path: at, message: `check.add writes "${file}" as a file and as the directory of "${nested}"; write paths that do not nest` });
        }
      }
      seen.add(target);
      for (const directory of directories) if (!under.has(directory)) under.set(directory, target);
    }
    if (issues.length > 0) {
      for (const issue of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
      return z.NEVER;
    }
    const [firstFile, ...otherFiles] = written.flatMap(({ file }) => (file ? [file] : []));
    return {
      ...task,
      judge: {
        kind: 'check', ...rest,
        ...(firstFixed !== undefined && fix !== undefined ? { add: { commit: fix, paths: [firstFixed, ...otherFixed] } } : {}),
        ...(firstFile ? { files: [firstFile, ...otherFiles] } : {}),
      } satisfies TaskJudge,
    };
  });
}

/**
 * The files a `{ from, to }` entry writes: `from` itself at `to`, or each file under `from` below `to`, in path order,
 * but those under a dot entry, as the sync reads them.
 */
function filesAt(files: ReadonlyMap<string, SuiteFile>, { from, to }: { from: string; to: string }): CheckFile[] {
  const own = files.get(from);
  if (own) return [{ path: to, mode: own.mode, base64: own.base64 }];
  return [...files].flatMap(([at, file]) => {
    const below = at.startsWith(`${from}/`) ? at.slice(from.length + 1) : undefined;
    return below !== undefined && !below.split('/').some((name) => name.startsWith('.')) ? [{ below, file }] : [];
  }).sort((left, right) => (left.below < right.below ? -1 : 1))
    .map(({ below, file }) => ({ path: `${to}/${below}`, mode: file.mode, base64: file.base64 }));
}

/** A file check.add writes from the suite directory: its path in the clone, its git file mode, and its bytes. */
export interface CheckFile {
  path: string;
  mode: FileMode;
  base64: string;
}

/** How git stores a file: executable or not. */
export type FileMode = '100644' | '100755';

/** How a task is decided. Exactly one, by construction: the file rule above becomes a union here. */
export type TaskJudge =
  /** `add`: the files written from `commit`, the task's fix, before the check. `files`: those written from the suite directory. */
  | { kind: 'check'; run: string; protect: [string, ...string[]]; add?: { commit: string; paths: [string, ...string[]] }; files?: [CheckFile, ...CheckFile[]] }
  | { kind: 'criteria'; successCriteria: string };

export interface Task {
  /** The file name without `.yaml`. Trials are ordered by it. */
  id: string;
  /** Team-repo-relative path, such as `benchmarks/auth/tasks/expired-token.yaml`. */
  relativePath: string;
  title: string;
  prompt: string;
  startingCommit: string;
  judge: TaskJudge;
  source?: { platform: string; sessionId: string; fix?: string };
  /** sha256 of the file bytes. */
  sourceHash: string;
}

/** An arm with the defaults applied. */
export interface Arm {
  name: string;
  tool: string;
  model?: string;
  team: TeamChoice;
  /** The team workflow its trials run on each task; absent: one prompt. */
  workflow?: string;
}

export interface Suite {
  name: string;
  relativePath: string;
  description?: string;
  repo: string;
  defaults: ArmValues;
  arms: [Arm, ...Arm[]];
  repetitions: number;
  /** The lanes the baselines and trials run in; 1 runs one at a time. */
  parallel: number;
  timeoutMs: number;
  /** Absent: no trial has a limit of its own. */
  trial?: TrialLimits;
  setup?: Setup;
  scorers: string[];
  /** The valid tasks, in file-name order. Never empty. */
  tasks: [Task, ...Task[]];
  sourceHash: string;
}

/** One team file as the sync read it. */
export interface SourceFile {
  relativePath: string;
  content: string;
}

/** A file of a suite directory that a check.add entry names, as the sync read it: bytes, not text. */
export interface SuiteFile {
  relativePath: string;
  base64: string;
  mode: FileMode;
}

export type SuiteParse =
  /** `diagnostics` holds the invalid task files; the suite runs without those tasks. `warnings` fail nothing. */
  | { ok: true; suite: Suite; diagnostics: WorkflowDiagnostic[]; warnings: WorkflowDiagnostic[] }
  | { ok: false; diagnostics: [WorkflowDiagnostic, ...WorkflowDiagnostic[]] };

/**
 * Parses one suite directory. Diagnostics read `file:line: field "...": message` like workflows, with the line of the
 * YAML node a zod issue's path names. `isAlias` says whether a model value is a team alias under the sync's selection:
 * a model name in `defaults.model` while an arm changes the tool is a warning, since a name does not resolve per tool.
 * Without it, nothing is checked against aliases. `files` are the files of the suite directory its tasks' check.add
 * entries name.
 */
export function parseSuite(input: { suite: SourceFile; tasks: readonly SourceFile[]; files?: readonly SuiteFile[]; isAlias?: (model: string) => boolean }): SuiteParse {
  const parsed = parseFile(input.suite, SuiteFileSchema);
  if (!parsed.ok) return parsed;
  const { value: file, document, lineCounter } = parsed;
  const suiteDir = path.posix.dirname(input.suite.relativePath);
  const directory = path.posix.basename(suiteDir);
  if (file.name !== directory) {
    return { ok: false, diagnostics: [diagnosticAt(input.suite.relativePath, lineCounter, document, ['name'], `suite "${file.name}" must be named after its directory, "${directory}"`)] };
  }
  const TaskFileSchema = taskFileSchema(new Map((input.files ?? []).flatMap((suiteFile) => (
    suiteFile.relativePath.startsWith(`${suiteDir}/`) ? [[suiteFile.relativePath.slice(suiteDir.length + 1), suiteFile] as const] : []
  ))));
  const diagnostics: WorkflowDiagnostic[] = [];
  const tasks: Task[] = [];
  for (const source of [...input.tasks].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const id = path.posix.basename(source.relativePath, '.yaml');
    if (!BENCHMARK_NAME.test(id)) {
      diagnostics.push({ file: source.relativePath, line: 1, column: 1, field: '(file)', message: 'a task file name must be letters, digits, "-" or "_", with no "."' });
      continue;
    }
    const task = parseFile(source, TaskFileSchema);
    if (!task.ok) {
      diagnostics.push(...task.diagnostics);
      continue;
    }
    const { title, prompt, startingCommit, judge, source: origin } = task.value;
    tasks.push({ id, relativePath: source.relativePath, title, prompt, startingCommit, judge, ...(origin ? { source: origin } : {}), sourceHash: taskHash(source.content, judge) });
  }
  const [first, ...rest] = tasks;
  if (!first) {
    return { ok: false, diagnostics: [{ file: input.suite.relativePath, line: 1, column: 1, field: 'tasks', message: `suite ${file.name} has no valid task` }, ...diagnostics] };
  }
  const arm = ({ name, ...values }: z.infer<typeof ArmFileSchema>): Arm => ({ name, ...file.defaults, ...values, team: values.team ?? file.defaults.team ?? PULLED });
  const arms = file.matrix ? matrixArms(file.defaults, file.matrix) : (file.arms ?? []).map(arm);
  const [firstArm, ...otherArms] = arms;
  if (!firstArm) return { ok: false, diagnostics: [{ file: input.suite.relativePath, line: 1, column: 1, field: 'arms', message: 'a suite has 1 to 6 arms' }] };
  const toolArm = file.arms?.find((candidate) => changedKeys(file.defaults, candidate).includes('tool'));
  const variesTool = toolArm ? `arm "${toolArm.name}" changes the tool` : (file.matrix?.tool?.length ?? 0) > 1 ? 'the matrix varies the tool' : undefined;
  const isUnaliasedAcrossTools = (model: string): boolean => variesTool !== undefined && input.isAlias !== undefined && !input.isAlias(model);
  const nameWarning = (at: Array<string | number>, field: string, model: string): WorkflowDiagnostic => diagnosticAt(input.suite.relativePath, lineCounter, document, at, `${field} "${model}" is a model name, not an alias in models/aliases.yaml, and ${variesTool}; use an alias that names a model for each tool`);
  const warnings = [
    ...(file.defaults.model !== undefined && isUnaliasedAcrossTools(file.defaults.model) ? [nameWarning(['defaults', 'model'], 'defaults.model', file.defaults.model)] : []),
    ...(file.matrix?.model ?? []).flatMap((model, index) => (isUnaliasedAcrossTools(model) ? [nameWarning(['matrix', 'model', index], `matrix.model.${index}`, model)] : [])),
  ];
  return {
    ok: true,
    suite: {
      name: file.name,
      relativePath: input.suite.relativePath,
      ...(file.description !== undefined ? { description: file.description } : {}),
      repo: file.repo,
      defaults: file.defaults,
      arms: [firstArm, ...otherArms],
      repetitions: file.repetitions,
      parallel: file.parallel,
      timeoutMs: file.timeout,
      ...(file.trial ? { trial: file.trial } : {}),
      ...(file.setup ? { setup: file.setup } : {}),
      scorers: file.scorers,
      tasks: [first, ...rest],
      sourceHash: hashOf(input.suite.content),
    },
    diagnostics,
    warnings,
  };
}

/** The arm that changes no defaults key, against which the others are read; absent when every arm changes one. */
export function defaultsArmOf({ defaults, arms }: Pick<Suite, 'defaults' | 'arms'>): Arm | undefined {
  return arms.find((arm) => changedKeys(defaults, arm).length === 0);
}

/**
 * The paths in the suite directory that `tasks`' check.add entries name as `from`, for the sync to read before
 * `parseSuite`. Only paths that stay inside the directory: `parseSuite` reports the others.
 */
export function checkFilesNamed(tasks: readonly SourceFile[]): string[] {
  const named = tasks.flatMap(({ content }) => {
    const document = parseDocument(content, { uniqueKeys: true });
    const add = z.object({ check: z.object({ add: z.array(z.unknown()) }) }).safeParse(document.errors.length > 0 ? undefined : document.toJS()).data?.check.add ?? [];
    return add.flatMap((entry) => z.object({ from: SuitePathSchema }).safeParse(entry).data?.from ?? []);
  });
  return [...new Set(named)];
}

type FileParse<T> =
  | { ok: true; value: T; document: ReturnType<typeof parseDocument>; lineCounter: LineCounter }
  | { ok: false; diagnostics: [WorkflowDiagnostic, ...WorkflowDiagnostic[]] };

function parseFile<T>({ relativePath, content }: SourceFile, schema: z.ZodType<T>): FileParse<T> {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter, uniqueKeys: true });
  const errors = document.errors.map((error): WorkflowDiagnostic => {
    const position = lineCounter.linePos(error.pos[0]);
    return { file: relativePath, line: position.line, column: position.col, field: '(document)', message: error.message };
  });
  const value: unknown = errors.length > 0 ? undefined : document.toJS();
  const result = errors.length > 0 ? undefined : schema.safeParse(value);
  if (result?.success) return { ok: true, value: result.data, document, lineCounter };
  const diagnostics = result ? result.error.issues.map((issue) => diagnosticAt(relativePath, lineCounter, document, issue.path.filter((part) => typeof part !== 'symbol'), issue.message)) : errors;
  const [first, ...rest] = diagnostics;
  return { ok: false, diagnostics: [first ?? { file: relativePath, line: 1, column: 1, field: '(root)', message: 'file is empty' }, ...rest] };
}

function diagnosticAt(file: string, lineCounter: LineCounter, document: ReturnType<typeof parseDocument>, at: ReadonlyArray<string | number>, message: string): WorkflowDiagnostic {
  const node: unknown = at.length > 0 ? document.getIn(at, true) : document.contents;
  return locate(file, lineCounter, isYamlNode(node) ? node : undefined, at.join('.') || '(root)', message);
}

function hashOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A task's `sourceHash`: the hash of its file, or with check files, of that hash and each file's path, mode and bytes
 * hash in order, so editing one changes it. A task without them keeps the hash of its file alone.
 */
function taskHash(content: string, judge: TaskJudge): string {
  const files = judge.kind === 'check' ? judge.files ?? [] : [];
  if (files.length === 0) return hashOf(content);
  return hashOf(JSON.stringify([hashOf(content), ...files.map((file) => [file.path, file.mode, hashOf(Buffer.from(file.base64, 'base64'))])]));
}
