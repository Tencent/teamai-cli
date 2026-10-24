/**
 * A scorer is `scorers/<name>.md`: YAML frontmatter with the labels a judge may give and the score that passes, then
 * the prompt the judge reads. The shape follows Warp's `scorer.md`, so a team can bring its scorers.
 */
import path from 'node:path';
import { z } from 'zod';
import { modelValueProblem } from '../models/aliases.js';
import { splitFrontmatter } from '../utils/frontmatter.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const text = (message: string) => z.string({ required_error: message, invalid_type_error: message }).refine((value) => value.trim() !== '', message);
const number = (message: string) => z.number({ required_error: message, invalid_type_error: message }).finite(message);

const LabelSchema = z.object({
  value: text('must be a non-empty string'),
  score: number('must be a number'),
  description: text('must be a non-empty string'),
}).strict();

const LABEL_COUNT = 'must list 2 to 20 labels: at least one that passes and one that fails';

const FrontmatterSchema = z.object({
  labels: z.array(LabelSchema, { required_error: LABEL_COUNT, invalid_type_error: LABEL_COUNT }).min(2, LABEL_COUNT).max(20, LABEL_COUNT),
  passingScore: number('must be a number'),
  samplingRate: number('must be a number from 0 to 100').min(0, 'must be a number from 0 to 100').max(100, 'must be a number from 0 to 100').default(25),
  model: z.string({ invalid_type_error: 'must be a non-empty string without spaces' }).superRefine((model, ctx) => {
    const problem = modelValueProblem(model);
    if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }).optional(),
  isolation: z.enum(['verified', 'best-effort'], { errorMap: () => ({ message: 'must be verified or best-effort' }) }).optional(),
}).strict().superRefine((scorer, ctx) => {
  const seen = new Set<string>();
  scorer.labels.forEach((label, index) => {
    if (seen.has(label.value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index, 'value'], message: `repeats "${label.value}"` });
    seen.add(label.value);
  });
  const passing = scorer.labels.some((label) => label.score >= scorer.passingScore);
  const failing = scorer.labels.some((label) => label.score < scorer.passingScore);
  if (!passing || !failing) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passingScore'], message: 'must have at least one label at or above it and one below it' });
  }
});

export type ScorerLabel = z.infer<typeof LabelSchema>;

export type ScorerDefinition = z.infer<typeof FrontmatterSchema> & {
  /** The file name without `.md`. */
  name: string;
  /** The Markdown after the frontmatter, as written. */
  prompt: string;
};

/** Why a file under `scorers/` is not a scorer. */
export interface ScorerDiagnostic {
  /** The team-repo-relative path, such as `scorers/review-quality.md`. */
  file: string;
  message: string;
}

export type ParsedScorer = { ok: true; definition: ScorerDefinition } | { ok: false; diagnostics: ScorerDiagnostic[] };

export function formatScorerDiagnostic(diagnostic: ScorerDiagnostic): string {
  return `${diagnostic.file}: ${diagnostic.message}`;
}

/** `labels[0].score`, as a scorer author writes the field. */
function fieldOf(at: ReadonlyArray<string | number>): string {
  return at.map((part, index) => (typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`)).join('');
}

function issueMessages(issue: z.ZodIssue): string[] {
  const field = fieldOf(issue.path);
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => `${field ? `${field} ` : ''}uses \`${key}\`, which this teamai does not know. Update teamai.`);
  }
  return [`${field} ${issue.message}`];
}

export function parseScorer(relativePath: string, content: string): ParsedScorer {
  const fail = (...messages: string[]): ParsedScorer => ({ ok: false, diagnostics: messages.map((message) => ({ file: relativePath, message })) });
  const name = path.posix.basename(relativePath, '.md');
  if (!TOKEN.test(name)) return fail('the file name must be a token such as review-quality.md');
  const { data, valid, body, raw } = splitFrontmatter(content);
  if (raw === '') return fail('a scorer starts with YAML frontmatter between --- lines');
  if (!valid) return fail('the frontmatter must be a YAML mapping');
  const parsed = FrontmatterSchema.safeParse(data);
  const problems = parsed.success ? [] : parsed.error.issues.flatMap(issueMessages);
  if (body.trim() === '') problems.push('the prompt after the frontmatter is empty');
  if (!parsed.success || problems.length > 0) return fail(...problems);
  return { ok: true, definition: { name, ...parsed.data, prompt: body } };
}
