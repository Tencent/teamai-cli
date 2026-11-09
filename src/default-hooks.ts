import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FolderFiles, type FolderFile } from './resources/folder-files.js';
import { isJsonObject, type JsonObject, type TeamaiConfig } from './types.js';
import { parseYaml } from './utils/yaml.js';

// ─── Default hooks (#1787) ───────────────────────────────
//
//  teamai's hints keep their logic in hook-dispatch. Their texts
//  and thresholds are hooks/<name>/ folders in the npm package,
//  where a team's own hook folders would be: HOOK.yaml holds
//  `with:`, each text is <text>.md with optional <text>.en.md and
//  <text>.zh.md variants. Code keeps the contract of each: the
//  parameters with their ranges, and the variables each text
//  offers, as `{{ name }}`.
//

/** A whole number from `min` to `max`. */
function whole(min: number, max: number) {
  const error = `must be a whole number from ${min} to ${max}`;

  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
}

/** The tool-error tiers, the first whose `min` the count reaches giving its points. */
const ToolErrorTiersSchema = z.array(z.strictObject({ min: whole(1, 1000), points: whole(0, 100) }), { error: 'must be a list of { min, points } tiers' })
  .min(1, { error: 'must list from 1 to 5 tiers' })
  .max(5, { error: 'must list from 1 to 5 tiers' })
  .refine((tiers) => tiers.every((tier, index) => index === 0 || tier.min < (tiers[index - 1]?.min ?? Infinity)), { error: 'must list its tiers with min strictly descending' });

/** No parameter: `with:` is empty or left out. */
const NoParamsSchema = z.strictObject({});

/** The `with:` parameters of each default hook folder, by name, with their ranges. */
const PARAMS = {
  'teamai-friction-reminder': z.strictObject({
    min_tools: whole(1, 1000),
    min_score: whole(1, 1000),
    weights: z.strictObject({ interrupt: whole(0, 100), reject: whole(0, 100), correction: whole(0, 100) }, { error: 'must be a mapping of interrupt, reject and correction' }),
    tool_error_tiers: ToolErrorTiersSchema,
    skill_bonus: whole(0, 100),
    diversity_bonus_max: whole(0, 100),
    knowledge_gap_bonus: whole(0, 100),
    low_quality_bonus: whole(0, 100),
    low_quality_threshold: z.number({ error: 'must be a number from 0 to 100' }).min(0, { error: 'must be a number from 0 to 100' }).max(100, { error: 'must be a number from 0 to 100' }),
  }),
  'teamai-mr-hint': z.strictObject({ lookback_days: whole(1, 90), max_mrs: whole(1, 100) }),
  'teamai-todowrite-hint': NoParamsSchema,
  'teamai-env-hint': NoParamsSchema,
  'teamai-package-hint': NoParamsSchema,
} as const;

/** The name of a teamai default hook folder, `hooks/<name>/`. */
export type DefaultHookName = keyof typeof PARAMS;

/** The texts each default hook folder renders, by name, with the variables each offers; a text with no variable offers none. */
const TEXTS = {
  'teamai-friction-reminder': {
    problem: [],
    'problem-reasons': ['reasons'],
    gap: [],
    'gap-reasons': ['reasons'],
    task: ['task'],
    action: [],
    'action-gap': [],
    'action-share-learnings': ['command'],
  },
  'teamai-mr-hint': { 'offer-command': ['count', 'mr_lines', 'command'], 'offer-workflow': ['count', 'mr_lines', 'command'] },
  'teamai-todowrite-hint': { message: [] },
  'teamai-env-hint': { variables: ['variables'], secrets: ['secrets'], exec: [], 'secrets-rule': [] },
  'teamai-package-hint': { message: ['summary'] },
} as const satisfies Record<DefaultHookName, Record<string, readonly string[]>>;

/** The `with:` parameters of default hook `TName`, once read. */
export type DefaultHookParams<TName extends DefaultHookName> = z.infer<(typeof PARAMS)[TName]>;

/** Each name's schema of its own parameters. */
type ParamsSchemas = { readonly [TName in DefaultHookName]: z.ZodType<DefaultHookParams<TName>> };

/** `PARAMS`, typed so that a lookup by a generic name keeps its parameters' type. */
const PARAMS_BY_NAME: ParamsSchemas = PARAMS;

/** A text of default hook `TName`: `problem` is `problem.md`. */
export type DefaultHookTextName<TName extends DefaultHookName> = keyof (typeof TEXTS)[TName] & string;

/** The variables text `TText` of default hook `TName` offers. */
type TextVariable<TName extends DefaultHookName, TText extends DefaultHookTextName<TName>> =
  (typeof TEXTS)[TName][TText] extends readonly (infer TVariable extends string)[] ? TVariable : never;

/** The language a text is picked for: `teamai.yaml` `language`, undefined when unset. */
export type HintLanguage = TeamaiConfig['language'];

/** One text, picked for a language: the language of the variant it came from (null for the base file), and its content filled in. */
export interface PickedText<TVariable extends string> {
  readonly language: NonNullable<HintLanguage> | null;
  render(values: Readonly<Record<TVariable, string>>): string;
}

/** A default hook folder, read: its parameters, and its texts. */
export interface DefaultHook<TName extends DefaultHookName> {
  readonly params: DefaultHookParams<TName>;
  /** Text `text` for `language`: `<text>.<language>.md` when the folder has it, else `<text>.md`. */
  text<TText extends DefaultHookTextName<TName>>(text: TText, language: HintLanguage): PickedText<TextVariable<TName, TText>>;
}

/** The package root, holding `hooks/`. This file sits one level below it, in src/ and in the bundle in dist/ alike. */
function packageRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..');
}

/** `{{ name }}`: a variable a text reads. */
const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** `content` with each `{{ name }}` replaced by its value, in one pass: a value is never read again for variables. */
function substitute(content: string, values: Readonly<Record<string, string>>): string {
  return content.replace(VARIABLE, (read, inner: string) => values[inner.trim()] ?? read);
}

/** A text file as teamai renders it: CRLF read as LF, and one trailing newline removed, so separators are code's. */
function textOf(file: FolderFile): string {
  return file.bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/** A text's files: its base file, and the variants the folder has. */
interface TextVariants {
  base: string;
  en?: string;
  zh?: string;
}

/** Default hook `name` from the files of its folder, or why they do not make one. */
function readFolder<TName extends DefaultHookName>(name: TName, files: readonly FolderFile[]): { ok: true; hook: DefaultHook<TName> } | { ok: false; problems: string[] } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems: string[] = [];
  const marker = byPath.get('HOOK.yaml');
  let raw: JsonObject = {};

  try {
    const parsed = parseYaml(marker ? textOf(marker) : '');

    if (isJsonObject(parsed)) raw = parsed;
    else problems.push('HOOK.yaml must be a mapping of description and with');
  } catch (error) {
    problems.push(`HOOK.yaml does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  const params = PARAMS_BY_NAME[name].safeParse(raw.with ?? {});

  if (!params.success) problems.push(...params.error.issues.map((issue) => `HOOK.yaml: with.${issue.path.join('.')} ${issue.message}`));

  const texts = new Map<string, TextVariants>();

  for (const text of Object.keys(TEXTS[name])) {
    const base = byPath.get(`${text}.md`);

    if (!base) {
      problems.push(`${text}.md is missing`);
      continue;
    }

    const variants: TextVariants = { base: textOf(base) };
    const en = byPath.get(`${text}.en.md`);
    const zh = byPath.get(`${text}.zh.md`);

    if (en) variants.en = textOf(en);

    if (zh) variants.zh = textOf(zh);
    texts.set(text, variants);
  }

  if (!params.success || problems.length > 0) return { ok: false, problems };

  const hook: DefaultHook<TName> = {
    params: params.data,
    text(text, language) {
      const variants = texts.get(text);

      // readFolder read every text the contract names, or returned its problems above.
      if (!variants) throw new Error(`teamai's default hook ${name} has no text ${text}`);
      const variant = language ? variants[language] : undefined;

      return { language: variant !== undefined && language ? language : null, render: (values) => substitute(variant ?? variants.base, values) };
    },
  };

  return { ok: true, hook };
}

/** The folder teamai ships for `name`. It is part of teamai's package, so one that cannot be read is a teamai bug, and throws. */
async function load<TName extends DefaultHookName>(name: TName): Promise<DefaultHook<TName>> {
  const dir = path.join(packageRoot(), 'hooks', name);
  const read = await FolderFiles.read(dir);

  if (read.kind === 'invalid') throw new Error(`teamai's default hook folder ${dir} cannot be read: ${read.problems.map(FolderFiles.describe).join(', ')}`);
  const folder = readFolder(name, read.files);

  if (!folder.ok) throw new Error(`teamai's default hook folder ${dir} is broken: ${folder.problems.join('; ')}`);

  return folder.hook;
}

export const DefaultHooks = { load } as const;
