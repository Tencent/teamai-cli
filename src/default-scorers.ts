import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScorer, type ScorerDefinition, type ScorerDiagnostic } from './scorers/definition.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { isTemplateRead, parseTemplate, renderText, type Template } from './workflow/template.js';

// ─── Default scorers (#1391) ─────────────────────────────
//
//  The CLI ships the rubrics of the questions it generates per
//  item, a routing question per team skill and an adoption
//  question per recalled doc, as
//  scorers/<name>.md in the npm package. Each is a template:
//  `{{ skill.name }}` reads a variable of the item, from a set
//  closed per default. A team file of the same name replaces
//  one once pull finds it reads only those variables and fills
//  in to a scorer; until then the default runs. Code keeps that
//  contract and nothing of the rubric.
//

/** The variables each default offers, by name: all a team file that replaces it may read. */
const VARIABLES = {
  'teamai-routing': ['skill.name'],
  'teamai-adoption': ['doc.id', 'doc.path', 'doc.file'],
} as const satisfies Record<string, readonly string[]>;

export type DefaultScorerName = keyof typeof VARIABLES;

/** The value of each variable of default `TName`, by its dotted name. */
export type DefaultScorerValues<TName extends DefaultScorerName> = Record<(typeof VARIABLES)[TName][number], string>;

/** Why pull refuses a team file named like a default: a template that does not parse, a variable it does not offer, or text that fills in to no scorer. */
export type DefaultScorerCode = 'default_scorer_template' | 'default_scorer_variable' | 'default_scorer_invalid';

/** A filled-in rubric: its text, which a run pins, and the scorer it parses to. */
export type FilledScorer = { content: string; definition: ScorerDefinition };

const NAMES: readonly DefaultScorerName[] = ['teamai-routing', 'teamai-adoption'];

function isName(name: string): name is DefaultScorerName {
  return NAMES.some((known) => known === name);
}

/** The root of every variable any default offers, so a file reading another default's variable is told so. */
const ROOTS = [...new Set(Object.values(VARIABLES).flatMap((names) => names.map((name) => name.split('.')[0] ?? name)))];

/** `scorers/` in the package root. This file sits one level below it, in src/ and in the bundle in dist/ alike. */
function defaultsDir(): string {
  const modulePath = fileURLToPath(import.meta.url);
  let moduleDir: string;

  try {
    moduleDir = path.dirname(fs.realpathSync(modulePath));
  } catch {
    moduleDir = path.dirname(modulePath);
  }

  return path.join(moduleDir, '..', 'scorers');
}

const shippedTexts = new Map<DefaultScorerName, string>();

/** The text teamai ships for `name`, read once. */
function shipped(name: DefaultScorerName): string {
  const known = shippedTexts.get(name);

  if (known !== undefined) return known;
  const content = fs.readFileSync(path.join(defaultsDir(), `${name}.md`), 'utf8');
  shippedTexts.set(name, content);

  return content;
}

/** `{ 'doc.id': 'x' }` as the nested value a template's variables read: `{ doc: { id: 'x' } }`. */
function nested(values: Readonly<Record<string, string>>) {
  const tree: Record<string, Record<string, string>> = {};

  for (const [name, value] of Object.entries(values)) {
    const [root = name, ...rest] = name.split('.');
    tree[root] = { ...tree[root], [rest.join('.')]: value };
  }

  return tree;
}

type Split = { frontmatter: Template; body: Template };

/** The frontmatter and the body of `content`, each parsed as a template of the defaults' variables, or why one does not parse. */
function templatesOf(content: string): { ok: true; split: Split } | { ok: false; problems: string[] } {
  const { raw, body } = splitFrontmatter(content);
  const frontmatter = parseTemplate(raw, false, ROOTS);
  const rest = parseTemplate(body, false, ROOTS);

  if (frontmatter.ok && rest.ok) return { ok: true, split: { frontmatter: frontmatter.template, body: rest.template } };

  return { ok: false, problems: [...(frontmatter.ok ? [] : frontmatter.errors), ...(rest.ok ? [] : rest.errors)].map(({ source, message }) => `${source}: ${message}`) };
}

/**
 * `split` with `values` filled in. A value in the frontmatter is escaped as inside a double-quoted YAML string, where
 * a default puts each, so no value can end the string or add a key.
 */
function fill({ frontmatter, body }: Split, values: Readonly<Record<string, string>>): string {
  const context = { steps: {}, variables: nested(values) };
  const escaped = frontmatter.map((part) => (isTemplateRead(part) ? JSON.stringify(renderText([part], context)).slice(1, -1) : part));

  return `${escaped.join('')}${renderText(body, context)}`;
}

/** Values no rubric should break on: a quote, a colon, a hash and a newline, as a document's path or id may hold. */
function probe(name: DefaultScorerName): Record<string, string> {
  return Object.fromEntries(VARIABLES[name].map((variable) => [variable, `a "${variable}": #1\nx`]));
}

/**
 * Why pull refuses `content`, the team's `file` named like default `name`, one coded diagnostic each; none when it may
 * replace the default. It must parse, read only the variables the default offers, and fill in to a scorer whatever
 * they hold.
 */
function problems(name: DefaultScorerName, file: string, content: string): Array<ScorerDiagnostic & { code: DefaultScorerCode }> {
  const offered: readonly string[] = VARIABLES[name];
  const parsed = templatesOf(content);
  const refusal = (code: DefaultScorerCode, message: string) => ({ file, code, message });

  if (!parsed.ok) {
    return parsed.problems.map((message) => refusal('default_scorer_template', `has a template that does not parse: ${message}`));
  }

  const { frontmatter, body } = parsed.split;

  // An expression or a `with` read is no variable at all, so it is refused as one the default does not offer.
  const unknown = [...new Set([...frontmatter, ...body].filter(isTemplateRead).flatMap((read) => {
    const variable = 'variable' in read ? read.variable.join('.') : undefined;

    return variable !== undefined && offered.includes(variable) ? [] : [read.source];
  }))];

  if (unknown.length > 0) {
    const offers = offered.length === 1 ? offered.join('') : `${offered.slice(0, -1).join(', ')} and ${offered.at(-1) ?? ''}`;

    return unknown.map((source) => refusal('default_scorer_variable', `reads ${source}, which teamai's default scorer ${name} does not offer. It offers ${offers}; teamai's default runs until the file reads only those`));
  }

  const filled = parseScorer(file, fill(parsed.split, probe(name)));

  return filled.ok ? [] : filled.diagnostics.map(({ message }) => refusal('default_scorer_invalid', `does not fill in to a scorer when a variable holds a quote, a colon or a newline: ${message}. Put each {{ }} of the frontmatter inside a double-quoted string`));
}

/**
 * `content`, the rubric of default `name` as teamai ships it or a team file pull let replace it, filled in with
 * `values` and parsed under `file`. A rubric that pull checked always fills in, so a failure is a teamai bug.
 */
function fillIn<TName extends DefaultScorerName>(name: TName, { file, content }: { file: string; content: string }, values: DefaultScorerValues<TName>): FilledScorer {
  const parsed = templatesOf(content);
  const text = parsed.ok ? fill(parsed.split, values) : content;
  const scorer = parseScorer(file, text);

  if (!scorer.ok) throw new Error(`the rubric of teamai's default scorer ${name} does not fill in for ${file}: ${scorer.diagnostics.map(({ message }) => message).join('; ')}`);

  return { content: text, definition: scorer.definition };
}

export const DefaultScorers = { NAMES, VARIABLES, isName, shipped, problems, fillIn } as const;
