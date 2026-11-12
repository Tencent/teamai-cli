import path from 'node:path';
import { z } from 'zod';
import { FOLDER_MARKERS } from './folder-markers.js';
import { packageRoot } from './package-info.js';
import { DeliveredFolders } from './resources/delivered-folders.js';
import { FolderFiles, type FolderFile } from './resources/folder-files.js';
import { isJsonObject, type JsonObject, type JsonValue, type LocalConfig, type TeamaiConfig } from './types.js';
import { log } from './utils/logger.js';
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

const NAMES = Object.keys(PARAMS).filter((name): name is DefaultHookName => name in PARAMS);

/** Whether `name` is one of teamai's default hook folders, which a team folder of that name at the root replaces. */
function isName(name: string): name is DefaultHookName {
  return NAMES.some((known) => known === name);
}

/** `{{ name }}`: a variable a text reads. */
const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** `content` with each `{{ name }}` replaced by its value, in one pass: a value is never read again for variables. */
function substitute(content: string, values: Readonly<Record<string, string>>): string {
  return content.replace(VARIABLE, (read, inner: string) => values[inner.trim()] ?? read);
}

/** A text's files: its base file, and the variants the folder has. */
interface TextVariants {
  base: string;
  en?: string;
  zh?: string;
}

/** The variant of a text a hint reads for `language`: `<text>.<language>.md` when the folder has it, else `<text>.md`. */
function pick(variants: TextVariants, language: HintLanguage): { language: NonNullable<HintLanguage> | null; content: string } {
  const variant = language ? variants[language] : undefined;

  return variant !== undefined && language ? { language, content: variant } : { language: null, content: variants.base };
}

/**
 * `base` with the keys of `own` over it (#1787, common rule 5): a key `own` leaves out keeps `base`'s value, and a
 * mapping in both is merged one level down, so `weights: { reject: 30 }` keeps the other weights. A list is replaced.
 */
function withOver(base: JsonObject, own: JsonValue | undefined): JsonValue {
  if (own === undefined || own === null) return base;

  if (!isJsonObject(own)) return own;
  const merged: JsonObject = { ...base };

  for (const [key, value] of Object.entries(own)) {
    const under = base[key];
    merged[key] = isJsonObject(under) && isJsonObject(value) ? { ...under, ...value } : value;
  }

  return merged;
}

/** What one issue with `with:` of default hook `name` says, naming the parameter: one line per key it does not take. */
function paramProblems(name: DefaultHookName, issue: z.core.$ZodIssue): string[] {
  const at = (keys: readonly PropertyKey[]): string => ['with', ...keys.map(String)].join('.');

  if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => `HOOK.yaml: ${at([...issue.path, key])} is not a parameter of ${name}`);

  return [`HOOK.yaml: ${at(issue.path)} ${issue.message}`];
}

/** Whether `texts` holds every text default hook `name` renders. */
function holdsEveryText<TName extends DefaultHookName>(name: TName, texts: Partial<Record<string, TextVariants>>): texts is Record<DefaultHookTextName<TName>, TextVariants> {
  return Object.keys(TEXTS[name]).every((text) => texts[text] !== undefined);
}

/** A folder read as default hook `TName`: the hook, its texts, and the `with:` it was written with, or why its files do not make one. */
type FolderRead<TName extends DefaultHookName> =
  | { readonly ok: true; readonly hook: DefaultHook<TName>; readonly with: JsonObject; readonly texts: Readonly<Partial<Record<string, TextVariants>>> }
  | { readonly ok: false; readonly problems: string[]; readonly with: JsonObject };

/** Default hook `name` from the files of its folder, its `with:` over `base` (teamai's, for a team's replacement), or why they do not make one. */
function readFolder<TName extends DefaultHookName>(name: TName, files: readonly FolderFile[], base: JsonObject): FolderRead<TName> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const refusals: string[] = [];
  const marker = byPath.get(FOLDER_MARKERS.hooks.marker);
  let raw: JsonObject = {};

  try {
    const parsed = parseYaml(marker ? FolderFiles.text(marker.bytes.toString('utf8')) : '');

    if (isJsonObject(parsed)) raw = parsed;
    else refusals.push('HOOK.yaml must be a mapping of description and with');

    // The folder's name says which behaviour of teamai's it configures, so it runs nothing of its own.
    for (const key of Object.keys(raw)) {
      if (key === 'command') refusals.push('HOOK.yaml: command is not taken by a default hook, which runs teamai\'s own handler. Remove it, or give a hook of your own another name');
      else if (key !== 'description' && key !== 'with') refusals.push(`HOOK.yaml: ${key} is not a key of a default hook, whose HOOK.yaml holds description and with`);
    }
  } catch (error) {
    refusals.push(`HOOK.yaml does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  const params = PARAMS_BY_NAME[name].safeParse(withOver(base, raw.with));

  if (!params.success) refusals.push(...params.error.issues.flatMap((issue) => paramProblems(name, issue)));

  const texts: Partial<Record<string, TextVariants>> = {};

  for (const [text, offered] of Object.entries<readonly string[]>(TEXTS[name])) {
    // A text with a variable it does not offer, or anything in braces that is not a variable, would print as written.
    const read = (file: string): string | undefined => {
      const found = byPath.get(file);

      if (!found) return undefined;
      const content = FolderFiles.text(found.bytes.toString('utf8'));

      for (const [source, inner = ''] of content.matchAll(VARIABLE)) {
        if (offered.includes(inner.trim())) continue;
        const offers = offered.length > 0 ? offered.map((variable) => `{{ ${variable} }}`).join(', ') : 'no variable';
        refusals.push(`${file} reads ${source}, which the ${text} text does not offer: it offers ${offers}`);
      }

      return content;
    };

    const baseText = read(`${text}.md`);

    if (baseText === undefined) {
      refusals.push(`${text}.md is missing: the folder replaces the ${text} text in another language, which replaces every language of it. Add ${text}.md`);
      continue;
    }

    const variants: TextVariants = { base: baseText };
    const en = read(`${text}.en.md`);
    const zh = read(`${text}.zh.md`);

    if (en !== undefined) variants.en = en;

    if (zh !== undefined) variants.zh = zh;
    texts[text] = variants;
  }

  const own = isJsonObject(raw.with) ? raw.with : {};

  if (!params.success || refusals.length > 0 || !holdsEveryText(name, texts)) return { ok: false, problems: refusals, with: own };

  const hook: DefaultHook<TName> = {
    params: params.data,
    text(text, language) {
      const picked = pick(texts[text], language);

      return { language: picked.language, render: (values) => substitute(picked.content, values) };
    },
  };

  return { ok: true, hook, with: own, texts };
}

/** The folder teamai ships for `name`. It is part of teamai's package, so one that cannot be read is a teamai bug, and throws. */
async function shipped<TName extends DefaultHookName>(name: TName): Promise<{ hook: DefaultHook<TName>; with: JsonObject; texts: Readonly<Partial<Record<string, TextVariants>>> }> {
  const dir = path.join(packageRoot(), 'hooks', name);
  const read = await FolderFiles.read(dir);

  if (read.kind === 'invalid') throw new Error(`teamai's default hook folder ${dir} cannot be read: ${read.problems.map(FolderFiles.describe).join(', ')}`);
  const folder = readFolder(name, read.files, {});

  if (!folder.ok) throw new Error(`teamai's default hook folder ${dir} is broken: ${folder.problems.join('; ')}`);

  return folder;
}

/**
 * Default hook `name` as `scope` reads it: the team's replacement pull delivered to the scope, else teamai's folder.
 * With no scope (teamai is not set up where the hook runs), teamai's folder.
 */
async function load<TName extends DefaultHookName>(name: TName, scope: LocalConfig | null): Promise<DefaultHook<TName>> {
  const teamai = await shipped(name);

  if (scope) {
    const dir = DeliveredFolders.pathOf(scope, { type: 'hooks', namespace: null, name });
    const read = await FolderFiles.read(dir);

    if (read.kind === 'files') {
      const folder = readFolder(name, read.files, teamai.with);

      if (folder.ok) return folder.hook;
      log.debug(`default hook ${name}: the team's folder at ${dir} is not used, teamai's is: ${folder.problems.join('; ')}`);
    }
  }

  return teamai.hook;
}

/** Why pull refuses `files`, a team folder that would replace default hook `name`; none when it may replace it. */
async function problems(name: DefaultHookName, files: readonly FolderFile[]): Promise<string[]> {
  const folder = readFolder(name, files, (await shipped(name)).with);

  return folder.ok ? [] : folder.problems;
}

/** How a team's folder differs from teamai's: each `with:` parameter, and each text by the file a hint reads. Names and values, never a text. */
export interface DefaultHookComparison {
  /** `weights.reject` for a parameter of a mapping. `team` is null where the team's folder leaves a parameter out. */
  readonly params: ReadonlyArray<{ readonly key: string; readonly teamai: JsonValue | null; readonly team: JsonValue | null }>;
  /** `file`: the variant the hint in force reads for the language. `replaced`: what it reads differs from what teamai's folder gives. */
  readonly texts: ReadonlyArray<{ readonly text: string; readonly file: string; readonly replaced: boolean }>;
}

/** `team`, the files of a team's folder replacing default hook `name` (null for none), against teamai's, for `language`. */
async function compare(name: DefaultHookName, team: readonly FolderFile[] | null, language: HintLanguage): Promise<DefaultHookComparison> {
  const teamai = await shipped(name);
  const own = team === null ? null : readFolder(name, team, teamai.with);
  const ownWith = own?.with ?? {};
  // The hint reads the team's texts only when its folder is valid; otherwise teamai's.
  const inForce = own?.ok ? own.texts : teamai.texts;
  const keys = (...objects: JsonObject[]): string[] => [...new Set(objects.flatMap((object) => Object.keys(object)))];

  const params = keys(teamai.with, ownWith).flatMap((key) => {
    const base = teamai.with[key];
    const set = ownWith[key];

    if (isJsonObject(base) && (set === undefined || isJsonObject(set))) {
      return keys(base, set ?? {}).map((inner) => ({ key: `${key}.${inner}`, teamai: base[inner] ?? null, team: set?.[inner] ?? null }));
    }

    return [{ key, teamai: base ?? null, team: set ?? null }];
  });

  const read = (texts: Readonly<Partial<Record<string, TextVariants>>>, text: string) => {
    const variants = texts[text];

    return variants ? pick(variants, language) : null;
  };

  const texts = Object.keys(TEXTS[name]).map((text) => {
    const picked = read(inForce, text);

    return { text, file: picked?.language ? `${text}.${picked.language}.md` : `${text}.md`, replaced: picked?.content !== read(teamai.texts, text)?.content };
  });

  return { params, texts };
}

export const DefaultHooks = { NAMES, isName, load, problems, compare } as const;
