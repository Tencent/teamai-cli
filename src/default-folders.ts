import path from 'node:path';
import { z } from 'zod';
import { FOLDER_MARKERS } from './folder-markers.js';
import { packageRoot } from './package-info.js';
import { DeliveredFolders } from './resources/delivered-folders.js';
import { FolderFiles, type FolderFile } from './resources/folder-files.js';
import { isJsonObject, type JsonObject, type JsonValue, type LocalConfig, type TeamaiConfig } from './types.js';
import { durationMs } from './utils/duration.js';
import { log } from './utils/logger.js';
import { parseYaml } from './utils/yaml.js';

// ─── Default folders (#1787, #1829) ──────────────────────
//
//  A teamai default whose files code reads, such as a hint's hook
//  folder or the recall rule's folder, keeps what a team may change
//  in files of its folder in the npm package: params.yaml holds its
//  parameters, each text is <text>.md with optional <text>.en.md and
//  <text>.zh.md variants. A team folder of the same name changes any
//  of them. Code keeps the contract of each: the parameters with
//  their ranges, the variables each text offers, as `{{ name }}`,
//  and the lines a text must keep.
//

/** A whole number from `min` to `max`. */
function whole(min: number, max: number) {
  const error = `must be a whole number from ${min} to ${max}`;

  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error });
}

/** A number from 0 to 1. */
function ratio() {
  const error = 'must be a number from 0 to 1';

  return z.number({ error }).min(0, { error }).max(1, { error });
}

/** A duration as a workflow's `timeout` writes it, from `min` to `max`, read as its text and its milliseconds. */
function duration(min: string, max: string) {
  const error = `must be a duration from ${min} to ${max}, such as 6h`;
  const [low = 0, high = 0] = [durationMs(min), durationMs(max)];

  return z.string({ error }).transform((text, ctx) => {
    const ms = durationMs(text);

    if (ms === undefined || ms < low || ms > high) {
      ctx.addIssue({ code: 'custom', message: error });

      return z.NEVER;
    }

    return { text, ms };
  });
}

/** The tool-error tiers, the first whose `min` the count reaches giving its points. */
const ToolErrorTiersSchema = z.array(z.strictObject({ min: whole(1, 1000), points: whole(0, 100) }), { error: 'must be a list of { min, points } tiers' })
  .min(1, { error: 'must list from 1 to 5 tiers' })
  .max(5, { error: 'must list from 1 to 5 tiers' })
  .refine((tiers) => tiers.every((tier, index) => index === 0 || tier.min < (tiers[index - 1]?.min ?? Infinity)), { error: 'must list its tiers with min strictly descending' });

/** No parameter: the folder has no params.yaml. */
const NoParamsSchema = z.strictObject({});

/** The parameters of each default folder, by kind and name, with their ranges. */
const PARAMS = {
  hooks: {
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
  },
  rules: {
    'teamai-recall': NoParamsSchema,
  },
  workflows: {
    'teamai-finished-sessions': z.strictObject({ idle: duration('10m', '7d') }),
    'teamai-codebase-deep-enrich': z.strictObject({ concurrency: whole(1, 20) }),
    'teamai-draft-learning-updates': z.strictObject({ min_recalled: whole(1, 1000), max_upvoted: whole(0, 1000), min_users: whole(1, 1000), max_related: whole(0, 20) }),
    'teamai-promote-learning': z.strictObject({ min_confidence: ratio(), min_upvoted: whole(1, 1000), min_users: whole(1, 1000), min_age_days: whole(0, 3650) }),
  },
} as const;

/** What a text of a default folder offers and keeps: the variables it may read, and the lines every language of it must hold. */
interface TextContract {
  readonly variables?: readonly string[];
  readonly required?: readonly string[];
}

/** The texts each default folder gives code, by kind and name, with what each offers and keeps. */
const TEXTS = {
  hooks: {
    'teamai-friction-reminder': {
      problem: {},
      'problem-reasons': { variables: ['reasons'] },
      gap: {},
      'gap-reasons': { variables: ['reasons'] },
      task: { variables: ['task'] },
      action: {},
      'action-gap': {},
      'action-share-learnings': { variables: ['command'] },
      'reason-interrupt': { variables: ['count', 'times'] },
      'reason-tool-reject': { variables: ['count', 'times', 'tool_calls'] },
      'reason-correction': { variables: ['count', 'times'] },
      'reason-tool-error': { variables: ['count', 'times'] },
    },
    'teamai-mr-hint': { 'offer-command': { variables: ['count', 'mr_lines', 'command'] }, 'offer-workflow': { variables: ['count', 'mr_lines', 'command'] } },
    'teamai-todowrite-hint': { message: {} },
    'teamai-env-hint': { variables: { variables: ['variables'] }, secrets: { variables: ['secrets'] }, exec: {}, 'secrets-rule': {} },
    'teamai-package-hint': { message: { variables: ['summary'] } },
  },
  rules: {
    // Recall's own output and doctor point at these lines.
    'teamai-recall': { RULE: { required: ['Nothing was searched:', 'Recall skips the older index'] }, block: {}, 'block-direct': { required: ['Nothing was searched:'] } },
  },
  workflows: {
    'teamai-draft-learning-updates': {},
    'teamai-finished-sessions': {},
    'teamai-codebase-deep-enrich': {},
    'teamai-promote-learning': {},
  },
} as const satisfies { readonly [TKind in keyof typeof PARAMS]: { readonly [TName in keyof (typeof PARAMS)[TKind]]: Readonly<Record<string, TextContract>> } };

/** A kind of resource some of whose teamai defaults code reads, by the folder's files. */
export type DefaultFolderKind = keyof typeof PARAMS;

/** The name of a teamai default folder of kind `TKind`: `hooks/teamai-mr-hint/` is `teamai-mr-hint`. */
export type DefaultFolderName<TKind extends DefaultFolderKind> = keyof (typeof PARAMS)[TKind] & keyof (typeof TEXTS)[TKind] & string;

/** The parameters of default folder `TName` of kind `TKind`, once read. */
export type DefaultFolderParams<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>> =
  (typeof PARAMS)[TKind][TName] extends z.ZodType<infer TParams> ? TParams : never;

/** Each folder's schema of its own parameters. */
type ParamsSchemas = { readonly [TKind in DefaultFolderKind]: { readonly [TName in DefaultFolderName<TKind>]: z.ZodType<DefaultFolderParams<TKind, TName>> } };

/** `PARAMS`, typed so that a lookup by a generic kind and name keeps its parameters' type. */
const PARAMS_BY_NAME: ParamsSchemas = PARAMS;

/** The text contracts of every default folder of each kind, by name. */
type TextContracts = { readonly [TKind in DefaultFolderKind]: Readonly<Record<string, Readonly<Record<string, TextContract>>>> };

/** `TEXTS`, read by any kind and name. */
const TEXTS_BY_NAME: TextContracts = TEXTS;

/** A text of default folder `TName` of kind `TKind`: `problem` is `problem.md`. */
export type DefaultFolderTextName<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>> = keyof (typeof TEXTS)[TKind][TName] & string;

/** The variables text `TText` of a default folder offers. */
type TextVariable<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>, TText extends DefaultFolderTextName<TKind, TName>> =
  (typeof TEXTS)[TKind][TName][TText] extends { readonly variables: readonly (infer TVariable extends string)[] } ? TVariable : never;

/** A teamai default folder of kind `TKind`: `{ kind: 'hooks', name: 'teamai-mr-hint' }` is `hooks/teamai-mr-hint/`. */
export interface DefaultFolderRef<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>> {
  readonly kind: TKind;
  readonly name: TName;
}

/** The language a text is picked for: `teamai.yaml` `language`, undefined when unset. */
export type TextLanguage = TeamaiConfig['language'];

/** One text, picked for a language: the file it was read from, its language (null for the base file), and its content filled in. */
export interface PickedText<TVariable extends string> {
  readonly file: string;
  readonly language: NonNullable<TextLanguage> | null;
  render(values: Readonly<Record<TVariable, string>>): string;
}

/** A default folder, read: its parameters, and its texts. */
export interface DefaultFolder<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>> {
  readonly params: DefaultFolderParams<TKind, TName>;
  /** Text `text` for `language`: `<text>.<language>.md` when the folder has it, else `<text>.md`. */
  text<TText extends DefaultFolderTextName<TKind, TName>>(text: TText, language: TextLanguage): PickedText<TextVariable<TKind, TName, TText>>;
}

/** The names of kind `kind`'s default folders. */
function names<TKind extends DefaultFolderKind>(kind: TKind): Array<DefaultFolderName<TKind>> {
  return Object.keys(PARAMS[kind]).filter((name): name is DefaultFolderName<TKind> => isName(kind, name));
}

/** Whether `name` is one of teamai's default folders of kind `kind`, which a team folder of that name at the root changes. */
function isName<TKind extends DefaultFolderKind>(kind: TKind, name: string): name is DefaultFolderName<TKind> {
  return Object.hasOwn(PARAMS[kind], name) && Object.hasOwn(TEXTS[kind], name);
}

/** `{{ name }}`: a variable a text reads. */
const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** `content` with each `{{ name }}` replaced by its value, in one pass: a value is never read again for variables. */
function substitute(content: string, values: Readonly<Record<string, string>>): string {
  return content.replace(VARIABLE, (source, inner: string) => values[inner.trim()] ?? source);
}

/** A text's files: its base file, and the variants the folder has. */
interface TextVariants {
  base: string;
  en?: string;
  zh?: string;
}

/** The variant of a text read for `language`: `<text>.<language>.md` when the folder has it, else `<text>.md`. */
function pick(text: string, variants: TextVariants, language: TextLanguage): { file: string; language: NonNullable<TextLanguage> | null; content: string } {
  const variant = language ? variants[language] : undefined;

  return variant !== undefined && language ? { file: `${text}.${language}.md`, language, content: variant } : { file: `${text}.md`, language: null, content: variants.base };
}

/**
 * `base` with the keys of `own` over it (#1787, common rule 5): a key `own` leaves out keeps `base`'s value, and a
 * mapping in both is merged one level down, so `weights: { reject: 30 }` keeps the other weights. A list is replaced.
 */
function withOver(base: JsonObject, own: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };

  for (const [key, value] of Object.entries(own)) {
    const under = base[key];
    merged[key] = isJsonObject(under) && isJsonObject(value) ? { ...under, ...value } : value;
  }

  return merged;
}

/** What one issue with the parameters of default folder `name` says, naming the parameter: one line per key it does not take. */
function paramProblems(name: string, issue: z.core.$ZodIssue): string[] {
  const at = (keys: readonly PropertyKey[]): string => keys.map(String).join('.');

  if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => `params.yaml: ${at([...issue.path, key])} is not a parameter of ${name}`);

  return [`params.yaml: ${issue.path.length > 0 ? `${at(issue.path)} ` : ''}${issue.message}`];
}

/** The mapping YAML file `file` of a folder holds, empty when the folder has none, or why it is not one. */
function readMapping(file: FolderFile | undefined, shown: string): { ok: true; mapping: JsonObject } | { ok: false; problem: string } {
  try {
    const parsed = parseYaml(file ? FolderFiles.text(file.bytes.toString('utf8')) : '');

    if (parsed === null || parsed === undefined) return { ok: true, mapping: {} };

    return isJsonObject(parsed) ? { ok: true, mapping: parsed } : { ok: false, problem: `${shown} must be a mapping` };
  } catch (error) {
    return { ok: false, problem: `${shown} does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Why the marker of a default folder of kind `kind` breaks its contract. A default hook runs teamai's handler, so its HOOK.yaml holds only description. */
function markerProblems(kind: DefaultFolderKind, byPath: ReadonlyMap<string, FolderFile>): string[] {
  switch (kind) {
    case 'hooks': {
      const marker = readMapping(byPath.get(FOLDER_MARKERS.hooks.marker), FOLDER_MARKERS.hooks.marker);

      if (!marker.ok) return [marker.problem];

      return Object.keys(marker.mapping).flatMap((key) => {
        if (key === 'command') return ['HOOK.yaml: command is not taken by a default hook, which runs teamai\'s own handler. Remove it, or give a hook of your own another name'];

        if (key === 'with') return ['HOOK.yaml: with is not a key of a default hook, whose parameters are in params.yaml. Move the keys of with to params.yaml'];

        return key === 'description' ? [] : [`HOOK.yaml: ${key} is not a key of a default hook, whose HOOK.yaml holds only description`];
      });
    }

    case 'rules':
      // RULE.md is one of the folder's texts.
      return [];
    case 'workflows':
      // The workflow engine checks WORKFLOW.yaml.
      return [];
    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}

/** Why `content`, text `file` of a default folder of kind `kind`, breaks how that kind is delivered. */
function deliveryProblems(kind: DefaultFolderKind, file: string, content: string): string[] {
  switch (kind) {
    case 'hooks':
    case 'workflows':
      return [];
    case 'rules':
      return DeliveredFolders.mentions(content, 'rules')
        ? [`${file} names \${TEAMAI_RULE_DIR}, but the text of a teamai default rule is delivered alone, without the other files of its folder. Put what it points at in the file`]
        : [];
    default: {
      const unhandled: never = kind;

      return unhandled;
    }
  }
}

/** Whether `texts` holds every text of default folder `ref`. */
function holdsEveryText<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, texts: Partial<Record<string, TextVariants>>): texts is Record<DefaultFolderTextName<TKind, TName>, TextVariants> {
  return Object.keys(TEXTS_BY_NAME[ref.kind][ref.name] ?? {}).every((text) => texts[text] !== undefined);
}

/** The texts of a folder read, each with its variants. */
type FolderTexts = Readonly<Partial<Record<string, TextVariants>>>;

/** A folder read as default folder `ref`: the folder, its texts, and the parameters its params.yaml sets, or why its files do not make one. */
type FolderRead<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>> =
  | { readonly ok: true; readonly folder: DefaultFolder<TKind, TName>; readonly params: JsonObject; readonly texts: FolderTexts }
  | { readonly ok: false; readonly problems: string[]; readonly params: JsonObject };

/** The texts of `contracts` read from `byPath`, each variant checked against its text's contract, with why any breaks it. */
function readTexts(kind: DefaultFolderKind, contracts: Readonly<Record<string, TextContract>>, byPath: ReadonlyMap<string, FolderFile>) {
  const texts: Partial<Record<string, TextVariants>> = {};
  const refusals: string[] = [];

  for (const [text, { variables = [], required = [] }] of Object.entries(contracts)) {
    // A text with a variable it does not offer, or anything in braces that is not a variable, would print as written.
    const readVariant = (file: string): string | undefined => {
      const found = byPath.get(file);

      if (!found) return undefined;
      const content = FolderFiles.text(found.bytes.toString('utf8'));

      for (const [source, inner = ''] of content.matchAll(VARIABLE)) {
        if (variables.includes(inner.trim())) continue;
        const offers = variables.length > 0 ? variables.map((variable) => `{{ ${variable} }}`).join(', ') : 'no variable';
        refusals.push(`${file} reads ${source}, which the ${text} text does not offer: it offers ${offers}`);
      }

      for (const line of required.filter((kept) => !content.includes(kept))) refusals.push(`${file} does not contain "${line}"`);
      refusals.push(...deliveryProblems(kind, file, content));

      return content;
    };

    const base = readVariant(`${text}.md`);

    if (base === undefined) {
      refusals.push(`${text}.md is missing: the folder replaces the ${text} text in another language, which replaces every language of it. Add ${text}.md`);
      continue;
    }

    const variants: TextVariants = { base };
    const en = readVariant(`${text}.en.md`);
    const zh = readVariant(`${text}.zh.md`);

    if (en !== undefined) variants.en = en;

    if (zh !== undefined) variants.zh = zh;
    texts[text] = variants;
  }

  return { texts, refusals };
}

/** Default folder `ref` from the files of its folder, its parameters over `base` (teamai's, for a team's replacement), or why they do not make one. */
function readFolder<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, files: readonly FolderFile[], base: JsonObject): FolderRead<TKind, TName> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const own = readMapping(byPath.get('params.yaml'), 'params.yaml');
  const set = own.ok ? own.mapping : {};
  const schema: z.ZodType<DefaultFolderParams<TKind, TName>> = PARAMS_BY_NAME[ref.kind][ref.name];
  const params = schema.safeParse(withOver(base, set));
  const { texts, refusals: textRefusals } = readTexts(ref.kind, TEXTS_BY_NAME[ref.kind][ref.name] ?? {}, byPath);

  const refusals = [
    ...markerProblems(ref.kind, byPath),
    ...(own.ok ? [] : [own.problem]),
    ...(params.success ? [] : params.error.issues.flatMap((issue) => paramProblems(ref.name, issue))),
    ...textRefusals,
  ];

  if (!params.success || refusals.length > 0 || !holdsEveryText(ref, texts)) return { ok: false, problems: refusals, params: set };

  const folder: DefaultFolder<TKind, TName> = {
    params: params.data,
    text(text, language) {
      const picked = pick(text, texts[text], language);

      return { file: picked.file, language: picked.language, render: (values) => substitute(picked.content, values) };
    },
  };

  return { ok: true, folder, params: set, texts };
}

/** The folder teamai ships for `ref`. It is part of teamai's package, so one that cannot be read is a teamai bug, and throws. */
async function shipped<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>): Promise<{ folder: DefaultFolder<TKind, TName>; params: JsonObject; texts: FolderTexts }> {
  const dir = path.join(packageRoot(), ref.kind, ref.name);
  const files = await FolderFiles.read(dir);

  if (files.kind === 'invalid') throw new Error(`teamai's default folder ${dir} cannot be read: ${files.problems.map(FolderFiles.describe).join(', ')}`);
  const folder = readFolder(ref, files.files, {});

  if (!folder.ok) throw new Error(`teamai's default folder ${dir} is broken: ${folder.problems.join('; ')}`);

  return folder;
}

/**
 * `files`, the folder a team's replacement and teamai's make together, read as default folder `ref`, or why pull
 * refuses it, one line each.
 */
async function read<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, files: readonly FolderFile[]): Promise<{ ok: true; folder: DefaultFolder<TKind, TName> } | { ok: false; problems: string[] }> {
  const own = readFolder(ref, files, (await shipped(ref)).params);

  return own.ok ? { ok: true, folder: own.folder } : { ok: false, problems: own.problems };
}

/** A kind whose team folder teamai delivers or caches, so its code reads it at run time rather than at pull. */
type LoadedKind = 'hooks' | 'workflows';

/**
 * The files of the team folder that changes default `ref` in `scope`, or null when the team changes none: a default
 * hook's folder pull delivered to the scope, or a default workflow's folder as a run of it would start from it.
 */
async function teamFiles(ref: { readonly kind: LoadedKind; readonly name: string }, scope: LocalConfig): Promise<{ path: string; files: FolderFile[] } | null> {
  switch (ref.kind) {
    case 'hooks': {
      const dir = DeliveredFolders.pathOf(scope, { type: 'hooks', namespace: null, name: ref.name });
      const delivered = await FolderFiles.read(dir);

      return delivered.kind === 'files' ? { path: dir, files: [...delivered.files] } : null;
    }

    case 'workflows': {
      const { resolveStart } = await import('./workflow/cache.js');
      const { workflow } = await resolveStart(scope, ref.name);

      // A team's single file replaces the folder whole, so teamai's parameters stay.
      if (workflow?.source !== 'team' || workflow.files === undefined) return null;

      return { path: workflow.relativePath, files: workflow.files.map((file) => ({ path: file.path, executable: file.executable, bytes: Buffer.from(file.content, 'utf8') })) };
    }

    default: {
      const unhandled: never = ref.kind;

      return unhandled;
    }
  }
}

/**
 * Default `ref` as `scope` reads it: the team's folder that changes it, else teamai's. With no scope (teamai is not
 * set up where the code runs), teamai's folder. Pull refuses a team folder that breaks the contract, so one read here
 * keeps it unless it changed after pull; then teamai's is read.
 */
async function load<TKind extends LoadedKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, scope: LocalConfig | null): Promise<DefaultFolder<TKind, TName>> {
  const teamai = await shipped(ref);
  const team = scope ? await teamFiles(ref, scope) : null;

  if (team === null) return teamai.folder;
  const folder = readFolder(ref, team.files, teamai.params);

  if (folder.ok) return folder.folder;
  log.debug(`default ${ref.kind} ${ref.name}: the team's folder at ${team.path} is not used, teamai's is: ${folder.problems.join('; ')}`);

  return teamai.folder;
}

/** Why pull refuses `files`, a team folder that would replace default folder `ref`; none when it may replace it. */
async function problems<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, files: readonly FolderFile[]): Promise<string[]> {
  const folder = await read(ref, files);

  return folder.ok ? [] : folder.problems;
}

/** How a team's folder differs from teamai's: each parameter, and each text by the file it is read from. Names and values, never a text. */
export interface DefaultFolderComparison {
  /** `weights.reject` for a parameter of a mapping. `team` is null where the team's folder leaves a parameter out. */
  readonly params: ReadonlyArray<{ readonly key: string; readonly teamai: JsonValue | null; readonly team: JsonValue | null }>;
  /** `file`: the variant read for the language. `replaced`: what it reads differs from what teamai's folder gives. */
  readonly texts: ReadonlyArray<{ readonly text: string; readonly file: string; readonly replaced: boolean }>;
}

/** `team`, the files of a team's folder replacing default folder `ref` (null for none), against teamai's, for `language`. */
async function compare<TKind extends DefaultFolderKind, TName extends DefaultFolderName<TKind>>(ref: DefaultFolderRef<TKind, TName>, team: readonly FolderFile[] | null, language: TextLanguage): Promise<DefaultFolderComparison> {
  const teamai = await shipped(ref);
  const own = team === null ? null : readFolder(ref, team, teamai.params);
  const ownParams = own?.params ?? {};
  // A folder is read with the team's texts only when it is valid; otherwise teamai's.
  const inForce = own?.ok ? own.texts : teamai.texts;
  const keys = (...objects: JsonObject[]): string[] => [...new Set(objects.flatMap((object) => Object.keys(object)))];

  const params = keys(teamai.params, ownParams).flatMap((key) => {
    const base = teamai.params[key];
    const set = ownParams[key];

    if (isJsonObject(base) && (set === undefined || isJsonObject(set))) {
      return keys(base, set ?? {}).map((inner) => ({ key: `${key}.${inner}`, teamai: base[inner] ?? null, team: set?.[inner] ?? null }));
    }

    return [{ key, teamai: base ?? null, team: set ?? null }];
  });

  const picked = (texts: FolderTexts, text: string) => {
    const variants = texts[text];

    return variants ? pick(text, variants, language) : null;
  };

  const texts = Object.keys(TEXTS_BY_NAME[ref.kind][ref.name] ?? {}).map((text) => {
    const used = picked(inForce, text);

    return { text, file: used?.file ?? `${text}.md`, replaced: used?.content !== picked(teamai.texts, text)?.content };
  });

  return { params, texts };
}

export const DefaultFolders = { names, isName, read, load, problems, compare } as const;
