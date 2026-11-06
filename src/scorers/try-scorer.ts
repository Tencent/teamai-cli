/**
 * Trying a scorer file before it is pushed: `teamai score --session <id> --scorer ./draft.md` starts the default workflow
 * teamai-try-scorer, which runs teamai-score on the session and on its control with `files` and `store: false`. A tried
 * label is never stored; the report sets it beside the labels the scope keeps of its scorer and the control's verdict.
 */
import path from 'node:path';
import { z } from 'zod';
import type { SessionDemand } from '../session-flow/scoring.js';
import { CONFINED_TOOLS } from '../tool-launch/tools.js';
import { installedConfinedTools } from '../tool-launch/confined.js';
import { type JsonObject, JsonObjectSchema, type LocalConfig } from '../types.js';
import { readFileSafe } from '../utils/fs.js';
import { NOT_A_SCORER, scorerSourceHash } from './cache.js';
import { formatScorerDiagnostic, parseScorer, type ScorerDefinition } from './definition.js';
import { EvidenceDir, type GroupRecord } from './evidence-dir.js';
import type { ScoreLabel, SessionLabelContext, SessionSubject } from './label.js';
import { LabelStore } from './label-store.js';
import { NamedSubject } from './named-subject.js';
import type { PinnedScorer } from './pin.js';
import { ScoreLabels, type LabelEntry } from './score-labels.js';
import { Subject } from './subject.js';

type Refusal = { ok: false; code: string; message: string };

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** A scorer file read as `teamai pull` reads it, with its path relative to the current directory, or absolute outside it. */
export interface TriedFile {
  scorer: string;
  file: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** The scorer file `value` names, relative to the current directory, read and parsed as `teamai pull` parses it. */
async function fileOf(value: string): Promise<TriedFile | Refusal> {
  const full = path.resolve(value);
  const relative = path.relative(process.cwd(), full);
  const file = relative.startsWith('..') || path.isAbsolute(relative) ? full : relative.split(path.sep).join('/');

  if (!file.endsWith('.md') || path.posix.basename(file) === 'README.md') return refused('scorer_invalid', formatScorerDiagnostic({ file, message: NOT_A_SCORER }));
  const content = await readFileSafe(full);

  if (content === null) return refused('scorer_not_found', formatScorerDiagnostic({ file, message: 'could not be read' }));
  const parsed = parseScorer(file, content);

  if (!parsed.ok) return refused('scorer_invalid', parsed.diagnostics.map(formatScorerDiagnostic).join('\n'));

  return { scorer: parsed.definition.name, file, definition: parsed.definition, pin: { sourceHash: scorerSourceHash(content), relativePath: file, content } };
}

/** The scorer files `values` name, read once each, or why they cannot be tried together. */
async function files(values: readonly string[]): Promise<{ ok: true; files: TriedFile[] } | Refusal> {
  const read: TriedFile[] = [];

  for (const value of new Set(values)) {
    const one = await fileOf(value);

    if ('ok' in one) return one;
    const twin = read.find((other) => other.scorer === one.scorer);

    if (twin) return refused('invalid_arguments', `--scorer ${twin.file} and --scorer ${one.file} are both scorer ${one.scorer}. Judge them in separate commands.`);
    read.push(one);
  }

  return { ok: true, files: read };
}

/** What a teamai-try-scorer run takes. */
export interface TryInputs {
  subject: string;
  files: string[];
  batch: boolean;
}

/**
 * The teamai-try-scorer run `demand` asks for, in the scope the session ran in, or why none can start: a file teamai pull
 * would not take, a session that cannot be named, or no tool here that judges confined. Says which session it is first.
 */
async function prepare(from: LocalConfig, demand: SessionDemand): Promise<{ ok: true; config: LocalConfig; subject: Subject; inputs: TryInputs } | Refusal> {
  const read = await files(demand.scorers);

  if (!read.ok) return read;
  const named = await NamedSubject.ofSession(from, demand);

  if (!named.ok) return named;

  if (installedConfinedTools([]).length === 0) {
    return refused('judge_tool_unavailable', `No installed tool can run a scorer judge with every tool turned off. Install one teamai runs confined: ${CONFINED_TOOLS.join(', ')}.`);
  }

  return { ok: true, config: named.config, subject: named.subject, inputs: { subject: Subject.format(named.subject), files: read.files.map(({ file }) => path.resolve(file)), batch: demand.batch === true } };
}

/** Why a rubric that passes the control may not judge the work. Printed, never a failure: a rubric may judge the prompt by design. */
const CONTROL_WARNING = 'This rubric passes a session where the agent did nothing, so it may not judge the work.';

/** The control's verdict on a scorer file, or why it has none. */
type ControlOutcome = { label: string; score: number; passed: boolean; warning?: string } | { error: { code: string; message: string } };

/** One scorer file tried: its verdict on the session, as a label of it would hold it, and never stored. */
type TriedAnswer = {
  scorer: string;
  file: string;
  subject: SessionSubject;
  rubric: { sourceHash: string };
  label: string;
  score: number;
  passed: boolean;
  reasoning: string;
  stored: false;
  /** The team skills the session used, when it used any. */
  used?: SessionLabelContext['used'];
};

/** A group a teamai-score instance judged, as its evidence directory keeps it, with an entry per scorer. */
interface Judged {
  group: GroupRecord;
  entries: LabelEntry[];
}

/** The items of a teamai-score instance's `labels` output; an item whose evidence was never written gives no directory. */
const ItemsSchema = z.array(z.object({ outputs: z.object({ evidence: z.string().nullish() }).nullish() }));

/** The groups an instance's `labels` output names, each read from its directory inside `runDir`; or why one cannot be read. */
async function judgedIn(runDir: string, text: string | undefined, which: string): Promise<{ ok: true; judged: Judged[] } | Refusal> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text === undefined || text === '' ? '[]' : text);
  } catch {
    return refused('invalid_arguments', `--${which} is not the JSON a teamai-score step's labels output renders.`);
  }

  const items = ItemsSchema.safeParse(parsed);

  if (!items.success) return refused('invalid_arguments', `--${which} is not the JSON a teamai-score step's labels output renders.`);
  const judged: Judged[] = [];

  for (const { outputs } of items.data) {
    const dir = outputs?.evidence;

    if (!dir) return refused('evidence_empty', 'The evidence of the session was not written, so no judge ran. Run the command again; if it fails the same way, the session holds nothing to judge.');

    if (path.dirname(path.resolve(dir)) !== path.resolve(runDir)) return refused('invalid_arguments', `${dir} is not a directory of this run.`);
    const group = await EvidenceDir.read(dir);

    if (!group.ok) return group;
    judged.push({ group: group.group, entries: await ScoreLabels.read(dir) ?? [] });
  }

  return { ok: true, judged };
}

/** The newest label this scope keeps of `scorer` on `subject` for each rubric and judge kind, newest first. */
function storedOf(labels: readonly ScoreLabel[], scorer: string, subject: SessionSubject) {
  return labels
    .filter((label) => label.source === 'session' && label.scorer === scorer && label.subject.platform === subject.platform && label.subject.sessionId === subject.sessionId)
    .sort((left, right) => (left.scoredAt < right.scoredAt ? 1 : left.scoredAt > right.scoredAt ? -1 : 0))
    .map(({ rubric, label, score, passed, judge }) => ({ rubric, label, score, passed, judge: judge.kind === 'model' ? { kind: judge.kind, tool: judge.tool } : { kind: judge.kind } }));
}

/** What the control's groups gave `scorer`. */
function controlOf(control: readonly Judged[], scorer: string): ControlOutcome {
  const entry = control.flatMap(({ entries }) => entries).find((each) => each.scorer === scorer);

  if (!entry) return { error: { code: 'judge_failed', message: 'The judge gave the control no label.' } };

  if (entry.kind === 'failed') return { error: { code: entry.code, message: entry.message } };
  const outcome = { label: entry.label.label, score: entry.label.score, passed: entry.label.passed };

  return outcome.passed ? { ...outcome, warning: CONTROL_WARNING } : outcome;
}

type Tried = { answer: TriedAnswer; stored: ReturnType<typeof storedOf>; control: ControlOutcome };

/** An answer as the step's output prints it: optional fields left out are dropped. */
const PrintedSchema = z.preprocess((answer) => JSON.parse(JSON.stringify(answer)), JsonObjectSchema);

/** The command's answer: one file's label, stored labels and control, or each of them by scorer. */
function triedEnvelope(tried: readonly Tried[]): JsonObject {
  const [only, ...more] = tried;

  if (only && more.length === 0) return PrintedSchema.parse({ data: { label: only.answer, stored: only.stored, control: only.control } });

  return PrintedSchema.parse({ data: {
    labels: tried.map(({ answer }) => answer),
    stored: Object.fromEntries(tried.map(({ answer, stored }) => [answer.scorer, stored])),
    control: Object.fromEntries(tried.map(({ answer, control }) => [answer.scorer, control])),
  } });
}

/** The lines a person reads per scorer file: its verdict, which is never stored, and what the control says of it, a warning when the rubric passes the control. */
function linesOf({ answer, control }: Tried) {
  const verdict = `${answer.scorer} from ${answer.file}: ${answer.label} (score ${answer.score}, ${answer.passed ? 'passed' : 'did not pass'}). Not stored: a scorer file's label is only tried.`;

  if ('error' in control) return { text: [verdict, `${answer.scorer}: the control could not be judged: ${control.error.message}`], warnings: [] };

  if (control.warning !== undefined) return { text: [verdict], warnings: [`${answer.scorer}: ${control.warning}`] };

  return { text: [verdict, `${answer.scorer}: the control, the session's first prompt alone, does not pass (${control.label}, score ${control.score}).`], warnings: [] };
}

/**
 * The report of a teamai-try-scorer run: each scorer file's label on the session, which nothing stored, beside the labels
 * the scope keeps of its scorer and the control's verdict on the session's first prompt alone. `labels` and `control`
 * are the `labels` outputs of its two teamai-score steps. Answers the envelope `teamai score` prints, and its text.
 */
async function report({ config, runDir, labels, control }: { config: LocalConfig; runDir: string; labels?: string; control?: string }): Promise<{ ok: true; answer: JsonObject; text: string; warnings: string } | Refusal> {
  const [session, controlled] = await Promise.all([judgedIn(runDir, labels, 'labels'), judgedIn(runDir, control, 'control')]);

  if (!session.ok) return session;
  const stored = await LabelStore.local(config);
  const tried: Tried[] = [];

  for (const { group, entries } of session.judged) {
    if (group.judged.kind !== 'session') return refused('invalid_arguments', `${group.subject} is not a session, and only a session is tried.`);
    const { subject, context } = group.judged;

    for (const [index, { name, pin }] of group.scorers.entries()) {
      const entry = entries[index];

      if (entry?.kind !== 'labelled') {
        const why = entry ?? { code: 'judge_failed', message: 'The judge gave the session no label.' };

        return { ok: true, answer: { error: { code: why.code, message: why.message } }, text: '', warnings: '' };
      }

      const answer: TriedAnswer = {
        scorer: name, file: pin.relativePath ?? name, subject, rubric: { sourceHash: pin.sourceHash },
        label: entry.label.label, score: entry.label.score, passed: entry.label.passed, reasoning: entry.reasoning ?? '', stored: false,
      };

      if (context && context.used.skills.length > 0) answer.used = context.used;
      const memberControl = controlled.ok ? controlOf(controlled.judged, name) : { error: { code: controlled.code, message: controlled.message } };
      tried.push({ answer, stored: storedOf(stored, name, subject), control: memberControl });
    }
  }

  if (tried.length === 0) return { ok: true, answer: { error: { code: 'judge_failed', message: 'The run judged no scorer file on the session.' } }, text: '', warnings: '' };

  const lines = tried.map(linesOf);

  return { ok: true, answer: triedEnvelope(tried), text: lines.flatMap(({ text }) => text).join('\n'), warnings: lines.flatMap(({ warnings }) => warnings).join('\n') };
}

export const TryScorer = { files, prepare, report } as const;
